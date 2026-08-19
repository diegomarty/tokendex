/**
 * Normalised usage record and aggregation: the Entry/Bucket types, the aggregation helpers
 * and the date utilities.
 *
 * Dates are epoch milliseconds rather than `Date` objects: the scan builds hundreds of
 * thousands of these and allocating a Date per entry is pure overhead.
 */

import type { BlockUsage, DailyUsage, PeriodUsage } from '../models.js'
import { costFor } from '../modelPricing.js'

/** Rolling window shared by the active block (burn rate) and the enrichment scan floor. */
export const BLOCK_WINDOW_MS = 5 * 3600 * 1000

export interface Entry {
  id: string
  /** Epoch milliseconds. */
  date: number
  /** `yyyy-MM-dd` in the *local* timezone. */
  localDay: string
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /**
   * Some agents persist the exact charge alongside token usage. Preferred over table
   * pricing when present, so local reports match the source of truth.
   */
  explicitCost?: number
}

export function entryTotal(e: Entry): number {
  return e.input + e.output + e.cacheWrite + e.cacheRead
}

export class Bucket {
  input = 0
  output = 0
  cacheWrite = 0
  cacheRead = 0
  cost = 0

  get total(): number {
    return this.input + this.output + this.cacheWrite + this.cacheRead
  }

  add(e: Entry): void {
    this.input += e.input
    this.output += e.output
    this.cacheWrite += e.cacheWrite
    this.cacheRead += e.cacheRead
    // An explicit cost only wins when it is positive; zero falls through to the table so a
    // source that records 0 does not silently zero out a priced model.
    const explicit = e.explicitCost !== undefined && e.explicitCost > 0 ? e.explicitCost : undefined
    this.cost += explicit ?? costFor(e.model, e.input, e.output, e.cacheWrite, e.cacheRead)
  }
}

// MARK: - Aggregation

/** Totals for one local day, or undefined when that day has no data. */
export function daily(entries: Entry[], localDay: string): DailyUsage | undefined {
  const b = new Bucket()
  for (const e of entries) if (e.localDay === localDay) b.add(e)
  if (b.total <= 0) return undefined
  return {
    date: localDay,
    inputTokens: b.input,
    outputTokens: b.output,
    cacheCreationTokens: b.cacheWrite,
    cacheReadTokens: b.cacheRead,
    totalTokens: b.total,
    totalCost: b.cost,
  }
}

/** Totals across the inclusive local-day range [fromDay, toDay]. */
export function period(entries: Entry[], periodKey: string, fromDay: string, toDay: string): PeriodUsage {
  const b = new Bucket()
  for (const e of entries) if (e.localDay >= fromDay && e.localDay <= toDay) b.add(e)
  return { period: periodKey, totalTokens: b.total, totalCost: b.cost }
}

/**
 * Block ids and start/end times carry no fractional seconds, but `Date.toISOString()` always
 * emits them. Stripping them here keeps every such value in one canonical form.
 */
