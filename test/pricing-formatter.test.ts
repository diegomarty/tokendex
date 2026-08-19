import { describe, expect, it } from 'vitest'
import { ZERO_RATE, costFor, perMillion, rateFor } from '../src/core/modelPricing.js'
import { compact, cost, costCompact, grouped, percent } from '../src/core/tokenFormatter.js'

// ---------------------------------------------------------------------------
// ModelPricing
// ---------------------------------------------------------------------------

describe('rateFor / costFor — exact table', () => {
  it('prices a million tokens at the table rate', () => {
    expect(costFor('claude-opus-4-8', 1_000_000, 0, 0, 0)).toBeCloseTo(5.0, 6)
    expect(costFor('claude-opus-4-8', 0, 1_000_000, 0, 0)).toBeCloseTo(25.0, 6)
    expect(costFor('claude-haiku-4-5-20251001', 1_000_000, 0, 0, 0)).toBeCloseTo(1.0, 6)
  })

  it('treats an unpriced table entry as free', () => {
    expect(costFor('claude-fable-5', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(0, 9)
  })
})

describe('rateFor — family fallback', () => {
  it('covers version drift within a known family', () => {
    expect(costFor('claude-opus-4-99', 1_000_000, 0, 0, 0)).toBeCloseTo(5.0, 6)
  })

  it('prices a wholly unknown model at zero', () => {
    expect(costFor('totally-unknown', 1_000_000, 0, 0, 0)).toBeCloseTo(0, 9)
  })
})

describe('rateFor — Gemini', () => {
  it('matches exactly and falls back on pro/flash', () => {
    expect(rateFor('gemini-2.5-pro')).toEqual(perMillion(1.25, 10, 0, 0.3125))
    expect(rateFor('gemini-2.5-flash')).toEqual(perMillion(0.3, 2.5, 0, 0.075))
    expect(rateFor('gemini-3.1-pro-preview')).toEqual(perMillion(1.25, 10, 0, 0.3125))
    expect(rateFor('gemini-3-flash-lite')).toEqual(perMillion(0.3, 2.5, 0, 0.075))
  })

  it('leaves unknown gemini variants at zero rather than risk a wrong price', () => {
    expect(rateFor('gemini-nano-banana')).toEqual(ZERO_RATE)
  })

  it('computes the real arithmetic case', () => {
    expect(costFor('gemini-2.5-pro', 420, 80, 0, 600)).toBeCloseTo(
      420 * 1.25e-6 + 80 * 10e-6 + 600 * 0.3125e-6,
      12,
    )
  })
})

// [trigger branch] Grok names must short-circuit to zero *before* the family fallback:
// `grok-codex-*` and `grok-4o-*` contain the `codex` / `o4` substrings and would otherwise
// be priced as GPT ($5/$30), inventing an amount.
describe('rateFor — Grok never inherits another family price', () => {
  it.each(['grok-build-1', 'grok-4-fast', 'grok-code-fast-1', 'grok-codex-next', 'grok-4o-mini'])(
    '%s is unpriced',
    (name) => {
      expect(rateFor(name)).toEqual(ZERO_RATE)
    },
  )

  it('costs nothing even at a million tokens', () => {
    expect(costFor('grok-codex-next', 1_000_000, 1_000_000, 0, 0)).toBe(0)
  })

  it('does not over-block other providers', () => {
    expect(rateFor('gpt-5.6-codex')).toEqual(perMillion(5, 30, 0, 0.5))
  })
})

// Antigravity is a subscription and reports no amount, so an estimate would be an invented
// bill. The prefix also keeps names out of the exact table — this CLI really does call
// `claude-sonnet-4-6`, which the table prices.
describe('rateFor — Antigravity is never priced', () => {
  it.each(['gemini-3.6-flash', 'gemini-3-flash-e', 'gemini-default', 'claude-sonnet-4-6'])(
    'antigravity/%s is unpriced',
    (model) => {
      expect(costFor(`antigravity/${model}`, 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(
        0,
        7,
      )
    },
  )

  it('keeps the unprefixed name priced', () => {
    expect(costFor('claude-sonnet-4-6', 1_000_000, 0, 0, 0)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// TokenFormatter
// ---------------------------------------------------------------------------

describe('compact', () => {
  it('scales and trims trailing zeros', () => {
    expect(compact(0)).toBe('0')
    expect(compact(987)).toBe('987')
    expect(compact(12_345)).toBe('12.3K')
    expect(compact(190_612_940)).toBe('190.6M')
    expect(compact(1_240_000_000)).toBe('1.24B')
    // Deliberate divergence from upstream, which has no T tier: at ~690M/day a lifetime total
    // crosses a trillion within months, and `4997.38B` reads as a broken number.
    expect(compact(999_000_000_000)).toBe('999B')
    expect(compact(1_000_000_000_000)).toBe('1T')
    expect(compact(4_997_380_000_000)).toBe('5T')
    expect(compact(-4_997_380_000_000)).toBe('-5T')
    expect(compact(1_000_000)).toBe('1M')
  })

  it('keeps the sign', () => {
    expect(compact(-500)).toBe('-500')
    expect(compact(-12_345)).toBe('-12.3K')
  })
})

describe('grouped', () => {
  // The locale is pinned deliberately: with the runner's default this only goes red on a
  // machine whose region does not use commas (PR #160). CI (en-US) and ko-KR both use
  // commas and would never see the failure.
  it('follows the system region for separators', () => {
    expect(grouped(253_412_890, 'en-US')).toBe('253,412,890')
    expect(grouped(253_412_890, 'es-ES')).toBe('253.412.890')
  })
})

describe('cost / costCompact / percent', () => {
  it('formats boundary values', () => {
    expect(cost(48.104)).toBe('$48.10')
    expect(costCompact(9.54)).toBe('$9.5') // < 100 -> one decimal
    expect(costCompact(311.4)).toBe('$311') // < 10K -> integer
    expect(costCompact(12_340)).toBe('$12.3K') // >= 10K -> K
    expect(percent(88)).toBe('88%')
    expect(percent(88.35)).toBe('88.3%')
  })
})

describe('rateFor memoization', () => {
  // The cache is keyed by the full model string; a bug that collapsed distinct strings into
  // one bucket would price every model like the first one asked about.
  it('returns the same rate object for a repeated string and distinct rates for distinct ones', () => {
    const dated = 'claude-opus-4-8-20260101'
    expect(rateFor(dated)).toBe(rateFor(dated))
    expect(rateFor(dated)).not.toEqual(rateFor('claude-haiku-4-5-20260101'))
    expect(rateFor('grok-4-fast')).toEqual(ZERO_RATE)
    expect(rateFor('antigravity/claude-sonnet-4-6')).toEqual(ZERO_RATE)
  })
})
