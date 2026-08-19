import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bucketDisplayName,
  codexSnapshots,
  codexVisibleSnapshots,
  decodeCodexRateLimitStatus,
  decodeLimitStatus,
  planDisplay,
  scopedLimitEntries,
  spendUsedPercent,
  tierMultiplier,
  windowResetDate,
} from '../src/core/limits/models.js'
import {
  LimitsError,
  fetchClaudeLimits,
  isAccountOAuthMissing,
  isExpired,
  parseCredential,
  retryAfterSeconds,
} from '../src/core/limits/claude.js'
import { CodexRPCError, jsonRPCResult, requestLines } from '../src/core/limits/codex.js'
import {
  indicatorFromComponent,
  indicatorFromStatuspage,
  parseComponent,
  parseStatus,
  fetchProviderStatuses,
} from '../src/core/limits/status.js'
import { candyEligibleWindows, limitsReady, windowClass } from '../src/core/limits/windows.js'
import {
  LIMITS_INTERVAL_MS,
  LimitsPoller,
  highestUtilization,
  isLimitWarning,
} from '../src/core/limits/poller.js'
import { grantCandies } from '../src/core/companion/shop.js'
import { freshCompanionState } from '../src/core/companion/model.js'

describe('claude limit decoding', () => {
  it('reads the legacy windows by their wire names', () => {
    const status = decodeLimitStatus({
      five_hour: { utilization: 42.5, resets_at: '2026-07-03T12:00:00Z' },
      seven_day: { utilization: 10 },
    })
    expect(status?.fiveHour?.utilization).toBe(42.5)
    expect(status?.sevenDay?.utilization).toBe(10)
    expect(windowResetDate(status!.fiveHour!)).toBe(Date.UTC(2026, 6, 3, 12))
    expect(windowResetDate(status!.sevenDay!)).toBeUndefined()
  })

  it('reads the new limits[] entries including the scoped model name', () => {
    const status = decodeLimitStatus({
      limits: [
        { kind: 'session', percent: 5 },
        {
          kind: 'weekly_scoped',
          percent: 80,
          is_active: true,
          scope: { model: { display_name: 'Opus 5' } },
        },
      ],
    })
    expect(status?.limits).toHaveLength(2)
    expect(status?.limits?.[1]?.scope?.model?.displayName).toBe('Opus 5')
    expect(status?.limits?.[1]?.isActive).toBe(true)
  })

  // session/weekly_all duplicate the legacy rows, so showing both would list the same window
  // twice — unless the legacy fields are absent, in which case they are all there is.
  it('drops entries the legacy rows already show, and keeps them when there are no legacy rows', () => {
    const withLegacy = decodeLimitStatus({
      five_hour: { utilization: 1 },
      limits: [{ kind: 'session' }, { kind: 'weekly_all' }, { kind: 'weekly_scoped' }],
    })!
    expect(scopedLimitEntries(withLegacy).map((e) => e.kind)).toEqual(['weekly_scoped'])

    const newOnly = decodeLimitStatus({ limits: [{ kind: 'session' }, { kind: 'weekly_scoped' }] })!
    expect(scopedLimitEntries(newOnly).map((e) => e.kind)).toEqual(['session', 'weekly_scoped'])
  })

  it('survives a response that is not the shape we expect', () => {
    expect(decodeLimitStatus(null)).toBeUndefined()
    expect(decodeLimitStatus([1, 2])).toBeUndefined()
    expect(decodeLimitStatus({ five_hour: 'nonsense', limits: 'nope' })).toEqual({})
  })

  // The multiplier is found by scanning the parts, not by special-casing "max": a tier
  // without one is not an error, it simply has nothing to append.
  it('builds the plan label from the subscription and the tier multiplier', () => {
    expect(tierMultiplier('default_claude_max_20x')).toBe('20x')
    expect(tierMultiplier('default_claude_pro')).toBeUndefined()
    expect(tierMultiplier('claude_xx')).toBeUndefined() // "xx" is not a multiplier
    expect(planDisplay({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })).toBe(
      'Max 20x',
    )
    expect(planDisplay({ subscriptionType: 'pro', rateLimitTier: 'default_claude_pro' })).toBe('Pro')
    expect(planDisplay({ rateLimitTier: 'default_claude_max_20x' })).toBeUndefined()
  })
})

