import { describe, expect, it } from 'vitest'
import {
  accrualDaysWithin,
  applyLegendaryTriggers,
  applyProviderLedger,
  creditDelta,
  dayNumber,
  noteAccrualDay,
  spendableBalance,
  streakWindow,
} from '../src/core/companion/ledger.js'
import { freshCompanionState, type CompanionState } from '../src/core/companion/model.js'
import { MilestoneBalance, StreakBalance } from '../src/core/companion/encounters.js'

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
    const state = seeded({
      claimedTodayTokensByProvider: { claude_code: 100 },
      lastDate: '2026-08-18',
    })
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
    const state = seeded({
      claimedTodayTokensByProvider: { claude_code: 9_000 },
      lastDate: '2026-08-18',
    })
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

    const recovered = applyProviderLedger(
      rollover.state,
      obs({ claude_code: 300, codex: 120 }, '2026-08-19'),
    )
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
        baseID: 1,
        pathIDs: [1],
        plannedPathIDs: [1],
        stageIndex: 0,
        usedAtStage: 5,
        rarity: 'common',
        totalForms: 1,
        isShiny: false,
        dittoRevealed: false,
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

// MARK: - Legendary rewards

// Two overlapping rules, one award. The whole risk here is paying twice for the same work —
// the same day counted twice, the same week counted by both rules, or the same milestone
// replayed after a reload.

describe('accrual days', () => {
  // Days the editor was open are not days of work: only a fold that produced a delta gets here
  // (see `update`), and however many of those land in one day, it is one day.
  it('records a day once however many refreshes land in it', () => {
    let state = noteAccrualDay(seeded(), '2026-08-19')
    state = noteAccrualDay(state, '2026-08-19')
    state = noteAccrualDay(state, '2026-08-19')
    expect(state.accrualDays).toEqual(['2026-08-19'])
  })

  it('prunes anything older than the window, keeping the array bounded', () => {
    let state = seeded()
    // One day per day for three weeks, which is more than twice the window.
    for (let day = 1; day <= 21; day++) {
      state = noteAccrualDay(state, `2026-08-${String(day).padStart(2, '0')}`)
    }
    expect(state.accrualDays.length).toBeLessThanOrEqual(StreakBalance.windowDays)
    expect(state.accrualDays).not.toContain('2026-08-01')
    expect(state.accrualDays).toContain('2026-08-21')
  })

  it('ignores a value that is not a day at all rather than storing it', () => {
    expect(noteAccrualDay(seeded(), 'yesterday').accrualDays).toEqual([])
    expect(dayNumber('yesterday')).toBeUndefined()
    // Local calendar labels, compared at a fixed offset: one day apart is one, never 0 or 2.
    expect(dayNumber('2026-03-30')! - dayNumber('2026-03-29')!).toBe(1)
    expect(dayNumber('2027-01-01')! - dayNumber('2026-12-31')!).toBe(1)
  })

  it('counts only the days inside the window ending today', () => {
    const days = ['2026-08-10', '2026-08-13', '2026-08-19']
    expect(accrualDaysWithin(days, '2026-08-19', 7)).toEqual(['2026-08-13', '2026-08-19'])
  })
})

describe('streak trigger', () => {
  const withDays = (days: string[], over: Partial<CompanionState> = {}) =>
    seeded({ accrualDays: days, ...over })

  it('awards a legendary on three consecutive days of accrual', () => {
    const result = applyLegendaryTriggers(
      withDays(['2026-08-17', '2026-08-18', '2026-08-19']),
      '2026-08-19',
    )
    expect(result.awards).toEqual([{ kind: 'streak', days: 3 }])
    expect(result.state.owedLegendaryEncounters).toBe(1)
  })

  // [trigger branch] The 3-of-7 rule alone, with no two days adjacent: a consecutive-only
  // implementation passes every test above and fails exactly here, which is the point of the
  // second rule — someone who skips a day is still working.
  it('awards on three non-consecutive days inside the window', () => {
    const result = applyLegendaryTriggers(
      withDays(['2026-08-13', '2026-08-16', '2026-08-19']),
      '2026-08-19',
    )
    expect(result.awards).toEqual([{ kind: 'streak', days: 3 }])
  })

  it('does not award for two days, however the week is shaped', () => {
    expect(applyLegendaryTriggers(withDays(['2026-08-18', '2026-08-19']), '2026-08-19').awards).toEqual(
      [],
    )
  })

  it('does not count a day that has fallen out of the window', () => {
    // Three days recorded, but the oldest is eight days back.
    const result = applyLegendaryTriggers(
      withDays(['2026-08-11', '2026-08-18', '2026-08-19']),
      '2026-08-19',
    )
    expect(result.awards).toEqual([])
  })

  // The two rules overlap by design, so the guard is what stops one week's work paying twice.
  it('awards at most one legendary per rolling window, whichever rule got there', () => {
    const first = applyLegendaryTriggers(
      withDays(['2026-08-17', '2026-08-18', '2026-08-19']),
      '2026-08-19',
    )
    expect(first.awards).toHaveLength(1)

    // Two more days of work inside the same window: still three-plus days, still one award.
    let next = noteAccrualDay(first.state, '2026-08-20')
    next = noteAccrualDay(next, '2026-08-21')
    expect(applyLegendaryTriggers(next, '2026-08-21').awards).toEqual([])
    expect(applyLegendaryTriggers(next, '2026-08-21').state.owedLegendaryEncounters).toBe(1)
  })

  it('awards again once the window has passed', () => {
    const first = applyLegendaryTriggers(
      withDays(['2026-08-17', '2026-08-18', '2026-08-19']),
      '2026-08-19',
    )
    let later = first.state
    for (const day of ['2026-08-24', '2026-08-25', '2026-08-26']) later = noteAccrualDay(later, day)
    const second = applyLegendaryTriggers(later, '2026-08-26')
    expect(second.awards).toEqual([{ kind: 'streak', days: 3 }])
    expect(second.state.owedLegendaryEncounters).toBe(2)
  })

  // A clock that ran ahead once must not freeze the reward until the calendar catches up.
  it('is not blocked by an award dated in the future', () => {
    const result = applyLegendaryTriggers(
      withDays(['2026-08-17', '2026-08-18', '2026-08-19'], { lastStreakAwardDate: '2099-01-01' }),
      '2026-08-19',
    )
    expect(result.awards).toHaveLength(1)
  })
})

