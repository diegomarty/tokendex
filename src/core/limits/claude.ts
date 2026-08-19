/**
 * Claude official limits.
 *
 * **The credential is read from the file, and only from the file.** That is deliberate. The
 * macOS login keychain entry (`Claude Code-credentials`) is not portable — Linux and Windows
 * have no such store — and reading it costs a system password prompt that blocks for ~13
 * seconds each time it appears, a few times a day. Paying that to decorate a display-only
 * section is not a trade worth making. The consequence is bounded: a macOS user whose token
 * lives only in the keychain sees no limit section, which is what anyone sees before the
 * first successful fetch anyway.
 *
 * The endpoint is unofficial. A failure here must never touch the token totals — the caller
 * hides the limit section and moves on.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as AppPaths from '../appPaths.js'
import { type LimitStatus, decodeLimitStatus } from './models.js'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REQUEST_TIMEOUT_MS = 15_000

export type LimitsFailure =
  | { reason: 'noCredentials' }
  /** The file parses but carries no account OAuth — a re-login, not a format error. */
  | { reason: 'missingAccountOAuth' }
  | { reason: 'httpStatus'; status: number }
  | { reason: 'rateLimited'; retryAfter?: number }
  | { reason: 'network'; message: string }

export class LimitsError extends Error {
  constructor(readonly failure: LimitsFailure) {
    super(failure.reason)
    this.name = 'LimitsError'
  }
}

export interface Credential {
  accessToken: string
  expiresAt?: number
  subscriptionType?: string
  rateLimitTier?: string
}

/**
 * `null` is a value, and `undefined` is absence — telling them apart is the whole point.
 *
 * Testing `json['claudeAiOauth'] === undefined` would read a logged-out `"claudeAiOauth": null`
 * as "present", so a logged-out user gets "no credentials" instead of "log in again". The test
 * is whether it is an object.
 */
export function isAccountOAuthMissing(raw: string): boolean {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return false // broken JSON is a format error, not a logged-out account
  }
  if (typeof json !== 'object' || json === null) return false
  const oauth = (json as Record<string, unknown>)['claudeAiOauth']
  return typeof oauth !== 'object' || oauth === null || Array.isArray(oauth)
}

/** Milliseconds, accepting the seconds/milliseconds and string forms the file has carried. */
function expiryMillis(raw: unknown): number | undefined {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(value) || value <= 0) return undefined
  return value > 10_000_000_000 ? value : value * 1000
}

export function parseCredential(raw: string): Credential | undefined {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null) return undefined
  const oauth = (json as Record<string, unknown>)['claudeAiOauth']
  if (typeof oauth !== 'object' || oauth === null || Array.isArray(oauth)) return undefined
  const fields = oauth as Record<string, unknown>

  const token = fields['accessToken']
  if (typeof token !== 'string' || token === '') return undefined

  const credential: Credential = { accessToken: token }
  const expiresAt = expiryMillis(fields['expiresAt'])
  if (expiresAt !== undefined) credential.expiresAt = expiresAt
  for (const key of ['subscriptionType', 'rateLimitTier'] as const) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') credential[key] = value
  }
  return credential
}

/** A minute of headroom, so a token is not spent the instant before the server rejects it. */
export function isExpired(credential: Credential, now: number = Date.now()): boolean {
  return credential.expiresAt !== undefined && credential.expiresAt <= now + 60_000
}

export function credentialsPath(home: string = AppPaths.home()): string {
  return join(home, '.claude', '.credentials.json')
}

/**
 * Whether the credential file exists but holds no account OAuth.
 *
 * Users who moved their config (`CLAUDE_CONFIG_DIR`) are excluded from the verdict: this path
 * hardcodes the default location, and a leftover file there would show a logged-in user a
 * re-login banner on every poll. Where the moved credential actually lives has never been
 * confirmed, so rather than guess, the verdict is simply withheld.
 *
 * `configDirValue` is **passed in**, never looked up here, and `undefined` means "no value" —
 * not "go and find one". Resolving it internally would make this path spawn a login shell to
 * pick the wording of one message, on a timer — a cost this path refuses to pay.
 */
async function shouldAdviseRelogin(
  home: string | undefined,
  configDirValue: string | undefined,
): Promise<boolean> {
  if (configDirValue !== undefined && configDirValue.trim() !== '') return false
  try {
    return isAccountOAuthMissing(await fs.readFile(credentialsPath(home), 'utf8'))
  } catch {
    return false
  }
}

export async function readCredential(home?: string): Promise<Credential | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(credentialsPath(home), 'utf8')
  } catch {
    return undefined
  }
  const credential = parseCredential(raw)
  return credential !== undefined && !isExpired(credential) ? credential : undefined
}

/** Seconds only. An HTTP-date or a nonsense value falls back to the caller's own backoff. */
export function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.min(seconds, 3600) // a server may say a day; an hour is enough
}

export type Fetcher = typeof fetch

async function fetchStatus(accessToken: string, fetcher: Fetcher): Promise<LimitStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetcher(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    })
  } catch (e) {
    throw new LimitsError({
      reason: 'network',
      message: e instanceof Error ? e.message : String(e),
    })
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response.headers.get('Retry-After'))
    throw new LimitsError({
      reason: 'rateLimited',
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    })
  }
  if (response.status !== 200) {
    throw new LimitsError({ reason: 'httpStatus', status: response.status })
  }

  const status = decodeLimitStatus(await response.json())
  if (status === undefined) throw new LimitsError({ reason: 'network', message: 'unreadable response' })
  return status
}

export interface ClaudeLimitsOptions {
  home?: string
  fetcher?: Fetcher
  /** `CLAUDE_CONFIG_DIR` as already resolved by the caller. Absent means the user set none. */
  configDirValue?: string | undefined
}

/**
 * The plan comes from the credential, not from the usage response — the endpoint does not
 * report it, and it is already in hand from the token read.
 */
export async function fetchClaudeLimits(options: ClaudeLimitsOptions = {}): Promise<LimitStatus> {
  const credential = await readCredential(options.home)
  if (credential === undefined) {
    throw new LimitsError({
      reason: (await shouldAdviseRelogin(options.home, options.configDirValue))
        ? 'missingAccountOAuth'
        : 'noCredentials',
    })
  }

  const status = await fetchStatus(credential.accessToken, options.fetcher ?? fetch)
  if (credential.subscriptionType !== undefined) status.subscriptionType = credential.subscriptionType
  if (credential.rateLimitTier !== undefined) status.rateLimitTier = credential.rateLimitTier
  return status
}