describe('claude credentials', () => {
  const oauth = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ claudeAiOauth: { accessToken: 'tok', ...extra } })

  it('reads the token and the plan fields', () => {
    const credential = parseCredential(oauth({ subscriptionType: 'max', rateLimitTier: 't' }))
    expect(credential).toMatchObject({
      accessToken: 'tok',
      subscriptionType: 'max',
      rateLimitTier: 't',
    })
  })

  it('accepts expiry in seconds, milliseconds and as a string', () => {
    const seconds = 1_800_000_000
    expect(parseCredential(oauth({ expiresAt: seconds }))?.expiresAt).toBe(seconds * 1000)
    expect(parseCredential(oauth({ expiresAt: seconds * 1000 }))?.expiresAt).toBe(seconds * 1000)
    expect(parseCredential(oauth({ expiresAt: String(seconds) }))?.expiresAt).toBe(seconds * 1000)
    expect(parseCredential(oauth({ expiresAt: 0 }))?.expiresAt).toBeUndefined()
  })

  // A minute of headroom, so a token is not spent the instant before the server rejects it.
  it('treats a token expiring within the minute as expired', () => {
    const now = 1_000_000
    expect(isExpired({ accessToken: 't', expiresAt: now + 90_000 }, now)).toBe(false)
    expect(isExpired({ accessToken: 't', expiresAt: now + 30_000 }, now)).toBe(true)
    expect(isExpired({ accessToken: 't' }, now)).toBe(false) // no expiry means no expiry
  })

  // An explicit JSON null is a logged-out account and must read as "log in again"; testing
  // for `undefined` would call it "no credentials" and send the user looking for a file that
  // is right there.
  it('distinguishes a logged-out account from broken JSON', () => {
    expect(isAccountOAuthMissing(JSON.stringify({ claudeAiOauth: null }))).toBe(true)
    expect(isAccountOAuthMissing(JSON.stringify({ mcpOAuth: {} }))).toBe(true)
    expect(isAccountOAuthMissing(oauth())).toBe(false)
    expect(isAccountOAuthMissing('{ not json')).toBe(false) // a format error, not a logout
  })

  it('parses only a plain seconds Retry-After, capped at an hour', () => {
    expect(retryAfterSeconds('30')).toBe(30)
    expect(retryAfterSeconds('  60 ')).toBe(60)
    expect(retryAfterSeconds('99999')).toBe(3600)
    expect(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined()
    expect(retryAfterSeconds('0')).toBeUndefined()
    expect(retryAfterSeconds(null)).toBeUndefined()
  })
})

