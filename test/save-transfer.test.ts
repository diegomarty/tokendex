import { describe, expect, it } from 'vitest'
import {
  MAX_SAVE_BYTES,
  MAX_TOKEN_VALUE,
  SAVE_FORMAT_ID,
  SaveTransferFailure,
  backupFileName,
  decodeSave,
  encodeSave,
  mergedGrantTier,
  rebasedForThisDevice,
  sanitized,
  suggestedFileName,
  summarize,
} from '../src/core/companion/saveTransfer.js'
import { freshCompanionState, type CompanionState, type MonState } from '../src/core/companion/model.js'
import { EncounterBalance } from '../src/core/companion/encounters.js'

// Losing a save is the worst failure this app has, so these are the guards that matter most.

const mon = (over: Partial<MonState> = {}): MonState => ({
  baseID: 1,
  pathIDs: [1, 2],
  plannedPathIDs: [1, 2],
  stageIndex: 1,
  usedAtStage: 10,
  rarity: 'common',
  totalForms: 2,
  isShiny: false,
  dittoRevealed: false,
  ...over,
})

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

describe('envelope', () => {
  it('round-trips a state', () => {
    const original = state({ usedSinceInstall: 1234, language: 'ja' })
    const decoded = decodeSave(encodeSave(original, '1.0.0', 'Mac', 1_700_000_000_000))
    expect(decoded.state.usedSinceInstall).toBe(1234)
    expect(decoded.format).toBe(SAVE_FORMAT_ID)
    expect(decoded.appVersion).toBe('1.0.0')
  })

  // Without the envelope, ANY json decodes "successfully" with everything defaulted, which
  // presents to the user as "the app deleted my progress".
  it('rejects foreign json instead of importing an empty state', () => {
    expect(() => decodeSave('{"some":"other app"}')).toThrow(SaveTransferFailure)
    expect(() => decodeSave('not json')).toThrow(SaveTransferFailure)
    try {
      decodeSave('{}')
    } catch (e) {
      expect((e as SaveTransferFailure).detail.kind).toBe('notASaveFile')
    }
  })

  // Reported precisely so the user learns that updating is the fix, rather than seeing
  // "not a save file".
  it('reports a newer schema distinctly', () => {
    const raw = JSON.stringify({ format: SAVE_FORMAT_ID, schema: 99, state: {} })
    try {
      decodeSave(raw)
      expect.unreachable()
    } catch (e) {
      const detail = (e as SaveTransferFailure).detail
      expect(detail.kind).toBe('newerSchema')
      expect(detail).toMatchObject({ found: 99, supported: 1 })
    }
  })

  it('refuses a file too large to parse quickly', () => {
    const huge = JSON.stringify({
      format: SAVE_FORMAT_ID,
      schema: 1,
      pad: 'x'.repeat(MAX_SAVE_BYTES),
    })
    try {
      decodeSave(huge)
      expect.unreachable()
    } catch (e) {
      expect((e as SaveTransferFailure).detail.kind).toBe('fileTooLarge')
    }
  })
})

describe('file names', () => {
  it('dates the export so repeats do not overwrite', () => {
    expect(suggestedFileName(new Date(2026, 7, 19, 14, 30).getTime())).toBe(
      'Tokendex-Save-2026-08-19.json',
    )
  })

  // A single backup slot means the second import destroys the original — exactly the thing
  // the user wants to return to.
  it('gives every backup its own slot, down to the second', () => {
    const a = backupFileName(new Date(2026, 7, 19, 14, 30, 1).getTime())
    const b = backupFileName(new Date(2026, 7, 19, 14, 30, 2).getTime())
    expect(a).not.toBe(b)
  })
})

