import { describe, expect, it } from 'vitest'
import { APP_LANGUAGES, ITEM_KINDS, RARITIES } from '../src/core/companion/model.js'
import { f, s } from '../src/core/i18n/strings.js'
import * as d from '../src/core/i18n/dispatch.js'
import { MilestoneBalance } from '../src/core/companion/encounters.js'

// The value of this suite is coverage, not spot-checking translations: 191 entries across
// four languages is where a mechanical port silently loses one, and a missing Japanese
// string is invisible until a Japanese user sees it.

const STRING_KEYS = Object.keys(
  // Reaching the table through a known key keeps this honest if the shape changes.
  { ...(s as unknown as object) },
)

describe('flat strings', () => {
  // Enumerate via a representative key set pulled from the module's own type surface.
  const sampleKeys = [
    'home',
    'collection',
    'todayTokens',
    'thisWeek',
    'thisMonth',
    'weekly',
    'fiveHourSession',
    'rarityCommon',
    'rarityUncommon',
    'rarityRare',
    'rarityLegendary',
    'shop',
    'buy',
    'notEnoughTokens',
    'statusGrew',
    'statusIdle',
    'statusWorking',
  ] as const

  it.each(APP_LANGUAGES)('resolves every sampled key in %s', (lang) => {
    for (const key of sampleKeys) {
      const value = s(lang, key)
      expect(value, `${key} in ${lang}`).toBeTruthy()
      expect(value.trim(), `${key} in ${lang} is blank`).not.toBe('')
    }
  })

  it('really differs per language rather than falling back to one', () => {
    expect(s('ko', 'home')).not.toBe(s('en', 'home'))
    expect(s('ja', 'home')).not.toBe(s('es', 'home'))
  })
})

describe('parameterised strings', () => {
  it.each(APP_LANGUAGES)('interpolates in %s', (lang) => {
    expect(f.eggToHatch(lang, '5M')).toContain('5M')
    expect(f.dexTotal(lang, 7)).toContain('7')
    expect(f.notifCandyTitle(lang, 'Rare Candy', 3)).toContain('3')
  })

  it('places the value, not a literal placeholder', () => {
    for (const lang of APP_LANGUAGES) {
      expect(f.eggToHatch(lang, '5M')).not.toContain('${')
      expect(f.eggToHatch(lang, '5M')).not.toContain('\\(')
    }
  })
})