describe('claude limits fetch', () => {
  function homeWith(contents?: string): string {
    const home = mkdtempSync(join(tmpdir(), 'ptb-cred-'))
    if (contents !== undefined) {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', '.credentials.json'), contents, 'utf8')
    }
    return home
  }

  const response = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...init.headers },
    })

  it('injects the plan from the credential, which the endpoint never reports', async () => {
    const home = homeWith(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok',
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      }),
    )
    const status = await fetchClaudeLimits({
      home,
      fetcher: async () => response({ five_hour: { utilization: 12 } }),
    })
    expect(status.fiveHour?.utilization).toBe(12)
    expect(planDisplay(status)).toBe('Max 20x')
  })

  it('sends the bearer token and the oauth beta header', async () => {
    const home = homeWith(JSON.stringify({ claudeAiOauth: { accessToken: 'secret' } }))
    let seen: Headers | undefined
    await fetchClaudeLimits({
      home,
      fetcher: async (_url, init) => {
        seen = new Headers(init?.headers)
        return response({})
      },
    })
    expect(seen?.get('Authorization')).toBe('Bearer secret')
    expect(seen?.get('anthropic-beta')).toBe('oauth-2025-04-20')
  })

  it('reports a logged-out account as needing a re-login, not as missing credentials', async () => {
    const home = homeWith(JSON.stringify({ claudeAiOauth: null }))
    await expect(fetchClaudeLimits({ home, fetcher: async () => response({}) })).rejects.toMatchObject({
      failure: { reason: 'missingAccountOAuth' },
    })
  })

  it('reports an absent file as missing credentials', async () => {
    await expect(
      fetchClaudeLimits({ home: homeWith(), fetcher: async () => response({}) }),
    ).rejects.toMatchObject({ failure: { reason: 'noCredentials' } })
  })

  it('carries the Retry-After through a 429', async () => {
    const home = homeWith(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    const error = await fetchClaudeLimits({
      home,
      fetcher: async () => response({}, { status: 429, headers: { 'Retry-After': '45' } }),
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LimitsError)
    expect((error as LimitsError).failure).toEqual({ reason: 'rateLimited', retryAfter: 45 })
  })

  it('reports a non-200 with its status', async () => {
    const home = homeWith(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    await expect(
      fetchClaudeLimits({ home, fetcher: async () => response({}, { status: 401 }) }),
    ).rejects.toMatchObject({ failure: { reason: 'httpStatus', status: 401 } })
  })

  it('reports a transport failure without throwing something unrecognisable', async () => {
    const home = homeWith(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    await expect(
      fetchClaudeLimits({
        home,
        fetcher: async () => {
          throw new Error('ECONNRESET')
        },
      }),
    ).rejects.toMatchObject({ failure: { reason: 'network' } })
  })
})

describe('codex limit decoding', () => {
  it('reads a bucket with both windows', () => {
    const status = decodeCodexRateLimitStatus({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 30, windowDurationMins: 300 },
        secondary: { usedPercent: 70, windowDurationMins: 10080 },
      },
    })
    expect(status?.rateLimits.primary?.usedPercent).toBe(30)
    expect(status?.rateLimits.secondary?.windowDurationMins).toBe(10080)
  })

  // The server files a snapshot with no limitId under the "codex" key, which is the one
  // already at the top level — merging without that rule lists the same bucket twice.
  it('merges the extra buckets without duplicating the top-level one', () => {
    const status = decodeCodexRateLimitStatus({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } },
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: { usedPercent: 1 } },
        codex_other: { limitId: 'codex_other', primary: { usedPercent: 2 } },
      },
    })!
    expect(codexSnapshots(status).map((s) => s.limitId)).toEqual(['codex', 'codex_other'])
  })

  it('drops buckets with nothing to show', () => {
    const status = decodeCodexRateLimitStatus({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } },
      rateLimitsByLimitId: { empty: { limitId: 'empty', planType: 'plus' } },
    })!
    expect(codexVisibleSnapshots(status).map((s) => s.limitId)).toEqual(['codex'])
  })

  it('names a bucket from its id when it has no name', () => {
    expect(bucketDisplayName({ limitId: 'codex_other' })).toBe('Codex other')
    expect(bucketDisplayName({ limitName: 'gpt_5' })).toBe('Gpt 5')
    expect(bucketDisplayName({})).toBe('Codex')
  })

  it('derives the spend cap percentage from what remains', () => {
    expect(spendUsedPercent({ limit: '$10', remainingPercent: 25, resetsAt: 0, used: '$7.50' })).toBe(75)
    expect(spendUsedPercent({ limit: '$10', remainingPercent: -5, resetsAt: 0, used: '$11' })).toBe(100)
  })

  it('returns nothing when there is no rateLimits object at all', () => {
    expect(decodeCodexRateLimitStatus({})).toBeUndefined()
    expect(decodeCodexRateLimitStatus(null)).toBeUndefined()
  })
})