describe('milestone trigger', () => {
  const N = MilestoneBalance.tokens

  it('awards nothing below the first milestone', () => {
    expect(applyLegendaryTriggers(seeded({ usedSinceInstall: N - 1 }), '2026-08-19').awards).toEqual([])
  })

  it('awards one legendary on crossing a milestone', () => {
    const result = applyLegendaryTriggers(seeded({ usedSinceInstall: N }), '2026-08-19')
    expect(result.awards).toEqual([{ kind: 'milestone', tokens: N }])
    expect(result.state.owedLegendaryEncounters).toBe(1)
  })

  // [trigger branch] A first scan, or an imported save, can cross several at once. Stepping the
  // ratchet by one would award one legendary now and another on every fold after it, replaying
  // milestones that were passed in a single moment.
  it('awards exactly one when several milestones are crossed in one fold', () => {
    const result = applyLegendaryTriggers(seeded({ usedSinceInstall: N * 5 + 7 }), '2026-08-19')
    expect(result.awards).toHaveLength(1)
    expect(result.state.milestonesAwarded).toBe(5)
    // And the fold after it owes nothing more, because the ratchet jumped to what was reached.
    expect(applyLegendaryTriggers(result.state, '2026-08-20').awards).toEqual([])
  })

  it('does not re-award the same milestone after a reload', () => {
    const awarded = applyLegendaryTriggers(seeded({ usedSinceInstall: N }), '2026-08-19').state
    // A reload folds the same state again, several times, with no new usage.
    let state = awarded
    for (let i = 0; i < 3; i++) state = applyLegendaryTriggers(state, '2026-08-19').state
    expect(state.owedLegendaryEncounters).toBe(1)
  })

  it('awards the next one only after another whole milestone of work', () => {
    const first = applyLegendaryTriggers(seeded({ usedSinceInstall: N }), '2026-08-19').state
    expect(
      applyLegendaryTriggers({ ...first, usedSinceInstall: N * 2 - 1 }, '2026-08-19').awards,
    ).toEqual([])
    expect(applyLegendaryTriggers({ ...first, usedSinceInstall: N * 2 }, '2026-08-19').awards).toEqual([
      { kind: 'milestone', tokens: N * 2 },
    ])
  })
})

describe('two triggers in one fold', () => {
  // Neither is dropped and neither overwrites the other: they are entitlements, and the store
  // delivers one per refresh. A boolean "a legendary is owed" would silently lose one.
  it('owes one legendary per trigger', () => {
    const result = applyLegendaryTriggers(
      seeded({
        accrualDays: ['2026-08-17', '2026-08-18', '2026-08-19'],
        usedSinceInstall: MilestoneBalance.tokens,
      }),
      '2026-08-19',
    )
    expect(result.awards.map((a) => a.kind).sort()).toEqual(['milestone', 'streak'])
    expect(result.state.owedLegendaryEncounters).toBe(2)
  })
})

// The indicator is the rule read backwards. If it ever computes "which days count" or "is the
// week spent" for itself, it starts disagreeing with the thing it indicates — a row saying
// "one more day" while the rule has already paid out is worse than no row at all.
describe('the streak window as drawn', () => {
  const week = ['2026-08-17', '2026-08-18', '2026-08-19']

  it('agrees with the trigger about whether the week is spent', () => {
    const before = seeded({ accrualDays: week })
    expect(streakWindow(before, '2026-08-19').earned).toBe(false)

    const after = applyLegendaryTriggers(before, '2026-08-19').state
    expect(after.owedLegendaryEncounters).toBe(1)
    expect(streakWindow(after, '2026-08-19').earned).toBe(true)
    // And the trigger agrees back: nothing more is owed while the row says it is spent.
    expect(applyLegendaryTriggers(after, '2026-08-19').awards).toEqual([])
  })

  it('clears at the same moment the trigger will award again', () => {
    const paid = applyLegendaryTriggers(seeded({ accrualDays: week }), '2026-08-19').state
    const clearsOn = '2026-08-26' // seven days after the award
    expect(streakWindow(paid, '2026-08-25').earned).toBe(true)
    expect(streakWindow(paid, clearsOn).earned).toBe(false)
  })

  it('never draws more dots than the window is wide', () => {
    const crowded = seeded({ accrualDays: week, lastStreakAwardDate: 'not a date' })
    expect(streakWindow(crowded, '2026-08-19').days).toHaveLength(StreakBalance.windowDays)
    // An unreadable date is neither an award day nor a block on the next one.
    expect(streakWindow(crowded, '2026-08-19').days).not.toContain('award')
    expect(streakWindow(crowded, '2026-08-19').earned).toBe(false)
  })

  it('still draws a full row when today itself is unreadable', () => {
    const row = streakWindow(seeded({ accrualDays: week }), 'today')
    expect(row.days).toHaveLength(StreakBalance.windowDays)
    expect(row.count).toBe(0)
  })
})
