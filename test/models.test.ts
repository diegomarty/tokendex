import { describe, expect, it } from 'vitest'
import {
  bucketDisplayName,
  codexSnapshots,
  codexWindowDisplayName,
  hasVisibleLimit,
  maxPrimaryUsedPercent,
  parseBlockUsage,
  parseDailyReport,
  parseDailyUsage,
  parseLimitStatus,
  parsePeriodUsage,
  periodFromDaily,
  planDisplay,
  scopedLimitEntries,
  spendControlUsedPercent,
  type CodexRateLimitStatus,
  type LimitStatus,
} from '../src/core/models.js'

// ---------------------------------------------------------------------------
// Ported from `CodexLimitDerivationTests` in ModelLogicTests.swift
// ---------------------------------------------------------------------------

describe('codexWindowDisplayName', () => {
  const name = (mins: number | undefined) =>
    codexWindowDisplayName({ usedPercent: 0, ...(mins === undefined ? {} : { windowDurationMins: mins }) })

  it('maps known and derived window durations', () => {
    expect(name(300)).toBe('5시간 세션')
    expect(name(10_080)).toBe('주간')
    expect(name(120)).toBe('2시간') // whole hours
    expect(name(90)).toBe('90분') // not a whole number of hours
    expect(name(undefined)).toBe('한도')
  })
})

describe('spendControlUsedPercent', () => {
  const used = (remainingPercent: number) =>
    spendControlUsedPercent({ limit: '$10', remainingPercent, resetsAt: 0, used: '$3' })

  it('clamps to 0...100', () => {
    expect(used(30)).toBe(70)
    expect(used(-10)).toBe(100) // negative remaining clamps to 100
    expect(used(150)).toBe(0) // >100 clamps to 0
  })
})

