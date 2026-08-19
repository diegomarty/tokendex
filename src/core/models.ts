/**
 * Decoding treats a missing key and an explicit JSON `null` as equally "absent", but a key
 * that IS present with the wrong type throws. Keeping that distinction matters — treating an
 * explicit `null` as merely absent caused a real defect.
 */

import { parseISO8601 } from './iso8601.js'

export type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `decodeIfPresent(String.self)` — absent/null yield undefined, wrong type throws. */
function str(json: Json, key: string): string | undefined {
  const v = json[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new TypeError(`${key}: expected string, got ${typeof v}`)
  return v
}

/** Optional integer. A non-integral double is rejected here rather than rounded. */
function int(json: Json, key: string): number | undefined {
  const v = json[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new TypeError(`${key}: expected integer, got ${JSON.stringify(v)}`)
  }
  return v
}

/** `decodeIfPresent(Double.self)` — accepts any JSON number. */
function double(json: Json, key: string): number | undefined {
  const v = json[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number') throw new TypeError(`${key}: expected number, got ${typeof v}`)
  return v
}

function bool(json: Json, key: string): boolean | undefined {
  const v = json[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new TypeError(`${key}: expected boolean, got ${typeof v}`)
  return v
}

function array(json: Json, key: string): unknown[] | undefined {
  const v = json[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new TypeError(`${key}: expected array`)
  return v
}

function object(json: Json, key: string): Json | undefined {
  const v = json[key]
  if (v === undefined || v === null) return undefined
  if (!isObject(v)) throw new TypeError(`${key}: expected object`)
  return v
}

// MARK: - ccusage daily

export interface DailyUsage {
  date: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalCost: number
}

export function parseDailyUsage(json: Json): DailyUsage {
  // ccusage <=18 emits "date", >=20 emits "period".
  const date = str(json, 'date') ?? str(json, 'period') ?? ''
  const inputTokens = int(json, 'inputTokens') ?? 0
  const outputTokens = int(json, 'outputTokens') ?? 0
  const cacheCreationTokens = int(json, 'cacheCreationTokens') ?? 0
  const cacheReadTokens = int(json, 'cacheReadTokens') ?? int(json, 'cachedInputTokens') ?? 0
  return {
    date,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    // Falls back to the sum of the four token kinds when totalTokens is absent.
    totalTokens:
      int(json, 'totalTokens') ?? inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    totalCost: double(json, 'totalCost') ?? double(json, 'costUSD') ?? 0,
  }
}

export function parseDailyReport(json: Json): DailyUsage[] {
  return (array(json, 'daily') ?? []).filter(isObject).map(parseDailyUsage)
}

// MARK: - ccusage blocks

export interface BlockUsage {
  id: string
  startTime: string
  endTime: string
  isActive: boolean
  totalTokens: number
  costUSD: number
  /** `burnRate.tokensPerMinute` — drives limit-exhaustion forecasting and companion mood. */
  tokensPerMinute?: number
}

export function parseBlockUsage(json: Json): BlockUsage {
  const block: BlockUsage = {
    id: str(json, 'id') ?? '',
    startTime: str(json, 'startTime') ?? '',
    endTime: str(json, 'endTime') ?? '',
    isActive: bool(json, 'isActive') ?? false,
    totalTokens: int(json, 'totalTokens') ?? 0,
    costUSD: double(json, 'costUSD') ?? 0,
  }
  // A malformed burnRate is tolerated rather than fatal: the rest of the block is still good.
  try {
    const burn = object(json, 'burnRate')
    if (burn) {
      const rate = double(burn, 'tokensPerMinute')
      if (rate !== undefined) block.tokensPerMinute = rate
    }
  } catch {
    // ignored, matching `try?`
  }
  return block
}

export function blockEndDate(block: BlockUsage): number | null {
  return parseISO8601(block.endTime)
}

export function parseBlocksReport(json: Json): BlockUsage[] {
  return (array(json, 'blocks') ?? []).filter(isObject).map(parseBlockUsage)
}

// MARK: - ccusage weekly / monthly

export interface PeriodUsage {
  /** Week start ("2026-05-31") or month ("2026-06"). */
  period: string
  totalTokens: number
  totalCost: number
}

export function parsePeriodUsage(json: Json): PeriodUsage {
  const input = int(json, 'inputTokens') ?? 0
  const output = int(json, 'outputTokens') ?? 0
  const cacheWrite = int(json, 'cacheCreationTokens') ?? 0
  const cacheRead = int(json, 'cacheReadTokens') ?? int(json, 'cachedInputTokens') ?? 0
  return {
    period: str(json, 'week') ?? str(json, 'month') ?? str(json, 'period') ?? '',
    totalTokens: int(json, 'totalTokens') ?? input + output + cacheWrite + cacheRead,
    totalCost: double(json, 'totalCost') ?? double(json, 'costUSD') ?? 0,
  }
}

/** `PeriodUsage(period:daily:)` — aggregate a period from its days. */
export function periodFromDaily(period: string, daily: DailyUsage[]): PeriodUsage {
  return {
    period,
    totalTokens: daily.reduce((sum, d) => sum + d.totalTokens, 0),
    totalCost: daily.reduce((sum, d) => sum + d.totalCost, 0),
  }
}

export function parseWeeklyReport(json: Json): PeriodUsage[] {
  return (array(json, 'weekly') ?? []).filter(isObject).map(parsePeriodUsage)
}

export function parseMonthlyReport(json: Json): PeriodUsage[] {
  return (array(json, 'monthly') ?? []).filter(isObject).map(parsePeriodUsage)
}

// MARK: - OAuth limits (api.anthropic.com/api/oauth/usage)

export interface LimitWindow {
  utilization?: number
  resetsAt?: string
}

export function parseLimitWindow(json: Json): LimitWindow {
  const window: LimitWindow = {}
  const utilization = double(json, 'utilization')
  if (utilization !== undefined) window.utilization = utilization
  const resetsAt = str(json, 'resets_at')
  if (resetsAt !== undefined) window.resetsAt = resetsAt
  return window
}

export function limitWindowResetDate(window: LimitWindow): number | null {
  return window.resetsAt === undefined ? null : parseISO8601(window.resetsAt)
}

/**
 * Newer `limits[]` entry, generalising the legacy five_hour/seven_day fields.
 * Per-model weekly limits arrive only here, as kind=weekly_scoped.
 */
export interface OAuthLimitEntry {
  kind?: string
  group?: string
  percent?: number
  severity?: string
  resetsAt?: string
  scope?: { model?: { displayName?: string } }
  isActive?: boolean
}

export function parseOAuthLimitEntry(json: Json): OAuthLimitEntry {
  const entry: OAuthLimitEntry = {}
  const assign = <K extends keyof OAuthLimitEntry>(key: K, value: OAuthLimitEntry[K]) => {
    if (value !== undefined) entry[key] = value
  }
  assign('kind', str(json, 'kind'))
  assign('group', str(json, 'group'))
  assign('percent', double(json, 'percent'))
  assign('severity', str(json, 'severity'))
  assign('resetsAt', str(json, 'resets_at'))
  assign('isActive', bool(json, 'is_active'))

  const scope = object(json, 'scope')
  if (scope) {
    const model = object(scope, 'model')
    const displayName = model ? str(model, 'display_name') : undefined
    entry.scope = model ? { model: displayName === undefined ? {} : { displayName } } : {}
  }
  return entry
}

export function limitEntryResetDate(entry: OAuthLimitEntry): number | null {
  return entry.resetsAt === undefined ? null : parseISO8601(entry.resetsAt)
}

export interface LimitStatus {
  fiveHour?: LimitWindow
  sevenDay?: LimitWindow
  sevenDayOpus?: LimitWindow
  sevenDaySonnet?: LimitWindow
  limits?: OAuthLimitEntry[]
  /**
   * Subscription info. Not part of the HTTP usage response — injected from the OAuth
   * credentials by the limits provider, so it is deliberately absent from parsing.
   */
  subscriptionType?: string
  rateLimitTier?: string
}

export function parseLimitStatus(json: Json): LimitStatus {
  const status: LimitStatus = {}
  const window = (key: string) => {
    const raw = object(json, key)
    return raw === undefined ? undefined : parseLimitWindow(raw)
  }
  const fiveHour = window('five_hour')
  if (fiveHour) status.fiveHour = fiveHour
  const sevenDay = window('seven_day')
  if (sevenDay) status.sevenDay = sevenDay
  const sevenDayOpus = window('seven_day_opus')
  if (sevenDayOpus) status.sevenDayOpus = sevenDayOpus
  const sevenDaySonnet = window('seven_day_sonnet')
  if (sevenDaySonnet) status.sevenDaySonnet = sevenDaySonnet

  const limits = array(json, 'limits')
  if (limits) status.limits = limits.filter(isObject).map(parseOAuthLimitEntry)
  return status
}

/**
 * Extracts the trailing multiplier token ("20x"/"5x") from a rate limit tier.
 * Tiers without one ("default_claude_pro") yield undefined so only the plan name shows.
 */
function tierMultiplier(tier: string): string | undefined {
  for (const part of tier.split('_')) {
    if (!part.endsWith('x')) continue
    const digits = part.slice(0, -1)
    if (digits.length > 0 && /^\d+$/.test(digits)) return part
  }
  return undefined
}

/**
 * Display string combining subscription type and tier multiplier.
 * "max" + "default_claude_max_20x" -> "Max 20x". The multiplier is appended whenever the
 * tier carries one, independent of the plan — this is not a Max-only branch.
 */
export function planDisplay(status: LimitStatus): string | undefined {
  const { subscriptionType, rateLimitTier } = status
  if (!subscriptionType) return undefined
  const base = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1)
  if (rateLimitTier) {
    const multiplier = tierMultiplier(rateLimitTier)
    if (multiplier) return `${base} ${multiplier}`
  }
  return base
}

/**
 * Windows the legacy fields cannot represent. session(=five_hour) and weekly_all(=seven_day)
 * are already shown by the legacy rows, so they are filtered out. When the legacy fields are
 * entirely absent (a new-shape response), fall back to showing every entry.
 */
export function scopedLimitEntries(status: LimitStatus): OAuthLimitEntry[] {
  const entries = status.limits ?? []
  if (status.fiveHour === undefined && status.sevenDay === undefined) return entries
  return entries.filter((e) => e.kind !== 'session' && e.kind !== 'weekly_all')
}

// MARK: - Codex app-server rate limits

export interface CodexRateLimitWindow {
  usedPercent: number
  windowDurationMins?: number
  resetsAt?: number
}

/**
 * TODO(localisation): these strings are hard-coded Korean; route through Localization when
 * it lands (phase 5).
 */
export function codexWindowDisplayName(window: CodexRateLimitWindow): string {
  const mins = window.windowDurationMins
  if (mins === undefined || mins === null) return '한도'
  if (mins === 300) return '5시간 세션'
  if (mins === 10_080) return '주간'
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60}시간`
  return `${mins}분`
}

export interface CodexCreditsSnapshot {
  balance?: string
  hasCredits: boolean
  unlimited: boolean
}

export interface CodexSpendControlLimit {
  limit: string
  remainingPercent: number
  resetsAt: number
  used: string
}

export function spendControlUsedPercent(limit: CodexSpendControlLimit): number {
  return Math.max(0, Math.min(100, 100 - limit.remainingPercent))
}

export interface CodexRateLimitSnapshot {
  limitId?: string
  limitName?: string
  primary?: CodexRateLimitWindow
  secondary?: CodexRateLimitWindow
  credits?: CodexCreditsSnapshot
  individualLimit?: CodexSpendControlLimit
  planType?: string
  rateLimitReachedType?: string
}

export function hasVisibleLimit(snapshot: CodexRateLimitSnapshot): boolean {
  return (
    snapshot.primary !== undefined ||
    snapshot.secondary !== undefined ||
    snapshot.individualLimit !== undefined
  )
}

/** "codex" -> "Codex", "codex_other" -> "Codex other". */
export function bucketDisplayName(snapshot: CodexRateLimitSnapshot): string {
  const raw = snapshot.limitName ?? snapshot.limitId ?? 'codex'
  const spaced = raw.replaceAll('_', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export interface CodexRateLimitStatus {
  rateLimits: CodexRateLimitSnapshot
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot>
}

/**
 * Every bucket, mirroring codex TUI `app_server_rate_limit_snapshots`. The server's
 * top-level `rateLimits` favours the "codex" bucket, so buckets like codex_other exist
 * only in `rateLimitsByLimitId`. Merge both, de-duplicating on limitId.
 */
export function codexSnapshots(status: CodexRateLimitStatus): CodexRateLimitSnapshot[] {
  const result = [status.rateLimits]
  const byLimitId = status.rateLimitsByLimitId
  if (!byLimitId) return result

  // The server files a snapshot without a limitId under the "codex" key
  // (account_processor.rs), which duplicates the top-level one. Sorting removes
  // dictionary-order non-determinism.
  const primaryKey = status.rateLimits.limitId ?? 'codex'
  for (const limitId of Object.keys(byLimitId).sort()) {
    if (limitId === primaryKey) continue
    const snapshot = byLimitId[limitId]
    if (snapshot === undefined) continue
    if (snapshot.limitId !== undefined && snapshot.limitId === status.rateLimits.limitId) continue
    result.push(snapshot)
  }
  return result
}

export function codexVisibleSnapshots(status: CodexRateLimitStatus): CodexRateLimitSnapshot[] {
  return codexSnapshots(status).filter(hasVisibleLimit)
}

export function codexHasVisibleLimit(status: CodexRateLimitStatus): boolean {
  return codexVisibleSnapshots(status).length > 0
}

/** Highest 5h (primary) utilisation across buckets — drives the status bar and warnings. */
export function maxPrimaryUsedPercent(status: CodexRateLimitStatus): number | undefined {
  const percents = codexVisibleSnapshots(status)
    .map((s) => s.primary?.usedPercent)
    .filter((p): p is number => p !== undefined)
  return percents.length === 0 ? undefined : Math.max(...percents)
}

// MARK: - Provider snapshot

export interface ProviderSnapshot {
  providerID: string
  displayName: string
  today?: DailyUsage
  activeBlock?: BlockUsage
  weekTotal?: PeriodUsage
  monthTotal?: PeriodUsage
  /** Milliseconds since the epoch. */
  fetchedAt: number
  /** Mirrors `UsageProvider.reportsCost`. */
  reportsCost: boolean
}

export function todayTotalTokens(snapshot: ProviderSnapshot): number {
  return snapshot.today?.totalTokens ?? 0
}
