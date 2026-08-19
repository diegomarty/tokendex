import { describe, expect, it } from 'vitest'
import { applyProviderLedger, creditDelta, spendableBalance } from '../src/core/companion/ledger.js'
import { freshCompanionState, type CompanionState } from '../src/core/companion/model.js'

// Ported from the ledger branches of `CompanionStore.update` in CompanionStore.swift.
// Every branch here exists because a specific way of getting it wrong either lost usage or
// granted it twice.

function seeded(overrides: Partial<CompanionState> = {}): CompanionState {
  return {
    ...freshCompanionState('en'),
    installBaselineSet: true,
    claimedTodayTokensByProvider: {},
    lastDate: '2026-08-19',
    ...overrides,
  }
}

const obs = (
  todayTokensByProvider: Record<string, number>,
  todayDate = '2026-08-19',
  hasUsageData = true,
) => ({ todayTokensByProvider, todayDate, hasUsageData })

describe('install baseline', () => {
  it('is not taken from the empty refresh right after startup', () => {
    const result = applyProviderLedger(freshCompanionState('en'), obs({}, '2026-08-19', true))
    expect(result.state.installBaselineSet).toBe(false)
    expect(result.delta).toBe(0)
  })

  // Prior usage must never be granted: someone installing today should not instantly graduate
  // a Pokémon from months of history.
  it('is taken from the first refresh carrying data, granting nothing', () => {
    const result = applyProviderLedger(freshCompanionState('en'), obs({ claude_code: 5_000_000 }))
    expect(result.state.installBaselineSet).toBe(true)
    expect(result.state.claimedTodayTokensByProvider).toEqual({ claude_code: 5_000_000 })
    expect(result.delta).toBe(0)
  })
})

describe('increments', () => {
  it('accrues only the growth since the last observation', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 100 } })
    const result = applyProviderLedger(state, obs({ claude_code: 250 }))
    expect(result.delta).toBe(150)
    expect(result.state.claimedTodayTokensByProvider).toEqual({ claude_code: 250 })
  })

  it('sums across providers', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 100, codex: 10 } })
    expect(applyProviderLedger(state, obs({ claude_code: 150, codex: 40 })).delta).toBe(80)
  })

  // Otherwise switching on a new provider would instantly grant its entire history.
  it('seeds a newly observed provider without back-paying its history', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 100 } })
    const result = applyProviderLedger(state, obs({ claude_code: 100, codex: 9_000_000 }))
    expect(result.delta).toBe(0)
    expect(result.state.claimedTodayTokensByProvider?.['codex']).toBe(9_000_000)
  })

  // A provider's cumulative value can drop (log rotation, a rebuilt cache). Rebasing the
  // aggregate would corrupt the other providers' baselines, so only that line moves.
  it('rebases only the regressing provider, not the aggregate', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 500, codex: 100 } })
    const result = applyProviderLedger(state, obs({ claude_code: 200, codex: 150 }))
    expect(result.delta).toBe(50) // codex grew by 50; claude contributed nothing
    expect(result.state.claimedTodayTokensByProvider).toEqual({ claude_code: 200, codex: 150 })
    expect(result.notes.join(' ')).toContain('usage regression provider=claude_code')
  })

  it('leaves a non-reporting provider baseline untouched', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 500, codex: 100 } })
    const result = applyProviderLedger(state, obs({ claude_code: 600 }))
    expect(result.delta).toBe(100)
    expect(result.state.claimedTodayTokensByProvider?.['codex']).toBe(100)
  })
})

describe('empty or stale refreshes', () => {
  // Letting an empty map move the date would make the next healthy snapshot look like a whole
  // day of brand-new usage.
  it('ignores a refresh with no provider data', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 100 }, lastDate: '2026-08-18' })
    const result = applyProviderLedger(state, obs({}, '2026-08-19'))
    expect(result.delta).toBe(0)
    expect(result.state.lastDate).toBe('2026-08-18')
  })

  it('ignores a refresh flagged as having no usage data', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 100 } })
    expect(applyProviderLedger(state, obs({ claude_code: 900 }, '2026-08-19', false)).delta).toBe(0)
  })
})