describe('hasVisibleLimit', () => {
  it('reflects whether any window is present', () => {
    expect(hasVisibleLimit({})).toBe(false)
    expect(hasVisibleLimit({ primary: { usedPercent: 10, windowDurationMins: 300 } })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Decoding fallbacks. These chains are where a silent port error would hide:
// a wrong fallback yields plausible-but-wrong totals rather than an error.
// ---------------------------------------------------------------------------

describe('parseDailyUsage', () => {
  it('accepts "date" (ccusage <=18) and "period" (>=20)', () => {
    expect(parseDailyUsage({ date: '2026-06-10' }).date).toBe('2026-06-10')
    expect(parseDailyUsage({ period: '2026-06-10' }).date).toBe('2026-06-10')
    // "date" wins when both are present.
    expect(parseDailyUsage({ date: 'a', period: 'b' }).date).toBe('a')
  })

  it('falls back from cacheReadTokens to cachedInputTokens', () => {
    expect(parseDailyUsage({ cachedInputTokens: 7 }).cacheReadTokens).toBe(7)
    expect(parseDailyUsage({ cacheReadTokens: 3, cachedInputTokens: 7 }).cacheReadTokens).toBe(3)
  })

  it('sums the four token kinds when totalTokens is absent', () => {
    const usage = parseDailyUsage({
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationTokens: 4,
      cacheReadTokens: 8,
    })
    expect(usage.totalTokens).toBe(15)
  })

  it('prefers an explicit totalTokens over the sum', () => {
    const usage = parseDailyUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 99 })
    expect(usage.totalTokens).toBe(99)
  })

  it('falls back from totalCost to costUSD', () => {
    expect(parseDailyUsage({ costUSD: 1.5 }).totalCost).toBe(1.5)
    expect(parseDailyUsage({ totalCost: 2.5, costUSD: 1.5 }).totalCost).toBe(2.5)
  })

  it('treats explicit null the same as a missing key', () => {
    const usage = parseDailyUsage({ date: null, totalTokens: null, inputTokens: 5 })
    expect(usage.date).toBe('')
    expect(usage.totalTokens).toBe(5) // fell through to the sum
  })

  it('throws when a present key has the wrong type, matching decodeIfPresent', () => {
    expect(() => parseDailyUsage({ inputTokens: 'lots' })).toThrow(TypeError)
    expect(() => parseDailyUsage({ inputTokens: 1.5 })).toThrow(TypeError)
  })

  it('defaults every field on an empty object', () => {
    expect(parseDailyUsage({})).toEqual({
      date: '',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    })
  })
})

describe('parseDailyReport', () => {
  it('returns an empty list when "daily" is absent', () => {
    expect(parseDailyReport({})).toEqual([])
  })
})

describe('parseBlockUsage', () => {
  it('lifts burnRate.tokensPerMinute', () => {
    expect(parseBlockUsage({ burnRate: { tokensPerMinute: 12.5 } }).tokensPerMinute).toBe(12.5)
  })

  it('tolerates a malformed burnRate rather than failing the block (Swift uses try?)', () => {
    expect(parseBlockUsage({ burnRate: 'nonsense', id: 'b' }).id).toBe('b')
    expect(parseBlockUsage({ burnRate: { tokensPerMinute: 'fast' } }).tokensPerMinute).toBeUndefined()
  })

  it('defaults isActive to false', () => {
    expect(parseBlockUsage({}).isActive).toBe(false)
  })
})

describe('parsePeriodUsage', () => {
  it('accepts week, month or period as the label', () => {
    expect(parsePeriodUsage({ week: '2026-05-31' }).period).toBe('2026-05-31')
    expect(parsePeriodUsage({ month: '2026-06' }).period).toBe('2026-06')
    expect(parsePeriodUsage({ period: 'x' }).period).toBe('x')
    // week wins over month, month over period.
    expect(parsePeriodUsage({ week: 'w', month: 'm', period: 'p' }).period).toBe('w')
  })

  it('sums tokens when totalTokens is absent', () => {
    expect(parsePeriodUsage({ inputTokens: 10, cachedInputTokens: 5 }).totalTokens).toBe(15)
  })
})

describe('periodFromDaily', () => {
  it('aggregates tokens and cost', () => {
    const day = (totalTokens: number, totalCost: number) => ({
      date: '',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens,
      totalCost,
    })
    expect(periodFromDaily('2026-06', [day(10, 1), day(5, 0.5)])).toEqual({
      period: '2026-06',
      totalTokens: 15,
      totalCost: 1.5,
    })
  })
})

// ---------------------------------------------------------------------------
// OAuth limits
// ---------------------------------------------------------------------------

describe('planDisplay', () => {
  it('appends the tier multiplier when the tier carries one', () => {
    expect(planDisplay({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })).toBe('Max 20x')
    expect(planDisplay({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' })).toBe('Max 5x')
  })

  it('shows the plan name alone when the tier has no multiplier', () => {
    expect(planDisplay({ subscriptionType: 'pro', rateLimitTier: 'default_claude_pro' })).toBe('Pro')
    expect(planDisplay({ subscriptionType: 'free' })).toBe('Free')
  })

  it('is not a Max-only branch — any plan picks up a multiplier', () => {
    expect(planDisplay({ subscriptionType: 'pro', rateLimitTier: 'something_10x' })).toBe('Pro 10x')
  })

  it('returns undefined without a subscription type', () => {
    expect(planDisplay({})).toBeUndefined()
    expect(planDisplay({ subscriptionType: '' })).toBeUndefined()
  })

  it('ignores tokens that end in x but are not numeric', () => {
    expect(planDisplay({ subscriptionType: 'max', rateLimitTier: 'claude_max_ax' })).toBe('Max')
    expect(planDisplay({ subscriptionType: 'max', rateLimitTier: 'claude_max_x' })).toBe('Max')
  })
})

describe('scopedLimitEntries', () => {
  const entries = [{ kind: 'session' }, { kind: 'weekly_all' }, { kind: 'weekly_scoped' }]

  it('drops rows the legacy fields already display', () => {
    const status: LimitStatus = { fiveHour: {}, sevenDay: {}, limits: entries }
    expect(scopedLimitEntries(status).map((e) => e.kind)).toEqual(['weekly_scoped'])
  })

  it('falls back to every entry when the legacy fields are absent', () => {
    expect(scopedLimitEntries({ limits: entries })).toHaveLength(3)
  })

  it('still filters when only one legacy field is present', () => {
    expect(scopedLimitEntries({ fiveHour: {}, limits: entries }).map((e) => e.kind)).toEqual([
      'weekly_scoped',
    ])
  })
})

describe('parseLimitStatus', () => {
  it('reads the snake_case wire names', () => {
    const status = parseLimitStatus({
      five_hour: { utilization: 0.5, resets_at: '2026-06-10T11:10:00Z' },
      seven_day: { utilization: 0.1 },
      limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Opus' } } }],
    })
    expect(status.fiveHour?.utilization).toBe(0.5)
    expect(status.fiveHour?.resetsAt).toBe('2026-06-10T11:10:00Z')
    expect(status.limits?.[0]?.scope?.model?.displayName).toBe('Opus')
  })

  it('does not decode subscription info — it is injected, not received', () => {
    const status = parseLimitStatus({ subscriptionType: 'max', rateLimitTier: 'x_20x' })
    expect(status.subscriptionType).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Codex buckets
// ---------------------------------------------------------------------------

describe('codexSnapshots', () => {
  it('keeps only the top-level snapshot when there is no byLimitId map', () => {
    const status: CodexRateLimitStatus = { rateLimits: { limitId: 'codex' } }
    expect(codexSnapshots(status)).toHaveLength(1)
  })

  it('de-duplicates the top-level bucket against its byLimitId twin', () => {
    const status: CodexRateLimitStatus = {
      rateLimits: { limitId: 'codex' },
      rateLimitsByLimitId: { codex: { limitId: 'codex' }, codex_other: { limitId: 'codex_other' } },
    }
    expect(codexSnapshots(status).map((s) => s.limitId)).toEqual(['codex', 'codex_other'])
  })

  it('treats a missing limitId as the "codex" key, as the server does', () => {
    const status: CodexRateLimitStatus = {
      rateLimits: {},
      rateLimitsByLimitId: { codex: {}, codex_other: { limitId: 'codex_other' } },
    }
    expect(codexSnapshots(status)).toHaveLength(2)
  })

  it('is deterministic regardless of key insertion order', () => {
    const ids = (map: Record<string, { limitId: string }>) =>
      codexSnapshots({ rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: map }).map((s) => s.limitId)
    expect(ids({ b: { limitId: 'b' }, a: { limitId: 'a' } })).toEqual(['codex', 'a', 'b'])
    expect(ids({ a: { limitId: 'a' }, b: { limitId: 'b' } })).toEqual(['codex', 'a', 'b'])
  })
})

describe('maxPrimaryUsedPercent', () => {
  it('takes the highest primary utilisation across visible buckets', () => {
    const status: CodexRateLimitStatus = {
      rateLimits: { limitId: 'codex', primary: { usedPercent: 42 } },
      rateLimitsByLimitId: { codex_other: { limitId: 'codex_other', primary: { usedPercent: 77 } } },
    }
    expect(maxPrimaryUsedPercent(status)).toBe(77)
  })

  it('is undefined when no bucket has a visible limit', () => {
    expect(maxPrimaryUsedPercent({ rateLimits: {} })).toBeUndefined()
  })
})

describe('bucketDisplayName', () => {
  it('humanises the limit name', () => {
    expect(bucketDisplayName({ limitName: 'codex' })).toBe('Codex')
    expect(bucketDisplayName({ limitId: 'codex_other' })).toBe('Codex other')
    expect(bucketDisplayName({})).toBe('Codex')
  })
})
