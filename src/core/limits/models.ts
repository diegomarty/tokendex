/**
 * Official limit models.
 *
 * These are **display-only** signals from unofficial endpoints. Nothing here feeds the token
 * totals: if a fetch fails the limit section simply disappears, and the numbers the user came
 * for are untouched. That containment is the whole design, so keep decoding total —
 * every field optional, every unknown shape degrading to "no limit known" rather than throwing.
 */

import { parseISO8601 } from '../iso8601.js'

// MARK: - Claude (oauth/usage)

export interface LimitWindow {
  utilization?: number
  resetsAt?: string
}

export interface OAuthLimitEntry {
  kind?: string
  group?: string
  percent?: number
  severity?: string
  resetsAt?: string
  scope?: { model?: { displayName?: string } }
  isActive?: boolean
}

export interface LimitStatus {
  fiveHour?: LimitWindow
  sevenDay?: LimitWindow
  sevenDayOpus?: LimitWindow
  sevenDaySonnet?: LimitWindow
  limits?: OAuthLimitEntry[]
  /** Injected from the OAuth credential, not from the usage response. */
  subscriptionType?: string
  rateLimitTier?: string
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function decodeWindow(raw: unknown): LimitWindow | undefined {
  const object = record(raw)
  if (object === undefined) return undefined
  const window: LimitWindow = {}
  const utilization = num(object['utilization'])
  if (utilization !== undefined) window.utilization = utilization
  const resetsAt = str(object['resets_at'])
  if (resetsAt !== undefined) window.resetsAt = resetsAt
  return window
}

function decodeEntry(raw: unknown): OAuthLimitEntry | undefined {
  const object = record(raw)
  if (object === undefined) return undefined
  const entry: OAuthLimitEntry = {}
  for (const [key, field] of [
    ['kind', 'kind'],
    ['group', 'group'],
    ['severity', 'severity'],
    ['resetsAt', 'resets_at'],
  ] as const) {
    const value = str(object[field])
    if (value !== undefined) entry[key] = value
  }
  const percent = num(object['percent'])
  if (percent !== undefined) entry.percent = percent
  if (typeof object['is_active'] === 'boolean') entry.isActive = object['is_active']
  const model = record(record(object['scope'])?.['model'])
  const displayName = str(model?.['display_name'])
  if (displayName !== undefined) entry.scope = { model: { displayName } }
  return entry
}

export function decodeLimitStatus(raw: unknown): LimitStatus | undefined {
  const object = record(raw)
  if (object === undefined) return undefined
  const status: LimitStatus = {}
  for (const [key, field] of [
    ['fiveHour', 'five_hour'],
    ['sevenDay', 'seven_day'],
    ['sevenDayOpus', 'seven_day_opus'],
    ['sevenDaySonnet', 'seven_day_sonnet'],
  ] as const) {
    const window = decodeWindow(object[field])
    if (window !== undefined) status[key] = window
  }
  if (Array.isArray(object['limits'])) {
    status.limits = object['limits'].map(decodeEntry).filter((e): e is OAuthLimitEntry => e !== undefined)
  }
  return status
}

export function windowResetDate(window: LimitWindow | OAuthLimitEntry): number | undefined {
  if (window.resetsAt === undefined) return undefined
  return parseISO8601(window.resetsAt) ?? undefined
}

/**
 * The multiplier token at the end of `rateLimitTier` — `default_claude_max_20x` → `20x`.
 *
 * Found by scanning the underscore-separated parts rather than by matching `max`: a tier
 * without a multiplier (`default_claude_pro`) is not a Max-only special case, it simply has
 * no multiplier to show.
 */
export function tierMultiplier(tier: string): string | undefined {
  for (const part of tier.split('_')) {
    if (!part.endsWith('x')) continue
    const digits = part.slice(0, -1)
    if (digits !== '' && /^\d+$/.test(digits)) return part
  }
  return undefined
}

/** `subscriptionType` plus the tier multiplier — `"Max 20x"`, `"Pro"`, or nothing. */
export function planDisplay(status: LimitStatus): string | undefined {
  const type = status.subscriptionType
  if (type === undefined || type === '') return undefined
  const base = type.charAt(0).toUpperCase() + type.slice(1)
  const multiplier = status.rateLimitTier === undefined ? undefined : tierMultiplier(status.rateLimitTier)
  return multiplier === undefined ? base : `${base} ${multiplier}`
}

/**
 * Entries the legacy fields do not already show.
 *
 * `session` and `weekly_all` duplicate `five_hour` / `seven_day`, so they are filtered out —
 * unless both legacy fields are absent, which means this is a new-shape response and the
 * legacy rows would show nothing at all.
 */
export function scopedLimitEntries(status: LimitStatus): OAuthLimitEntry[] {
  const entries = status.limits ?? []
  if (status.fiveHour === undefined && status.sevenDay === undefined) return entries
  return entries.filter((e) => e.kind !== 'session' && e.kind !== 'weekly_all')
}

// MARK: - Codex (app-server account/rateLimits/read)

export interface CodexRateLimitWindow {
  usedPercent: number
  windowDurationMins?: number
  resetsAt?: number
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

export interface CodexRateLimitStatus {
  rateLimits: CodexRateLimitSnapshot
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot>
}

function decodeCodexWindow(raw: unknown): CodexRateLimitWindow | undefined {
  const object = record(raw)
  const usedPercent = num(object?.['usedPercent'])
  if (object === undefined || usedPercent === undefined) return undefined
  const window: CodexRateLimitWindow = { usedPercent }
  const mins = num(object['windowDurationMins'])
  if (mins !== undefined) window.windowDurationMins = mins
  const resetsAt = num(object['resetsAt'])
  if (resetsAt !== undefined) window.resetsAt = resetsAt
  return window
}

function decodeSnapshot(raw: unknown): CodexRateLimitSnapshot | undefined {
  const object = record(raw)
  if (object === undefined) return undefined
  const snapshot: CodexRateLimitSnapshot = {}
  for (const key of ['limitId', 'limitName', 'planType', 'rateLimitReachedType'] as const) {
    const value = str(object[key])
    if (value !== undefined) snapshot[key] = value
  }
  const primary = decodeCodexWindow(object['primary'])
  if (primary !== undefined) snapshot.primary = primary
  const secondary = decodeCodexWindow(object['secondary'])
  if (secondary !== undefined) snapshot.secondary = secondary

  const credits = record(object['credits'])
  if (credits !== undefined) {
    const c: CodexCreditsSnapshot = {
      hasCredits: credits['hasCredits'] === true,
      unlimited: credits['unlimited'] === true,
    }
    const balance = str(credits['balance'])
    if (balance !== undefined) c.balance = balance
    snapshot.credits = c
  }

  const individual = record(object['individualLimit'])
  const remaining = num(individual?.['remainingPercent'])
  const resets = num(individual?.['resetsAt'])
  if (individual !== undefined && remaining !== undefined && resets !== undefined) {
    snapshot.individualLimit = {
      limit: str(individual['limit']) ?? '',
      remainingPercent: remaining,
      resetsAt: resets,
      used: str(individual['used']) ?? '',
    }
  }
  return snapshot
}

export function decodeCodexRateLimitStatus(raw: unknown): CodexRateLimitStatus | undefined {
  const object = record(raw)
  const top = decodeSnapshot(object?.['rateLimits'])
  if (object === undefined || top === undefined) return undefined
  const status: CodexRateLimitStatus = { rateLimits: top }

  const byId = record(object['rateLimitsByLimitId'])
  if (byId !== undefined) {
    const decoded: Record<string, CodexRateLimitSnapshot> = {}
    for (const [key, value] of Object.entries(byId)) {
      const snapshot = decodeSnapshot(value)
      if (snapshot !== undefined) decoded[key] = snapshot
    }
    status.rateLimitsByLimitId = decoded
  }
  return status
}

/** A spend cap has no percentage of its own; it is derived from what remains. */
export function spendUsedPercent(limit: CodexSpendControlLimit): number {
  return Math.max(0, Math.min(100, 100 - limit.remainingPercent))
}

export function hasVisibleLimit(snapshot: CodexRateLimitSnapshot): boolean {
  return (
    snapshot.primary !== undefined ||
    snapshot.secondary !== undefined ||
    snapshot.individualLimit !== undefined
  )
}

/** `"codex_other"` → `"Codex other"`. */
export function bucketDisplayName(snapshot: CodexRateLimitSnapshot): string {
  const raw = snapshot.limitName ?? snapshot.limitId ?? 'codex'
  const spaced = raw.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Every bucket, mirroring the Codex TUI.
 *
 * The server puts the "codex" bucket at the top level and the rest only under
 * `rateLimitsByLimitId`, so both have to be merged — and a snapshot without a `limitId` is
 * filed under the `"codex"` key, which is the same one already at the top level. Sorting is
 * not cosmetic: object key order would otherwise decide which duplicate survives.
 */
export function codexSnapshots(status: CodexRateLimitStatus): CodexRateLimitSnapshot[] {
  const result = [status.rateLimits]
  const byId = status.rateLimitsByLimitId
  if (byId === undefined) return result

  const primaryKey = status.rateLimits.limitId ?? 'codex'
  for (const [limitId, snapshot] of Object.entries(byId).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (limitId === primaryKey) continue
    if (snapshot.limitId !== undefined && snapshot.limitId === status.rateLimits.limitId) continue
    result.push(snapshot)
  }
  return result
}

export function codexVisibleSnapshots(status: CodexRateLimitStatus): CodexRateLimitSnapshot[] {
  return codexSnapshots(status).filter(hasVisibleLimit)
}
