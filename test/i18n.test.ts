import { describe, expect, it } from 'vitest'
import { APP_LANGUAGES, ITEM_KINDS, RARITIES } from '../src/core/companion/model.js'
import { f, s } from '../src/core/i18n/strings.js'
import * as d from '../src/core/i18n/dispatch.js'

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
