import { describe, expect, it } from 'vitest'
import { REFRESH_PRESETS, buildPanelState } from '../src/core/panel/build.js'
import { buildSnapshot, type CompanionView } from '../src/core/snapshot.js'
import {
  Pokeball,
  freshCompanionState,
  shopEntryPrice,
  type CompanionState,
  type MonState,
  type WildEncounter,
} from '../src/core/companion/model.js'
import { DEFAULT_TRAINER_ID } from '../src/core/companion/trainers.js'
import { StreakBalance } from '../src/core/companion/encounters.js'
import { todayKey } from '../src/core/usage/entry.js'

// The panel builder was the single largest piece of UI-shaping code outside the suite until it
// moved into the core — and that blind spot shipped a real bug (a celebration flag frozen into
// a reused snapshot). These tests are the reason the move happened.

const NOW = Date.parse('2026-08-28T12:00:00Z')

const usage = (companion?: CompanionView) =>
  buildSnapshot([], {
    now: NOW,
    locale: 'en-US',
    lang: 'en',
    ...(companion === undefined ? {} : { companion }),
  })

const view = (over: Partial<CompanionView> = {}): CompanionView => ({
  state: 'working',
  name: 'Pikachu',
  speciesID: 25,
  isShiny: false,
  progress: 0.5,
  toNextText: '1M to next',
  dexCount: 1,
  spendableTokens: 100,
  wildCount: 0,
  wildTooltip: '',
  ...over,
})

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

/** Any Pokémon on stage: the eggs are only offered while there is one to discard. */
const activeMon: MonState = {
  baseID: 25,
  pathIDs: [25],
  plannedPathIDs: [25, 26],
  stageIndex: 0,
  usedAtStage: 0,
  rarity: 'common',
  totalForms: 2,
  isShiny: false,
  dittoRevealed: false,
}

const wild = (over: Partial<WildEncounter> = {}): WildEncounter => ({
  id: 'w1',
  speciesID: 147,
  captureRate: 45,
  rarity: 'rare',
  isShiny: false,
  appearedAt: NOW - 60_000,
  throws: 0,
  names: { en: 'Dratini' },
  ...over,
})

const build = (over: Partial<Parameters<typeof buildPanelState>[0]> = {}) =>
  buildPanelState({
    usage: usage(),
    state: state(),
    line: undefined,
    isCelebrating: false,
    now: NOW,
    locale: 'en-US',
    ...over,
  })

describe('celebration flag', () => {
  // [trigger branch] The bug that motivated the extraction: `usage` can be a reused snapshot
  // whose display state froze at `levelUp`. The flag must come from the injected live reading
  // and nowhere else.
  it('comes only from the live input, never from the snapshot', () => {
    const stale = build({ usage: usage(view({ state: 'levelUp' })), isCelebrating: false })
    expect(stale.companion?.celebrating).toBeUndefined()

    const live = build({ usage: usage(view()), isCelebrating: true })
    expect(live.companion?.celebrating).toBe(true)
  })
})

describe('the ball rack', () => {
  it('prices every ball against the encounter on stage, Master at 100%', () => {
    const panel = build({ state: state({ wild: [wild()] }) })
    for (const ball of panel.wild.balls) expect(ball.oddsText).toBeDefined()
    expect(panel.wild.balls.find((b) => b.kind === 'masterBall')?.oddsText).toBe('100%')
    // The difficulty cap: not even a full-rate species reads as certain on a Poké Ball.
    const easy = build({ state: state({ wild: [wild({ captureRate: 255 })] }) })
    expect(easy.wild.balls.find((b) => b.kind === 'pokeBall')?.oddsText).not.toBe('100%')
  })

  it('shows no odds with an empty stage', () => {
    const panel = build()
    for (const ball of panel.wild.balls) expect(ball.oddsText).toBeUndefined()
  })

  it('counts the starter balls a fresh save carries', () => {
    const panel = build()
    expect(panel.wild.balls.find((b) => b.kind === 'pokeBall')?.count).toBe(Pokeball.starterCount)
  })
})

describe('wild rows', () => {
  it('dates an old encounter instead of showing a bare time that reads as today', () => {
    const today = build({ state: state({ wild: [wild()] }) })
    expect(today.wild.encounters[0]!.appearedText).toContain(':')

    const yesterday = build({
      state: state({ wild: [wild({ appearedAt: NOW - 86_400_000 })] }),
    })
    expect(yesterday.wild.encounters[0]!.appearedText).not.toContain(':')
  })

  it('asks before running only from what hurts to lose', () => {
    const panel = build({
      state: state({
        wild: [
          wild({ id: 'r', rarity: 'rare' }),
          wild({ id: 'c', rarity: 'common', names: { en: 'Caterpie' } }),
          wild({ id: 's', rarity: 'common', isShiny: true }),
        ],
      }),
    })
    const byID = new Map(panel.wild.encounters.map((e) => [e.id, e]))
    expect(byID.get('r')?.runConfirmText).toContain('Dratini')
    expect(byID.get('c')?.runConfirmText).toBeUndefined()
    expect(byID.get('s')?.runConfirmText).toBeDefined()
  })

  it('falls back to the dex number when no name is stored', () => {
    const panel = build({ state: state({ wild: [wild({ names: undefined })] }) })
    expect(panel.wild.encounters[0]!.name).toBe('#147')
  })
})