describe('switch-dispatched entries', () => {
  it.each(APP_LANGUAGES)('names every rarity in %s', (lang) => {
    for (const rarity of RARITIES) {
      expect(d.rarityLabel(lang, rarity).trim()).not.toBe('')
    }
  })

  it.each(APP_LANGUAGES)('names and describes every item in %s', (lang) => {
    for (const kind of ITEM_KINDS) {
      expect(d.itemName(lang, kind).trim()).not.toBe('')
      expect(d.itemDescription(lang, kind).trim()).not.toBe('')
    }
  })

  it('derives the candy description from the balance constant', () => {
    // Hard-coding the number here would let the copy drift from the actual XP granted.
    expect(d.itemDescription('en', 'rareCandy')).toContain('100M')
  })

  it.each(APP_LANGUAGES)('names every egg tier in %s', (lang) => {
    for (const tier of [undefined, ...RARITIES]) {
      expect(d.eggName(lang, tier).trim()).not.toBe('')
    }
  })

  // Egg names are written out per language instead of composed from the rarity label. For
  // some tiers composition happens to coincide, which is exactly why a naive port survives
  // a shallow test — these are the tiers where it genuinely diverges.
  it('does not compose egg names from the rarity label', () => {
    // Japanese: the egg uses hiragana でんせつ, the rarity label uses kanji 伝説.
    expect(d.eggName('ja', 'legendary')).toBe('でんせつのタマゴ')
    expect(d.eggName('ja', 'legendary')).not.toBe(`${d.rarityLabel('ja', 'legendary')}のタマゴ`)
    // Spanish: composing would capitalise mid-sentence ("Huevo Poco común").
    expect(d.eggName('es', 'uncommon')).toBe('Huevo poco común')
    expect(d.eggName('es', 'uncommon')).not.toBe(`Huevo ${d.rarityLabel('es', 'uncommon')}`)
  })

  it('describes an unguaranteed egg differently from a guaranteed one', () => {
    expect(d.eggDescription('en', undefined)).not.toBe(d.eggDescription('en', 'rare'))
    expect(d.eggDescription('en', 'common')).toBe(d.eggDescription('en', undefined))
    expect(d.eggDescription('en', 'rare')).toContain(d.rarityLabel('en', 'rare'))
  })

  // [trigger branch] All three shop eggs used to open with the same clause — "Send off your
  // current Pokémon…" — which is the price they share, not what separates them, so each card
  // spent two of its three lines on the sentence next to it. The check is mechanical rather
  // than a keyword hunt, so it holds in a language whose words this suite does not know: if the
  // three lines share a run of opening text, they are repeating each other again.
  it.each(APP_LANGUAGES)('leaves no clause shared by all three eggs in %s', (lang) => {
    const lines = [undefined, 'uncommon', 'rare'].map((tier) => d.eggDescription(lang, tier as never))
    expect(new Set(lines).size).toBe(3)
    let shared = 0
    while (lines.every((l) => l[shared] !== undefined && l[shared] === lines[0]![shared])) shared++
    expect(shared, `shared opening: "${lines[0]!.slice(0, shared)}"`).toBeLessThanOrEqual(3)
    // And the sentence they used to share is said once, on the group heading instead.
    for (const line of lines) expect(d.shopEggsNote(lang)).not.toContain(line)
  })

  it('maps codex windows to their named equivalents', () => {
    expect(d.codexWindow('en', 300)).toBe(s('en', 'fiveHourSession'))
    expect(d.codexWindow('en', 10_080)).toBe(s('en', 'weekly'))
    expect(d.codexWindow('en', 120)).toBe('2h')
    expect(d.codexWindow('en', 90)).toBe('90m')
    expect(d.codexWindow('en', undefined)).toBe('Limit')
  })

  it('names claude limit entries, distinguishing a scoped weekly from the legacy row', () => {
    expect(d.claudeLimitEntry('en', 'session', undefined)).toBe(s('en', 'fiveHourSession'))
    expect(d.claudeLimitEntry('en', 'weekly_all', undefined)).toBe(s('en', 'weekly'))
    expect(d.claudeLimitEntry('en', 'weekly_scoped', undefined)).toBe('Weekly (scoped)')
    expect(d.claudeLimitEntry('en', 'weekly_scoped', 'Opus')).toBe('Weekly Opus')
    // Unknown kinds degrade to a humanised form instead of showing a raw key.
    expect(d.claudeLimitEntry('en', 'some_new_kind', 'X')).toBe('some new kind X')
    expect(d.claudeLimitEntry('en', undefined, undefined)).toBe('limit')
  })

  it('labels every refresh interval, including manual', () => {
    expect(d.intervalLabel('en', 0)).toBe('Manual')
    expect(d.intervalLabel('en', 120)).toBe('2 min')
    expect(d.intervalLabel('ja', 300)).toBe('5分')
  })

  it.each(APP_LANGUAGES)('labels every provider status in %s', (lang) => {
    for (const indicator of [
      'operational',
      'minor',
      'major',
      'critical',
      'maintenance',
      'unknown',
    ] as const) {
      expect(d.providerStatusLabel(lang, indicator).trim()).not.toBe('')
    }
  })
})