describe('codex json-rpc exchange', () => {
  it('sends initialize, initialized and the read, with initialized carrying no id', () => {
    const lines = requestLines('1.2.3').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map((l) => l['method'])).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ])
    expect(lines[1]!['id']).toBeUndefined()
    expect(lines[2]!['id']).toBe(1)
  })

  it('picks the reply out of interleaved notifications and log noise', () => {
    const raw = [
      'starting app-server…',
      JSON.stringify({ method: 'session/update', params: {} }),
      JSON.stringify({ id: 0, result: { ok: true } }),
      JSON.stringify({ id: 1, result: { rateLimits: { limitId: 'codex' } } }),
    ].join('\n')
    expect(jsonRPCResult(raw, 1)).toEqual({ rateLimits: { limitId: 'codex' } })
  })

  // The tail of the buffer is routinely half a line while the reply is still arriving.
  it('ignores a partially written trailing line', () => {
    expect(jsonRPCResult('{"id":1,"resu', 1)).toBeUndefined()
    expect(jsonRPCResult(`${JSON.stringify({ id: 1, result: 1 })}\n{"id":1,"res`, 1)).toBe(1)
  })

  it('raises the server error rather than waiting out the timeout', () => {
    const raw = JSON.stringify({ id: 1, error: { message: 'not logged in' } })
    expect(() => jsonRPCResult(raw, 1)).toThrow(CodexRPCError)
    expect(() => jsonRPCResult(raw, 1)).toThrow('not logged in')
  })
})

describe('provider status', () => {
  it('maps the statuspage indicator, keeping operational distinct from absence', () => {
    expect(indicatorFromStatuspage('none')).toBe('operational')
    expect(indicatorFromStatuspage('major')).toBe('major')
    expect(indicatorFromStatuspage('who knows')).toBe('unknown')
  })

  it('maps a component status', () => {
    expect(indicatorFromComponent('operational')).toBe('operational')
    expect(indicatorFromComponent('degraded_performance')).toBe('minor')
    expect(indicatorFromComponent('major_outage')).toBe('critical')
    expect(indicatorFromComponent('brand_new_state')).toBe('unknown')
  })

  // An unrelated product's outage must not surface as a Codex warning, which is exactly what
  // reading the company-wide indicator would do.
  it('reads the named component and ignores the company-wide banner', () => {
    const summary = {
      status: { indicator: 'critical', description: 'Image generation down' },
      components: [
        { name: 'Image generation', status: 'major_outage' },
        { name: 'Codex API', status: 'operational' },
      ],
    }
    expect(parseComponent(summary, 'Codex API')).toEqual({
      indicator: 'operational',
      description: 'Codex API',
    })
    expect(parseStatus(summary)?.indicator).toBe('critical')
  })

  it('matches the component name case-insensitively and reports nothing when absent', () => {
    const summary = { components: [{ name: 'claude code', status: 'partial_outage' }] }
    expect(parseComponent(summary, 'Claude Code')?.indicator).toBe('major')
    expect(parseComponent(summary, 'Codex API')).toBeUndefined()
    expect(parseComponent({}, 'Codex API')).toBeUndefined()
  })

  // A dropped request must leave the caller's last known status alone rather than replacing
  // it with "unknown".
  it('omits a provider whose lookup failed instead of reporting it unknown', async () => {
    const statuses = await fetchProviderStatuses(
      async (url) =>
        String(url).includes('claude')
          ? new Response(JSON.stringify({ components: [{ name: 'C', status: 'operational' }] }))
          : new Response('nope', { status: 503 }),
      [
        { id: 'claude_code', url: 'https://claude.test', componentName: 'C' },
        { id: 'codex', url: 'https://openai.test', componentName: 'C' },
      ],
    )
    expect(Object.keys(statuses)).toEqual(['claude_code'])
  })
})