describe('the shop', () => {
  const rowFor = (id: string, over: Partial<Parameters<typeof buildPanelState>[0]> = {}) =>
    build(over).shop.find((item) => item.id === id)

  it('offers ten-packs for every ball except the Master, with the ids the host accepts', () => {
    // `parseEntryID` takes `item:<kind>` and `item:<kind>:<bundleSize>` and rejects everything
    // else, so grouping the two prices onto one row must not have moved either id.
    const ids = build().shop.flatMap((item) => item.actions.map((a) => a.id))
    expect(ids).toContain(`item:pokeBall:${Pokeball.bundleSize}`)
    expect(ids).toContain(`item:ultraBall:${Pokeball.bundleSize}`)
    expect(ids).not.toContain(`item:masterBall:${Pokeball.bundleSize}`)
    expect(ids).toContain('item:masterBall')
  })

  // [trigger branch] A ball and its ten-pack were two cards, and the ten-pack's card had nothing
  // of its own to say: its description was the same generated sentence on all three of them.
  it('sells each ball from one row carrying both quantities', () => {
    const balls = build().shop.filter((item) => item.group === 'balls')
    expect(balls).toHaveLength(4)
    const poke = balls.find((item) => item.id === 'item:pokeBall')!
    expect(poke.actions.map((a) => a.id)).toEqual([
      'item:pokeBall',
      `item:pokeBall:${Pokeball.bundleSize}`,
    ])
    // The Master Ball is sold singly on purpose, so its row stays a one-price row.
    expect(rowFor('item:masterBall')!.actions).toHaveLength(1)
  })

  // Grouping is only an improvement while the ten-pack is still visibly the cheaper ball: fold
  // the two prices together and drop the saving, and the reader has to divide to find it.
  it('marks the bundle saving, derived from what the till actually charges', () => {
    const [single, bundle] = rowFor('item:pokeBall')!.actions
    const discount = Math.round(100 * (1 - Pokeball.bundleMultiplier / Pokeball.bundleSize))
    expect(bundle!.saveText).toBe(`−${discount}%`)
    expect(bundle!.label).toContain(String(discount))
    // Not a literal: the badge has to follow the constants the price is computed from.
    expect(shopEntryPrice({ kind: 'item', item: 'pokeBall', quantity: Pokeball.bundleSize })).toBe(
      Math.round((5_000_000 * Pokeball.bundleSize * Pokeball.bundleMultiplier) / Pokeball.bundleSize),
    )
    expect(single!.saveText).toBeUndefined()
  })

  // Two buttons on one row are announced by their own names, never by the card around them.
  it('gives every action on a row a distinguishable accessible name', () => {
    for (const item of build({ state: state({ active: activeMon }) }).shop) {
      const labels = item.actions.map((a) => a.label)
      expect(new Set(labels).size).toBe(labels.length)
      for (const action of item.actions) {
        expect(action.label).toContain(action.priceText)
        expect(action.label.trim()).not.toBe('')
        // The confirmation the host raises names the quantity being bought, not the row.
        expect(action.confirmTitle.trim()).not.toBe('')
      }
    }
    const [single, bundle] = rowFor('item:greatBall')!.actions
    expect(bundle!.confirmTitle).toContain(`×${Pokeball.bundleSize}`)
    expect(single!.confirmTitle).not.toContain('×')
  })

  // [trigger branch] "The standard ball for throwing at a wild Pokémon", under a POKÉ BALLS
  // heading, beside a Poké Ball sprite, in a shop. The catch multiplier is the only thing a ball
  // row can say that changes a decision, and it is a figure.
  it('states a ball as a stat and keeps prose only where it is not a number', () => {
    expect(rowFor('item:pokeBall')!.stat).toBe('1×')
    expect(rowFor('item:greatBall')!.stat).toBe('1.5×')
    expect(rowFor('item:ultraBall')!.stat).toBe('2×')
    for (const id of ['item:pokeBall', 'item:greatBall', 'item:ultraBall']) {
      expect(rowFor(id)!.description).toBeUndefined()
      // A bare "1.5×" says a number, not a fact, to a screen reader.
      expect(rowFor(id)!.statLabel?.trim()).toBeTruthy()
    }
    // The Master Ball's behaviour is not a multiplier, so it keeps the sentence — and it is the
    // only ball sentence that gives advice.
    expect(rowFor('item:masterBall')!.stat).toBeUndefined()
    expect(rowFor('item:masterBall')!.description).toContain('legendary')
    // Items were never the problem: their descriptions are the whole reason to buy them.
    expect(rowFor('item:rareCandy')!.description).toContain('100M')
    expect(rowFor('item:mint')!.description?.trim()).toBeTruthy()
  })

  // [trigger branch] All three eggs opened with "Send off your current Pokémon…" — the price
  // they share, said three times, while the guarantee that separates them trailed at the end.
  it('leaves each egg only its guarantee, with the shared cost on the heading', () => {
    const panel = build({ state: state({ active: activeMon }) })
    const eggs = panel.shop.filter((item) => item.group === 'eggs')
    expect(eggs).toHaveLength(3)
    const lines = eggs.map((e) => e.description!)
    expect(new Set(lines).size).toBe(3)
    // The shared clause lives once, on the group note.
    expect(panel.strings.shopEggsNote).toContain('sends off your current Pokémon')
    for (const line of lines) {
      expect(panel.strings.shopEggsNote).not.toContain(line)
      // Short enough to sit on the one line a card now gets.
      expect(line.length).toBeLessThanOrEqual(24)
    }
    expect(lines.some((l) => l.includes('Uncommon or better'))).toBe(true)
  })

  it('sells eggs only while there is a Pokémon to discard', () => {
    expect(build().shop.some((item) => item.group === 'eggs')).toBe(false)
  })

  it('assigns every row to a rendered group and prices every action', () => {
    for (const item of build().shop) {
      expect(['balls', 'items', 'eggs']).toContain(item.group)
      expect(item.actions.length).toBeGreaterThan(0)
      for (const action of item.actions) expect(action.priceText).not.toBe('')
    }
  })

  it('says a passive is owned on the action itself, not only by greying it', () => {
    const owned = build({ state: state({ inventory: { shinyCharm: 1 } }) })
    const charm = owned.shop.find((item) => item.id === 'item:shinyCharm')!
    expect(charm.owned).toBe(true)
    expect(charm.actions[0]!.enabled).toBe(false)
    expect(charm.actions[0]!.text).toBe(owned.strings.owned)
    expect(charm.actions[0]!.label).toContain(charm.title)
  })
})