describe('sanitized', () => {
  it('clamps absurd token values that would otherwise break arithmetic', () => {
    const s = sanitized(state({ usedSinceInstall: 1e30, spentTokens: -5, eggUsage: 1e30 }))
    expect(s.usedSinceInstall).toBe(MAX_TOKEN_VALUE)
    expect(s.spentTokens).toBe(0)
    expect(s.eggUsage).toBe(MAX_TOKEN_VALUE)
  })

  // An egg guarantee belongs to the egg being incubated. Left alongside an active Pokémon it
  // leaks onto the next egg and becomes permanently premium.
  it('drops an egg guarantee that coexists with an active Pokémon', () => {
    const s = sanitized(state({ active: mon(), eggTier: 'rare', pendingHatchID: 25 }))
    expect(s.eggTier).toBeUndefined()
    // The pre-roll goes too, or the free post-graduation egg hatches a premium result.
    expect(s.pendingHatchID).toBeUndefined()
  })

  // Legendary cannot be expressed via capture_rate, so both roll paths find nothing, the
  // guarantee is never consumed, and buying another egg is gated — the app is stuck.
  it('drops an unsatisfiable guarantee', () => {
    expect(sanitized(state({ eggTier: 'legendary' })).eggTier).toBeUndefined()
    expect(sanitized(state({ eggTier: 'rare' })).eggTier).toBe('rare')
  })

  it('bounds totalForms, which appears squared in the threshold formula', () => {
    const s = sanitized(state({ active: mon({ totalForms: 1_000_000 }) }))
    expect(s.active?.totalForms).toBe(12)
    expect(sanitized(state({ active: mon({ totalForms: 0 }) })).active?.totalForms).toBe(1)
  })

  it('clamps stageIndex into the realised path', () => {
    const s = sanitized(state({ active: mon({ pathIDs: [1, 2], stageIndex: 99 }) }))
    expect(s.active?.stageIndex).toBe(1)
  })

  // Trimming these would be data loss, which is worse than the arithmetic risk they do not pose.
  it('never trims the dex or the inventory', () => {
    const s = sanitized(
      state({
        dex: [{ id: 'a', baseID: 1, finalID: 3, chainOrder: [1, 2, 3], rarity: 'rare', isShiny: false }],
        inventory: { rareCandy: 99 },
      }),
    )
    expect(s.dex).toHaveLength(1)
    expect(s.inventory).toEqual({ rareCandy: 99 })
  })

  // The wild queue *is* trimmed, unlike the dex: an encounter is a pending offer, not something
  // earned, and a hand-edited save could otherwise ask the panel to draw ten thousand rows.
  it('trims the wild queue to the queue cap', () => {
    const wild = Array.from({ length: 10_000 }, (_, i) => ({
      id: `w${i}`,
      speciesID: 1,
      captureRate: 45,
      rarity: 'common' as const,
      isShiny: false,
      appearedAt: i,
      throws: 0,
    }))
    expect(sanitized(state({ wild })).wild).toHaveLength(EncounterBalance.maxQueue)
  })

  // [trigger branch] `throws` and `captureRate` feed the flee and catch formulas directly. An
  // imported `throws: 1e9` makes every encounter flee on the first miss; a `captureRate: 1e9`
  // makes every legendary a guaranteed catch. Decoding succeeds, so nothing else catches it.
  it('clamps the fields a wild encounter feeds into the formulas', () => {
    const s = sanitized(
      state({
        wild: [
          {
            id: 'w',
            speciesID: 1,
            captureRate: 1_000_000_000,
            rarity: 'legendary',
            isShiny: false,
            appearedAt: 0,
            throws: 1_000_000_000,
          },
        ],
      }),
    )
    expect(s.wild[0]!.captureRate).toBe(255)
    expect(s.wild[0]!.throws).toBe(99)
  })

  it('clamps the encounter accumulator like the other token fields', () => {
    const s = sanitized(state({ encounterUsage: MAX_TOKEN_VALUE * 10, encountersSeen: -5 }))
    expect(s.encounterUsage).toBe(MAX_TOKEN_VALUE)
    expect(s.encountersSeen).toBe(0)
  })

  // A slug that is no longer in the roster would draw a 404 on every repaint; absent means
  // "the default", which is invisible and correct.
  it('drops a trainer slug outside the roster and keeps a valid one', () => {
    expect(sanitized(state({ trainerID: 'not-a-trainer' })).trainerID).toBeUndefined()
    expect(sanitized(state({ trainerID: 'lyra' })).trainerID).toBe('lyra')
  })

  // A save written before this feature has none of these keys at all, and `sanitized` runs on
  // the way *out* as well as in — a crash here would make exporting impossible.
  it('survives a save that predates encounters', () => {
    const old = state()
    delete (old as Partial<CompanionState>).wild
    delete (old as Partial<CompanionState>).encounterUsage
    delete (old as Partial<CompanionState>).encountersSeen

    const s = sanitized(old)
    expect(s.wild).toEqual([])
    expect(s.encounterUsage).toBe(0)
    expect(s.encountersSeen).toBe(0)
  })
})

