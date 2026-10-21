import { describe, expect, it } from 'vitest'
import {
  CHALLENGE_TYPES,
  challengesFor,
  ensureChallenges,
  isoWeekKey,
  progressCatch,
  progressTokens,
} from '../src/core/companion/challenges.js'
import { EconomyBalance } from '../src/core/companion/economy.js'
import { freshCompanionState, type CompanionState } from '../src/core/companion/model.js'

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

describe('the challenge generator', () => {
  // Deterministic by date: every machine shows the same challenges the same day, and a merge
  // compares like with like.
  it('gives the same challenges for the same day, and two daily plus one weekly', () => {
    const a = challengesFor('2026-10-21')
    expect(a).toEqual(challengesFor('2026-10-21'))
    expect(a.filter((c) => c.period === 'day')).toHaveLength(2)
    expect(a.filter((c) => c.period === 'week')).toHaveLength(1)
    const kinds = a.filter((c) => c.period === 'day').map((c) => c.kind)
    expect(new Set(kinds).size).toBe(2)
  })

  it('varies from day to day, and keeps the weekly one through the week', () => {
    const days = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']
    const dailies = days.map((d) => JSON.stringify(challengesFor(d).filter((c) => c.period === 'day')))
    expect(new Set(dailies).size).toBeGreaterThan(1)
    const weeklies = days.map((d) => JSON.stringify(challengesFor(d).filter((c) => c.period === 'week')))
    expect(new Set(weeklies).size).toBe(1)
    expect(isoWeekKey('2026-10-19')).toBe(isoWeekKey('2026-10-25'))
    // Known ISO weeks, the year boundary included: a Thursday 1 January opens week 1, a Friday
    // one still belongs to the previous year's last week.
    expect(isoWeekKey('2026-10-21')).toBe('2026-W43')
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01')
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53')
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01')
    expect(isoWeekKey('2026-10-26')).not.toBe(isoWeekKey('2026-10-25'))
  })

  it('only asks for a type common enough to meet in a day', () => {
    for (let d = 1; d <= 28; d++) {
      const day = `2026-02-${String(d).padStart(2, '0')}`
      for (const c of challengesFor(day))
        if (c.type !== undefined) expect(CHALLENGE_TYPES).toContain(c.type)
    }
  })
})

describe('challenge progress', () => {
  const day = '2026-10-21'
  const fresh = () => ensureChallenges(state(), day).state

  // [trigger branch] A new day replaces the daily challenges and keeps the weekly one's progress.
  it('renews the dailies on a new day and keeps the weekly through its week', () => {
    let s = fresh()
    s = progressTokens(s, 1_000_000).state
    const weekly = s.challenges!.items.find((c) => c.period === 'week')!
    const next = ensureChallenges(s, '2026-10-22').state
    expect(next.challenges!.day).toBe('2026-10-22')
    expect(next.challenges!.items.find((c) => c.period === 'week')).toEqual(weekly)
  })

  // [trigger branch] Completing one pays its reward into `earnedTokens` once, and says so once.
  it('pays a completed challenge once', () => {
    let s = fresh()
    const tokens = s.challenges!.items.find((c) => c.kind === 'useTokens')
    if (tokens === undefined) return
    const first = progressTokens(s, tokens.target)
    expect(first.done.map((c) => c.id)).toContain(tokens.id)
    const reward =
      tokens.period === 'day'
        ? EconomyBalance.challenge.dailyReward
        : EconomyBalance.challenge.weeklyReward
    expect(first.state.earnedTokens).toBeGreaterThanOrEqual(reward)
    s = first.state
    const again = progressTokens(s, tokens.target)
    expect(again.done.map((c) => c.id)).not.toContain(tokens.id)
    expect(again.state.earnedTokens).toBe(s.earnedTokens + 0)
  })

  it('counts catches, the asked type, and a species new to the Pokédex', () => {
    let s = fresh()
    const before = s.challenges!.items.map((c) => c.progress)
    s = progressCatch(s, { types: ['fire'], isNew: true }).state
    const after = s.challenges!.items
    after.forEach((c, i) => {
      const moved = c.progress > before[i]!
      if (c.kind === 'catch' || c.kind === 'newSpecies') expect(moved).toBe(true)
      if (c.kind === 'catchType') expect(moved).toBe(c.type === 'fire')
      if (c.kind === 'useTokens') expect(moved).toBe(false)
    })
  })

  // [trigger branch] A merge can bring progress past the target with the reward unpaid (the
  // winner never completed it): the next settle pays it, once.
  it('pays a challenge whose progress already reached its target', () => {
    const s = fresh()
    const items = s.challenges!.items.map((c) => ({ ...c, progress: c.target }))
    const settled = ensureChallenges({ ...s, challenges: { ...s.challenges!, items } }, day)
    expect(settled.done).toHaveLength(items.length)
    expect(ensureChallenges(settled.state, day).done).toHaveLength(0)
  })
})