describe('candy-eligible windows', () => {
  it('classifies anything past a day as weekly, and an unknown duration conservatively', () => {
    expect(windowClass(300)).toBe('session')
    expect(windowClass(1440)).toBe('session')
    expect(windowClass(1441)).toBe('weekly')
    expect(windowClass(undefined)).toBe('session')
  })

  it('builds one window per Claude legacy field and per Codex bucket slot', () => {
    const windows = candyEligibleWindows(
      {
        claude: { fiveHour: { utilization: 50 }, sevenDay: { utilization: 20 } },
        codex: {
          rateLimits: {
            limitId: 'codex',
            primary: { usedPercent: 10, windowDurationMins: 300 },
            secondary: { usedPercent: 90, windowDurationMins: 10080 },
          },
        },
      },
      'en',
    )
    expect(windows.map((w) => w.key)).toEqual([
      'claude.fiveHour',
      'claude.sevenDay',
      'codex.codex.primary',
      'codex.codex.secondary',
    ])
    expect(windows.map((w) => w.kind)).toEqual(['session', 'weekly', 'session', 'weekly'])
    expect(windows[2]?.name).toBe('Codex 5-hour session')
  })

  // Each excluded window sits inside a headline window that already grants, so including it
  // would pay twice for a single exhaustion.
  it('excludes scoped weekly windows and the Codex spend cap', () => {
    const windows = candyEligibleWindows(
      {
        claude: {
          fiveHour: { utilization: 10 },
          sevenDayOpus: { utilization: 100 },
          sevenDaySonnet: { utilization: 100 },
          limits: [{ kind: 'weekly_scoped', percent: 100 }],
        },
        codex: {
          rateLimits: {
            limitId: 'codex',
            individualLimit: { limit: '$5', remainingPercent: 0, resetsAt: 0, used: '$5' },
          },
        },
      },
      'en',
    )
    expect(windows.map((w) => w.key)).toEqual(['claude.fiveHour'])
  })

  it('is empty for a user with no provider that reports limits', () => {
    expect(candyEligibleWindows({}, 'en')).toEqual([])
    expect(limitsReady({})).toBe(false)
    expect(limitsReady({ codex: { rateLimits: {} } })).toBe(true)
  })

  // The end-to-end reason this module exists: real windows reaching the shop as candies.
  it('feeds grants: a weekly exhaustion becomes candies once, and re-arms below 100%', () => {
    const lang = 'en' as const
    const exhausted = { claude: { fiveHour: { utilization: 100 }, sevenDay: { utilization: 100 } } }
    // First run seeds without granting, so installing mid-window does not pay out.
    const seeded = grantCandies(freshCompanionState(), candyEligibleWindows(exhausted, lang), true)
    expect(seeded.grants).toEqual([])

    const cleared = grantCandies(
      seeded.state,
      candyEligibleWindows(
        { claude: { fiveHour: { utilization: 5 }, sevenDay: { utilization: 5 } } },
        lang,
      ),
      true,
    )
    const granted = grantCandies(cleared.state, candyEligibleWindows(exhausted, lang), true)
    expect(granted.grants.map((g) => g.windowKey)).toEqual(['claude.fiveHour', 'claude.sevenDay'])
    expect(granted.grants[1]!.count).toBeGreaterThan(granted.grants[0]!.count) // weekly pays more

    // Still at 100% on the next refresh: the same exhaustion must not pay again.
    expect(grantCandies(granted.state, candyEligibleWindows(exhausted, lang), true).grants).toEqual([])
  })
})

// A regression guard for the shape of the CLAUDE_CONFIG_DIR input, not for its value.
// Resolving it inside this module would put a login-shell spawn on the polling path, and
// `undefined` must mean "the user set none" rather than "go and look it up".
describe('relocated claude config', () => {
  it('withholds the re-login verdict when the user moved their config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ptb-cred-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ mcpOAuth: {} }), 'utf8')
    const fetcher = async () => new Response('{}')

    await expect(fetchClaudeLimits({ home, fetcher })).rejects.toMatchObject({
      failure: { reason: 'missingAccountOAuth' },
    })
    await expect(
      fetchClaudeLimits({ home, fetcher, configDirValue: '/elsewhere/.claude' }),
    ).rejects.toMatchObject({ failure: { reason: 'noCredentials' } })
    // A blank export is not a relocation.
    await expect(fetchClaudeLimits({ home, fetcher, configDirValue: '  ' })).rejects.toMatchObject({
      failure: { reason: 'missingAccountOAuth' },
    })
  })
})

