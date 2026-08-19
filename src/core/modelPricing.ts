/**
 * Per-token USD rates, bundled to match ccusage (--offline, LiteLLM snapshot). They were
 * derived by linear back-solving several days of `ccusage --breakdown` output against
 * (4 token kinds, cost); fit error 0.000%.
 */

export interface ModelRate {
  /** USD per token. */
  readonly input: number
  readonly output: number
  /** Cache creation. */
  readonly cacheWrite: number
  readonly cacheRead: number
}

export const ZERO_RATE: ModelRate = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }

/** Declared as USD per *million* tokens for readability, stored per token. */
export function perMillion(
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
): ModelRate {
  return {
    input: input / 1_000_000,
    output: output / 1_000_000,
    cacheWrite: cacheWrite / 1_000_000,
    cacheRead: cacheRead / 1_000_000,
  }
}

/** Exact-match table (USD/Mtok), aligned with ccusage. */
export const PRICING_TABLE: Readonly<Record<string, ModelRate>> = {
  'claude-opus-4-8': perMillion(5, 25, 6.25, 0.5),
  'claude-opus-4-7': perMillion(5, 25, 6.25, 0.5),
  'claude-sonnet-4-6': perMillion(3, 15, 3.75, 0.3),
  'claude-haiku-4-5-20251001': perMillion(1, 5, 1.25, 0.1),
  'claude-fable-5': ZERO_RATE, // unpriced by ccusage -> $0
  'gpt-5.5': perMillion(5, 30, 0, 0.5),
  // Gemini — official API rates (base tier, <=200K prompt). Cache uses the read rate only,
  // excluding storage-time charges.
  'gemini-2.5-pro': perMillion(1.25, 10, 0, 0.3125),
  'gemini-2.5-flash': perMillion(0.3, 2.5, 0, 0.075),
  'gemini-2.0-flash': perMillion(0.1, 0.4, 0, 0.025),
}

/**
 * Exact match first, then a family fallback (guards against version drift), then 0 —
 * matching how ccusage treats unpriced models.
 */
export function rateFor(model: string): ModelRate {
  const exact = PRICING_TABLE[model]
  if (exact) return exact

  const m = model.toLowerCase()

  // Grok bills from the server-reported cost (costUsdTicks) and has no rate table, so 0.
  // This must precede the family fallback or names like `grok-codex-*` / `grok-4o-*` would
  // be priced as GPT and display invented amounts.
  if (m.startsWith('grok')) return ZERO_RATE

  // Antigravity is subscription-based: no per-token billing and the source reports no cost.
  // The `antigravity/` prefix already dodges the exact-match table (that CLI also calls
  // `claude-sonnet-4-6`, which without the prefix would match), and this line stops the
  // family fallback from pricing it too.
  if (m.startsWith('antigravity/')) return ZERO_RATE

  if (m.includes('opus')) return perMillion(5, 25, 6.25, 0.5)
  if (m.includes('sonnet')) return perMillion(3, 15, 3.75, 0.3)
  if (m.includes('haiku')) return perMillion(1, 5, 1.25, 0.1)
  if (m.includes('gpt') || m.includes('codex') || m.includes('o4') || m.includes('o3')) {
    return perMillion(5, 30, 0, 0.5)
  }
  // Gemini family fallback — pro/flash only (version drift). Other gemini variants stay at
  // 0 rather than risk displaying a wrong price.
  if (m.startsWith('gemini')) {
    if (m.includes('pro')) return perMillion(1.25, 10, 0, 0.3125)
    if (m.includes('flash')) return perMillion(0.3, 2.5, 0, 0.075)
  }
  return ZERO_RATE
}

export function costFor(
  model: string,
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
): number {
  const r = rateFor(model)
  return input * r.input + output * r.output + cacheWrite * r.cacheWrite + cacheRead * r.cacheRead
}