describe('settings and chrome', () => {
  it('builds the refresh picker only when the host said what the setting is', () => {
    expect(build().refresh).toBeUndefined()

    const panel = build({ refreshSeconds: 120 })
    expect(panel.refresh?.seconds).toBe(120)
    expect(panel.refresh?.options.map((o) => o.seconds)).toEqual([...REFRESH_PRESETS])
    for (const option of panel.refresh?.options ?? []) expect(option.label).not.toBe('')
  })

  it('falls back to the default trainer for an absent or retired slug', () => {
    expect(build().trainerID).toBe(DEFAULT_TRAINER_ID)
    expect(build({ state: state({ trainerID: 'lyra' }) }).trainerID).toBe('lyra')
  })

  it('marks wild catches in the log', () => {
    const panel = build({
      state: state({
        dex: [
          {
            id: 'wild-1',
            baseID: 147,
            finalID: 147,
            chainOrder: [147],
            rarity: 'rare',
            caughtAt: NOW,
            isShiny: false,
            source: 'wild',
          },
        ],
      }),
    })
    expect(panel.dexLog[0]?.isWild).toBe(true)
  })

  it('attaches the dev tab only when one is handed in', () => {
    expect(build().dev).toBeUndefined()
    const panel = build({ dev: { summary: [], groups: [] } })
    expect(panel.dev).toEqual({ summary: [], groups: [] })
  })
})