describe('day rollover', () => {
  it('counts the whole of the new day rather than diffing against yesterday', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 9_000 }, lastDate: '2026-08-18' })
    const result = applyProviderLedger(state, obs({ claude_code: 300 }, '2026-08-19'))
    expect(result.delta).toBe(300)
    expect(result.state.lastDate).toBe('2026-08-19')
  })

  // [trigger branch] A provider known yesterday but missing from the first refresh of the new
  // day must be opened at 0, not dropped. Dropping it would seed its cumulative value as
  // "already granted" when it recovers later the same day, losing that usage entirely.
  it('opens a missing known provider at zero so a later recovery still accrues', () => {
    const state = seeded({
      claimedTodayTokensByProvider: { claude_code: 9_000, codex: 4_000 },
      lastDate: '2026-08-18',
    })
    const rollover = applyProviderLedger(state, obs({ claude_code: 300 }, '2026-08-19'))
    expect(rollover.state.claimedTodayTokensByProvider?.['codex']).toBe(0)

    const recovered = applyProviderLedger(rollover.state, obs({ claude_code: 300, codex: 120 }, '2026-08-19'))
    expect(recovered.delta).toBe(120) // not lost
  })

  it('preserves the baseline on a later partial response the same day', () => {
    const state = seeded({ claimedTodayTokensByProvider: { claude_code: 100, codex: 50 } })
    const result = applyProviderLedger(state, obs({ claude_code: 180 }))
    expect(result.state.claimedTodayTokensByProvider?.['codex']).toBe(50)
  })
})

describe('migration from an aggregate-only save', () => {
  // The old aggregate high-water mark cannot be split per provider, so the first valid
  // observation becomes a baseline and nothing is back-paid.
  it('seeds without granting', () => {
    const state = seeded({ claimedTodayTokensByProvider: undefined, lastDate: '' })
    const result = applyProviderLedger(state, obs({ claude_code: 8_000_000 }))
    expect(result.delta).toBe(0)
    expect(result.state.claimedTodayTokensByProvider).toEqual({ claude_code: 8_000_000 })
    expect(result.notes.join(' ')).toContain('ledger seeded')
  })

  it('accrues normally from the next refresh', () => {
    const seededState = applyProviderLedger(
      seeded({ claimedTodayTokensByProvider: undefined }),
      obs({ claude_code: 8_000_000 }),
    ).state
    expect(applyProviderLedger(seededState, obs({ claude_code: 8_000_100 })).delta).toBe(100)
  })
})

describe('crediting a delta', () => {
  it('feeds an egg while there is no active Pokémon', () => {
    const state = creditDelta(seeded({ eggUsage: 10 }), 90)
    expect(state.eggUsage).toBe(100)
    expect(state.usedSinceInstall).toBe(90)
  })

  it('feeds the active Pokémon when there is one', () => {
    const withMon = seeded({
      active: {
        baseID: 1, pathIDs: [1], plannedPathIDs: [1], stageIndex: 0, usedAtStage: 5,
        rarity: 'common', totalForms: 1, isShiny: false, dittoRevealed: false,
      },
    })
    const state = creditDelta(withMon, 95)
    expect(state.active?.usedAtStage).toBe(100)
    expect(state.eggUsage).toBe(0)
  })

  it('ignores a non-positive delta', () => {
    const before = seeded({ eggUsage: 7 })
    expect(creditDelta(before, 0)).toBe(before)
    expect(creditDelta(before, -5)).toBe(before)
  })
})

describe('spendable balance', () => {
  // The growth meter is immutable: buying raises spentTokens and never rewinds growth.
  it('is usage minus what was spent, never negative', () => {
    expect(spendableBalance(seeded({ usedSinceInstall: 1000, spentTokens: 400 }))).toBe(600)
    expect(spendableBalance(seeded({ usedSinceInstall: 100, spentTokens: 400 }))).toBe(0)
  })
})