describe('limit warnings and the compact number', () => {
  const codexWith = (individualLimit: { remainingPercent: number }) => ({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 10 },
      individualLimit: { limit: '$5', resetsAt: 0, used: '$5', ...individualLimit },
    },
  })

  // The case a session-only check misses: a comfortable session while the weekly sits at
  // 100% must still warn.
  it('warns on any window, not only the session one', () => {
    expect(isLimitWarning({ claude: { fiveHour: { utilization: 10 } } })).toBe(false)
    expect(
      isLimitWarning({ claude: { fiveHour: { utilization: 10 }, sevenDay: { utilization: 100 } } }),
    ).toBe(true)
    expect(isLimitWarning({ claude: { limits: [{ kind: 'weekly_scoped', percent: 99 }] } })).toBe(true)
  })

  // Running out of credit stops you as dead as a rate limit, so the warning counts the spend
  // cap — but the compact number reads as a rate, so it must not.
  it('counts the Codex spend cap in the warning and excludes it from the compact number', () => {
    const sources = { codex: codexWith({ remainingPercent: 0 }) }
    expect(isLimitWarning(sources)).toBe(true)
    expect(highestUtilization(sources, new Set(['codex']))).toBe(10)
  })

  it('reports the compact number only for providers used today', () => {
    const sources = {
      claude: { fiveHour: { utilization: 90 } },
      codex: { rateLimits: { limitId: 'codex', primary: { usedPercent: 20 } } },
    }
    expect(highestUtilization(sources, new Set(['claude_code', 'codex']))).toBe(90)
    expect(highestUtilization(sources, new Set(['codex']))).toBe(20)
    expect(highestUtilization(sources, new Set())).toBeUndefined()
  })
})

describe('limits poller', () => {
  const claudeHome = () => mkdtempSync(join(tmpdir(), 'ptb-poll-'))

  function homeWithToken(): string {
    const home = claudeHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
      'utf8',
    )
    return home
  }

  it('never blocks a scan: refresh returns what is known and fetches for next time', async () => {
    const poller = new LimitsPoller({
      claude: {
        home: homeWithToken(),
        fetcher: async () => new Response('{"five_hour":{"utilization":7}}'),
      },
      codex: { home: claudeHome() },
      fetcher: async () => new Response('{"components":[]}'),
    })
    expect(poller.refresh().ready).toBe(false) // nothing known yet, and it did not wait
    await poller.refreshNow()
    expect(poller.snapshot().sources.claude?.fiveHour?.utilization).toBe(7)
  })

  // The limits did not become unknown; we just could not ask. Blanking the section would make
  // one dropped request look like a plan change.
  it('keeps the last good values when a fetch fails', async () => {
    let ok = true
    const poller = new LimitsPoller({
      claude: {
        home: homeWithToken(),
        fetcher: async () =>
          ok ? new Response('{"five_hour":{"utilization":7}}') : new Response('', { status: 500 }),
      },
      codex: { home: claudeHome() },
      fetcher: async () => new Response('{"components":[]}'),
    })
    await poller.refreshNow()
    ok = false
    await poller.refreshNow()
    expect(poller.snapshot().sources.claude?.fiveHour?.utilization).toBe(7)
  })

  it('honours a Retry-After before asking again', async () => {
    let now = 1_000_000
    let calls = 0
    const poller = new LimitsPoller({
      now: () => now,
      claude: {
        home: homeWithToken(),
        fetcher: async () => {
          calls += 1
          // Deliberately longer than the normal interval — a backoff equal to it would prove
          // nothing about which of the two decided the next attempt.
          return new Response('', { status: 429, headers: { 'Retry-After': '1800' } })
        },
      },
      codex: { home: claudeHome() },
      fetcher: async () => new Response('{"components":[]}'),
    })
    await poller.refreshNow()
    expect(calls).toBe(1)

    // Due by the normal interval, but not by the backoff the server asked for.
    // The background refresh is fire-and-forget by design, so give its promise chain — file
    // reads included — real turns of the loop before reading the counter.
    const settle = async () => {
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r))
    }

    now += LIMITS_INTERVAL_MS + 1
    poller.refresh()
    await settle()
    expect(calls).toBe(1)

    now += 1_800_000
    poller.refresh()
    await settle()
    expect(calls).toBe(2)
  })
})