describe('celebration toasts', () => {
  it.each(APP_LANGUAGES)('says every peak moment in %s and carries the name into it', (lang) => {
    expect(d.celebrationText(lang, { kind: 'hatched', name: 'Pidove', isShiny: false })).toContain(
      'Pidove',
    )
    expect(d.celebrationText(lang, { kind: 'evolved', name: 'Tranquill' })).toContain('Tranquill')
    expect(d.celebrationText(lang, { kind: 'graduated', name: 'Unfezant' })).toContain('Unfezant')
    expect(
      d.celebrationText(lang, { kind: 'dittoRevealed', disguisedAs: 'Pidove', isShiny: false }),
    ).toContain('Pidove')
    const candy = d.celebrationText(lang, { kind: 'candyGranted', count: 2, windowName: '5h' })
    expect(candy).toContain('2')
    expect(candy).toContain('5h')
    expect(d.openPanelLabel(lang)).not.toBe('')
  })

  // The two reward toasts are the only copy that has to hold true *before* the species is
  // known: the legendary is owed the moment it is earned, and only rolled when there is room
  // and an index to roll from. Each also has to carry its own reason — a bare "a legendary is
  // coming" would leave the player with no idea what they did to earn it.
  it.each(APP_LANGUAGES)('says why a legendary was earned in %s', (lang) => {
    const streak = d.celebrationText(lang, { kind: 'legendaryEarned', via: 'streak', days: 3 })
    expect(streak).toContain('3')
    expect(streak.trim()).not.toBe('')

    const milestone = d.celebrationText(lang, {
      kind: 'legendaryEarned',
      via: 'milestone',
      tokens: MilestoneBalance.tokens,
    })
    // Formatted by the core, never by the view: the copy shows the amount that was reached.
    expect(milestone).toContain('1B')
    expect(streak).not.toBe(milestone)
  })

  // Both triggers can fire in one fold, and that must be one notification. The combined line
  // still has to carry both numbers — they are the entire information content — and it must be
  // written rather than composed: neither single sentence may simply appear inside it.
  it.each(APP_LANGUAGES)('merges both triggers into one written line in %s', (lang) => {
    const both = d.celebrationText(lang, {
      kind: 'legendaryEarned',
      via: 'both',
      days: 4,
      tokens: MilestoneBalance.tokens * 2,
    })
    expect(both).toContain('4')
    expect(both).toContain('2B')

    const streak = d.celebrationText(lang, { kind: 'legendaryEarned', via: 'streak', days: 4 })
    const milestone = d.celebrationText(lang, {
      kind: 'legendaryEarned',
      via: 'milestone',
      tokens: MilestoneBalance.tokens * 2,
    })
    expect(both).not.toBe(`${streak} ${milestone}`)
    expect(both).not.toContain(streak)
    expect(both).not.toContain(milestone)
  })

  // Two are owed when both fire, and the one line that announces them says so.
  it('says two legendaries are coming when both triggers fired', () => {
    const both = d.celebrationText('en', {
      kind: 'legendaryEarned',
      via: 'both',
      days: 4,
      tokens: MilestoneBalance.tokens,
    })
    expect(both).toContain('two legendaries')
  })

  // "On its way", not "has appeared" — the wild Pokémon announces itself separately, by name.
  it('does not promise that the legendary is already there', () => {
    for (const event of [
      { kind: 'legendaryEarned', via: 'streak', days: 3 },
      { kind: 'legendaryEarned', via: 'milestone', tokens: MilestoneBalance.tokens },
      { kind: 'legendaryEarned', via: 'both', days: 3, tokens: MilestoneBalance.tokens },
    ] as const) {
      expect(d.celebrationText('en', event)).not.toContain('appeared')
    }
  })

  it('marks a shiny hatch and keeps the event kinds distinguishable', () => {
    expect(d.celebrationText('en', { kind: 'hatched', name: 'Pidove', isShiny: true })).toContain('✨')
    const kinds = [
      d.celebrationText('en', { kind: 'hatched', name: 'X', isShiny: false }),
      d.celebrationText('en', { kind: 'evolved', name: 'X' }),
      d.celebrationText('en', { kind: 'graduated', name: 'X' }),
    ]
    expect(new Set(kinds).size).toBe(kinds.length)
  })
})

describe('shop and first-run strings', () => {
  it.each(APP_LANGUAGES)('covers the shop chrome in %s', (lang) => {
    for (const text of [
      d.shopGroupBalls(lang),
      d.shopGroupItems(lang),
      d.shopGroupEggs(lang),
      d.shopEggsNote(lang),
      d.getBallsCta(lang),
      d.buyActionLabel(lang, 'Poké Ball', '5M'),
      d.ownedActionLabel(lang, 'Shiny Charm'),
    ]) {
      expect(text.trim()).not.toBe('')
    }
    // Derived numbers, like the candy's XP copy: the discount spoken must be the one charged.
    const bundle = d.bundleBuyLabel(lang, 'Poké Ball ×10', '45M', 10)
    expect(bundle).toContain('10')
    expect(bundle).toContain('45M')
    // The button says "×10"; its name has to say what that buys and what it saves, since a
    // screen reader is given the name and never the row around it.
    expect(bundle).not.toBe(d.buyActionLabel(lang, 'Poké Ball ×10', '45M'))
  })

  // [trigger branch] The badge on the bundle is the only place the 10% survives now that the
  // ×10 has no card of its own, so it is derived from the constants the price is divided by.
  it('formats the bundle saving from the discount it is handed', () => {
    expect(d.bundleSaveText(10)).toBe('−10%')
    expect(d.bundleSaveText(25)).toBe('−25%')
    // A true minus sign, not a hyphen: it sits at digit height beside a price.
    expect(d.bundleSaveText(10)).not.toContain('-')
  })

  // [trigger branch] "Catches 1.5x better than a Poké Ball" is a sentence whose whole content is
  // its number, sitting under a POKÉ BALLS heading beside a Great Ball sprite. As a stat it
  // compares at a glance — and both forms now read the multiplier the dice actually roll.
  it.each(APP_LANGUAGES)('states a ball as a stat drawn from the balance table in %s', (lang) => {
    expect(d.ballCatchStat(lang, 'pokeBall')).toBe('1×')
    expect(d.ballCatchStat(lang, 'ultraBall')).toBe('2×')
    // An unconditional catch is not a multiplier, so the Master Ball has no figure at all.
    expect(d.ballCatchStat(lang, 'masterBall')).toBeUndefined()
    expect(d.ballCatchLabel(lang, 'masterBall')).toBeUndefined()
    for (const kind of ['pokeBall', 'greatBall', 'ultraBall'] as const) {
      expect(d.ballCatchLabel(lang, kind)?.trim()).toBeTruthy()
    }
    // The sentence in the bag and the badge in the shop quote the same figure.
    expect(d.itemDescription(lang, 'greatBall')).toContain(
      d.ballCatchStat(lang, 'greatBall')!.replace('×', ''),
    )
  })

  it('writes the decimal mark the language uses', () => {
    expect(d.ballCatchStat('en', 'greatBall')).toBe('1.5×')
    expect(d.ballCatchStat('es', 'greatBall')).toBe('1,5×')
    expect(d.itemDescription('es', 'greatBall')).toContain('1,5')
    expect(d.itemDescription('es', 'greatBall')).not.toContain('1.5')
  })

  it.each(APP_LANGUAGES)('asks before letting a marked encounter go, naming it, in %s', (lang) => {
    expect(d.runAwayConfirm(lang, 'Dratini')).toContain('Dratini')
    expect(d.refreshIntervalLabel(lang).trim()).not.toBe('')
  })

  it.each(APP_LANGUAGES)('explains an empty first run in %s', (lang) => {
    // The provider list is the actionable part — a user reads it to know which CLI to run.
    expect(d.noUsageText(lang)).toContain('Claude Code')
    expect(d.noUsageText(lang)).toContain('Codex')
    expect(d.welcomeToast(lang).trim()).not.toBe('')
  })
})