describe('rebasedForThisDevice', () => {
  const imported = state({
    usedSinceInstall: 5_000_000,
    language: 'ja',
    installBaselineSet: true,
    claimedTodayTokensByProvider: { claude_code: 9_999_999 },
    lastDate: '2026-01-01',
    candyGrantTier: { w1: 1 },
  })
  const current = state({ language: 'es', candyGrantTier: { w2: 1 } })

  it('carries progress over', () => {
    const r = rebasedForThisDevice(imported, current, {
      todayTokensByProvider: { claude_code: 10 },
      todayDate: '2026-08-19',
      hasUsageData: true,
    })
    expect(r.usedSinceInstall).toBe(5_000_000)
  })

  // A save from a Japanese machine must not change an English machine's UI language.
  it('keeps this device language', () => {
    const r = rebasedForThisDevice(imported, current, {
      todayTokensByProvider: { claude_code: 10 },
      todayDate: '2026-08-19',
      hasUsageData: true,
    })
    expect(r.language).toBe('es')
  })

  // Importing the old machine's daily total as a threshold makes the increment gate false for
  // the rest of the day — and it heals at midnight, which is why it never looks like a bug.
  it('re-anchors the local ledger to this machine', () => {
    const r = rebasedForThisDevice(imported, current, {
      todayTokensByProvider: { claude_code: 10 },
      todayDate: '2026-08-19',
      hasUsageData: true,
    })
    expect(r.claimedTodayTokensByProvider).toEqual({ claude_code: 10 })
    expect(r.lastDate).toBe('2026-08-19')
    expect(r.installBaselineSet).toBe(true)
  })

  // [trigger branch] Seeding an empty ledger would make the first healthy snapshot look like
  // a brand-new provider, silently dropping that day's usage.
  it('defers the baseline when today is not known yet', () => {
    const r = rebasedForThisDevice(imported, current, {
      todayTokensByProvider: {},
      todayDate: '2026-08-19',
      hasUsageData: true,
    })
    expect(r.installBaselineSet).toBe(false)
    expect(r.claimedTodayTokensByProvider).toBeUndefined()
    expect(r.lastDate).toBe('')
  })

  // Limit windows are account-scoped, so both machines see them. Wholesale replacement by an
  // older save would erase a payout and grant the same candy twice.
  it('merges the grant ledger by max instead of replacing it', () => {
    const r = rebasedForThisDevice(imported, current, {
      todayTokensByProvider: { c: 1 },
      todayDate: 'd',
      hasUsageData: true,
    })
    expect(r.candyGrantTier).toEqual({ w1: 1, w2: 1 })
    expect(mergedGrantTier({ w: 1 }, { w: 0 })).toEqual({ w: 1 })
    expect(mergedGrantTier({ w: 0 }, { w: 1 })).toEqual({ w: 1 })
  })
})

describe('summary', () => {
  it('names what the overwrite would replace', () => {
    expect(summarize(state({ usedSinceInstall: 42, dex: [] }))).toEqual({
      dexCount: 0,
      lifetimeTokens: 42,
    })
  })
})