function iso8601NoFraction(millis: number): string {
  return new Date(millis).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Active block over the trailing 5-hour rolling window, used to estimate burn rate. */
export function activeBlock(entries: Entry[], now: number): BlockUsage | undefined {
  const windowStart = now - BLOCK_WINDOW_MS
  const recent = entries.filter((e) => e.date >= windowStart).sort((a, b) => a.date - b.date)
  const first = recent[0]
  if (first === undefined) return undefined

  const b = new Bucket()
  for (const e of recent) b.add(e)
  const minutes = Math.max(1, (now - first.date) / 60_000)

  return {
    id: `block-${Math.floor(first.date / 1000)}`,
    startTime: iso8601NoFraction(first.date),
    endTime: iso8601NoFraction(first.date + BLOCK_WINDOW_MS),
    isActive: true,
    totalTokens: b.total,
    costUSD: b.cost,
    tokensPerMinute: b.total / minutes,
  }
}

// MARK: - Date utilities (local timezone, like Calendar.current)

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `yyyy-MM-dd` in the local timezone. */
export function localDayKey(millis: number): string {
  const d = new Date(millis)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** `yyyy-MM` in the local timezone. */
export function monthKey(millis: number): string {
  const d = new Date(millis)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

export function todayKey(now: number = Date.now()): string {
  return localDayKey(now)
}

export function startOfMonth(millis: number): number {
  const d = new Date(millis)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/**
 * First day of the week the date falls in, honouring the region's first weekday exactly as
 * `Calendar.current` does — Sunday in en-US/ko-KR/ja-JP, Monday in es-ES/fr-FR.
 *
 * `getWeekInfo().firstDay` is ISO-numbered (1 = Monday … 7 = Sunday) while `getDay()` is
 * 0 = Sunday, hence the modulo.
 */
export function startOfWeek(millis: number, locale?: string): number {
  const d = new Date(millis)
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const offset = (midnight.getDay() - firstWeekday(locale) + 7) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset).getTime()
}

/** Locale's first weekday as `getDay()` numbers this file uses (0 = Sunday). */
function firstWeekday(locale?: string): number {
  try {
    const l = new Intl.Locale(locale ?? Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo
    return info === undefined ? 0 : info.firstDay % 7
  } catch {
    return 0 // Sunday, matching the en-US default
  }
}

/**
 * Lower mtime bound for a scan. Enrichment (active block, this week, this month) all comes
 * from a single scan, so the floor must be the **earliest** of those three window starts.
 *
 * The trap: using monthStart alone means that at the start of a month the current week
 * begins in the *previous* month (11 of 2026's 12 months do), and just after midnight the
 * 5h block reaches into yesterday. Session files modified last month then fall out of the
 * scan, under-reporting the weekly total and burn rate for days. `min` absorbs that edge.
 */
export function enrichmentScanStart(now: number, locale?: string): number {
  return Math.min(startOfMonth(now), startOfWeek(now, locale), now - BLOCK_WINDOW_MS)
}

// MARK: - Numeric coercion

/**
 * Parsing ceiling — 100,000x real-world usage (billions), so it never clips a legitimate
 * value. Not `Number.MAX_SAFE_INTEGER`: clamping to the type maximum still overflows where
 * values are *added right after parsing* (`output + thoughts`). The bound must survive
 * repeated addition.
 */
export const MAX_PARSED_TOKEN_VALUE = 1_000_000_000_000_000

/**
 * A number only when one is genuinely present. JSON `null`, strings and missing keys all
 * yield undefined — testing `usage['x'] !== undefined` would let an explicit `null` through
 * as "present" and flatten it to 0.
 */
export function doubleOrNil(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return v
}

/**
 * Safe integer coercion. Values like `1e30` really do turn up: usage logs come from outside
 * the app (hand edits, transfer corruption, upstream bugs) and stay on disk, so letting one
 * through would poison every refresh and every relaunch until the user deleted the file by
 * hand. Clamping is the safer degradation.
 */
export function intOrNil(v: unknown): number | undefined {
  const d = doubleOrNil(v)
  if (d === undefined) return undefined
  if (!(d > 0)) return 0 // there are no negative token counts
  return d >= MAX_PARSED_TOKEN_VALUE ? MAX_PARSED_TOKEN_VALUE : Math.trunc(d)
}

/** Absence folds to 0, same rules as `intOrNil` otherwise. */
export function intValue(v: unknown): number {
  return intOrNil(v) ?? 0
}

export function boolValue(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0 // NSNumber.boolValue semantics
  return false
}

export function nonEmpty(v: string | undefined | null): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

/**
 * `target.push(...source)` passes one stack argument per element and V8 throws a
 * `RangeError` somewhere past ~150k of them — a size a single cold Cursor or Claude scan can
 * genuinely reach. The failure would be silent: the per-provider catch turns it into a
 * permanent zero. A plain loop has no such cliff.
 */
export function appendAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) target.push(item)
}

/**
 * Session resume and sidechains write the same message into several files. Keeping the
 * highest-token copy per id is what de-duplicates them.
 */
export function dedupKeepMax(entries: Entry[]): Entry[] {
  const best = new Map<string, Entry>()
  for (const e of entries) {
    const previous = best.get(e.id)
    if (previous === undefined || entryTotal(e) > entryTotal(previous)) best.set(e.id, e)
  }
  return [...best.values()]
}