// The catch log is ordered by time because it is a record, so rarity stopped being its sort
// key — and the narrowing that was supposed to replace it was never built: `dexCount` sat
// unused in dexView.ts behind a comment claiming the filter existed. These chips are it.
describe('catch-log rarity chips', () => {
  const caught = (id: number, rarity: 'common' | 'rare' | 'legendary') => ({
    id: `e${id}`,
    baseID: id,
    finalID: id,
    chainOrder: [id],
    rarity,
    caughtAt: NOW - id * 1000,
    isShiny: false,
  })

  it('counts each tier the log actually holds, newest chip order aside', () => {
    const panel = build({
      state: state({ dex: [caught(1, 'common'), caught(2, 'common'), caught(3, 'legendary')] }),
    })
    expect(panel.dexLogFilters.map((f) => [f.id, f.count])).toEqual([
      ['all', 3],
      ['common', 2],
      ['legendary', 1],
    ])
  })

  // A chip that filters to nothing is a control that does nothing.
  it('leaves out a tier with no entries', () => {
    const panel = build({ state: state({ dex: [caught(1, 'common')] }) })
    expect(panel.dexLogFilters.map((f) => f.id)).toEqual(['all', 'common'])
  })

  it('offers only the all chip for an empty log', () => {
    expect(build().dexLogFilters).toEqual([{ id: 'all', label: 'All', count: 0 }])
  })

  // The webview narrows on this token; `rarityText` is the localised label and must never be
  // what a filter compares against.
  it('gives every log row a rarity token beside its label', () => {
    const panel = build({ state: state({ dex: [caught(1, 'legendary')] }) })
    expect(panel.dexLog[0]).toMatchObject({ rarity: 'legendary', rarityText: 'Legendary' })
  })

  // The active Pokémon is synthesised into the log, so it has to be counted like the rest.
  it('counts the Pokémon being raised', () => {
    const raising = state({
      active: {
        baseID: 25,
        pathIDs: [25],
        plannedPathIDs: [25],
        stageIndex: 0,
        usedAtStage: 0,
        rarity: 'uncommon',
        totalForms: 1,
        isShiny: false,
        dittoRevealed: false,
      },
    })
    const panel = build({ state: raising })
    expect(panel.dexLogFilters).toContainEqual({ id: 'uncommon', label: 'Uncommon', count: 1 })
  })
})

// The streak row: seven dots and one short line, beside the "to the next encounter" bar. The
// webview draws what is here and nothing else — every day count, date comparison and sentence
// is decided in the core, so all four states have to be reachable from this side.
describe('the streak row', () => {
  /** `n` days before the panel's own clock, as the local day key the ledger speaks. */
  const daysAgo = (n: number) => todayKey(NOW - n * 86_400_000)
  const streak = (over: Partial<CompanionState>) => build({ state: state(over) }).wild.streak

  it('draws one dot per day of the window, all empty on a fresh install', () => {
    const row = streak({})
    expect(row.days).toHaveLength(StreakBalance.windowDays)
    expect(new Set(row.days)).toEqual(new Set(['off']))
    expect(row.text).toBe('0 of 3 days')
    expect(row.value).toBe(0)
    expect(row.max).toBe(StreakBalance.days)
    expect(row.earned).toBe(false)
  })

  // Oldest first, ending today: the row reads left to right like a week, so today is the last
  // dot and a day that has fallen out of the window is simply not drawn.
  it('fills the days that accrued, in calendar order, ending today', () => {
    const row = streak({ accrualDays: [daysAgo(3), daysAgo(0)] })
    expect(row.days).toEqual(['off', 'off', 'off', 'on', 'off', 'off', 'on'])
    expect(row.text).toBe('2 of 3 days')
    expect(row.value).toBe(2)
    expect(row.earned).toBe(false)
  })

  it('does not draw or count a day that has left the window', () => {
    const row = streak({ accrualDays: [daysAgo(StreakBalance.windowDays), daysAgo(0)] })
    expect(row.days.filter((d) => d !== 'off')).toHaveLength(1)
    expect(row.text).toBe('1 of 3 days')
  })

  // The payout is marked on the day it actually happened, not on "the third filled dot" —
  // those coincide the day it fires and diverge every day after.
  it('marks the day the legendary was earned and stops counting', () => {
    const row = streak({
      accrualDays: [daysAgo(2), daysAgo(1), daysAgo(0)],
      lastStreakAwardDate: daysAgo(0),
    })
    expect(row.days).toEqual(['off', 'off', 'off', 'off', 'on', 'on', 'award'])
    expect(row.text).toBe('Legendary earned')
    expect(row.earned).toBe(true)
  })

  // Work carries on after the week has paid out. The row greys rather than resetting, and the
  // count must not read "5 of 3".
  it('keeps the earned state while the window runs on, clamping the value', () => {
    const row = streak({
      accrualDays: [daysAgo(4), daysAgo(3), daysAgo(2), daysAgo(1), daysAgo(0)],
      lastStreakAwardDate: daysAgo(2),
    })
    expect(row.days).toEqual(['off', 'off', 'on', 'on', 'award', 'on', 'on'])
    expect(row.earned).toBe(true)
    expect(row.value).toBe(StreakBalance.days)
    expect(row.value).toBeLessThanOrEqual(row.max)
  })

  it('clears once the award has left the window', () => {
    const row = streak({
      accrualDays: [daysAgo(0)],
      lastStreakAwardDate: daysAgo(StreakBalance.windowDays),
    })
    expect(row.earned).toBe(false)
    expect(row.text).toBe('1 of 3 days')
  })

  it('has an accessible name and follows the panel language', () => {
    expect(streak({}).label).toBe("This week's streak")
    expect(build({ state: state({ language: 'es' }) }).wild.streak.text).toBe('0 de 3 días')
  })
})