describe('wild encounter strings', () => {
  it.each(APP_LANGUAGES)('covers the whole encounter flow in %s', (lang) => {
    expect(
      d.celebrationText(lang, { kind: 'wildAppeared', name: 'Pidove', rarity: 'rare', isShiny: false }),
    ).toContain('Pidove')
    expect(d.celebrationText(lang, { kind: 'wildCaught', name: 'Pidove', isShiny: false })).toContain(
      'Pidove',
    )
    expect(d.fledText(lang, 'Pidove')).toContain('Pidove')
    // The near-miss line differs from the plain break — that difference is the drama.
    expect(d.brokeFreeText(lang, 3)).not.toBe(d.brokeFreeText(lang, 0))
    for (const text of [
      d.runAwayLabel(lang),
      d.trainerLabel(lang),
      d.wildCaughtBadge(lang),
      d.wildNoBallsText(lang),
      d.brokeFreeText(lang, 0),
    ]) {
      expect(text.trim()).not.toBe('')
    }
    const next = d.wildNextEncounterText(lang, '1.2M')
    expect(next).toContain('1.2M')
    const tooltip = d.wildBadgeTooltip(lang, 3)
    expect(tooltip).toContain('3')
  })
})

// [trigger branch] The status bar tooltip hard-coded the English word `tokens` in all four
// languages, because every existing key is a whole phrase (`todayTokens`, `spendableTokens`)
// and none of them is the bare noun. A Japanese user read `今日 · 253,400,000 tokens`.
describe('tokensNoun', () => {
  it('is translated in every language, not only labelled as such', () => {
    expect(d.tokensNoun('ko')).toBe('토큰')
    expect(d.tokensNoun('ja')).toBe('トークン')
    expect(d.tokensNoun('en')).toBe('tokens')
    expect(d.tokensNoun('es')).toBe('tokens')
  })
})

// [trigger branch] This line labels a progress bar that already carries its own percentage, so
// it holds only what the bar cannot say. It used to open by announcing the empty state as well,
// which the empty scene above it was already showing — and that sentence wrapped to two lines
// at sidebar width.
describe('wildNextEncounterText', () => {
  it('says the remaining amount and nothing the surrounding UI already says', () => {
    for (const lang of APP_LANGUAGES) {
      const text = d.wildNextEncounterText(lang, '1.2M')
      expect(text).toContain('1.2M')
      // Comfortably inside a sidebar row that also holds a percentage.
      expect(text.length).toBeLessThanOrEqual(30)
    }
  })

  // Same shape as the companion's own "to next evolution", so the two rows read as one system.
  it('is phrased like its sibling on the companion bar', () => {
    expect(d.wildNextEncounterText('en', '1.2M')).toBe('1.2M to the next encounter')
    expect(d.wildNextEncounterText('es', '1.2M')).toBe('1.2M al siguiente encuentro')
  })
})

/**
 * The one string a *failure* depends on. An action that could not take the save's
 * cross-window lock is reported to the user through this and nothing else, so a language that
 * silently fell back to another's copy — or to nothing — would leave the user staring at a
 * purchase that quietly did not happen.
 */
describe('a save the lock refused', () => {
  it.each(APP_LANGUAGES)('says nothing was changed, in %s', (lang) => {
    expect(d.saveBusyText(lang).trim()).not.toBe('')
  })

  it('is written per language rather than falling back to one', () => {
    const said = APP_LANGUAGES.map((lang) => d.saveBusyText(lang))
    expect(new Set(said).size).toBe(APP_LANGUAGES.length)
  })
})
