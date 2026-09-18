/**
 * The shared usage-aggregation types.
 *
 * This file used to carry a second, parallel copy of the official-limit domain (LimitStatus,
 * the Codex snapshots, `planDisplay`, `tierMultiplier`…) plus the ccusage report parsers the
 * port replaced with direct log reading. Both were dead: `src/core/limits/models.ts` is the
 * live limits model, and nothing has spoken ccusage's JSON since the scan moved in-process.
 * Keeping the copy meant a fix could land in one of two identical-looking files — the exact
 * "second source of truth" the project bans elsewhere — so what is left here is only what the
 * usage layer actually shares: the three aggregate shapes and the JSON alias.
 */

/** A decoded JSON object. Every parser here narrows to this before reading a field. */
export type Json = Record<string, unknown>

/** Totals for one local day. */
export interface DailyUsage {
  date: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalCost: number
}

/** Totals across a named range — a week start ("2026-05-31") or a month ("2026-06"). */
export interface PeriodUsage {
  period: string
  totalTokens: number
  totalCost: number
}

/** The trailing 5-hour rolling window, which is what a burn rate is measured over. */
export interface BlockUsage {
  id: string
  startTime: string
  endTime: string
  isActive: boolean
  totalTokens: number
  costUSD: number
  /** Drives the burn tier, and with it the companion's mood. */
  tokensPerMinute?: number
}
