/**
 * Provider incident status.
 *
 * Display-only, and deliberately never a notification: during a Claude or OpenAI outage the
 * numbers go stale or zero, and without this the user reads that as the extension being
 * broken. Turning it into an alert would just add spam on top of the limit warnings.
 */

const SUMMARY_TIMEOUT_MS = 10_000

/**
 * `operational` rather than `none` — the statuspage string is `"none"`, but a member named
 * `none` collides with absence at every call site.
 */
export type StatusIndicator = 'operational' | 'minor' | 'major' | 'critical' | 'maintenance' | 'unknown'

const INDICATORS = new Set<string>(['minor', 'major', 'critical', 'maintenance'])

export function indicatorFromStatuspage(raw: string): StatusIndicator {
  if (raw === 'none') return 'operational'
  return INDICATORS.has(raw) ? (raw as StatusIndicator) : 'unknown'
}

export function indicatorFromComponent(raw: string): StatusIndicator {
  switch (raw) {
    case 'operational':
      return 'operational'
    case 'degraded_performance':
      return 'minor'
    case 'partial_outage':
      return 'major'
    case 'major_outage':
      return 'critical'
    case 'under_maintenance':
      return 'maintenance'
    default:
      return 'unknown'
  }
}

export interface ProviderStatus {
  indicator: StatusIndicator
  description: string
}

export function hasIssue(status: ProviderStatus): boolean {
  return status.indicator !== 'operational'
}

export interface StatusEndpoint {
  id: string
  url: string
  componentName: string
}

/** Only the providers that publish a statuspage.io feed. The local Codex CLI rides on Codex API. */
export const STATUS_ENDPOINTS: StatusEndpoint[] = [
  {
    id: 'claude_code',
    url: 'https://status.claude.com/api/v2/summary.json',
    componentName: 'Claude Code',
  },
  {
    id: 'codex',
    url: 'https://status.openai.com/api/v2/summary.json',
    componentName: 'Codex API',
  },
]

/**
 * Reads **one named component** out of summary.json, not the company-wide indicator.
 *
 * A vendor's global indicator covers every product they run, so an image-generation outage
 * would otherwise surface as a Codex warning here. If the named component is operational, the
 * answer is operational whatever the banner says.
 */
export function parseComponent(raw: unknown, componentName: string): ProviderStatus | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const components = (raw as Record<string, unknown>)['components']
  if (!Array.isArray(components)) return undefined
  for (const entry of components) {
    if (typeof entry !== 'object' || entry === null) continue
    const component = entry as Record<string, unknown>
    const name = component['name']
    const status = component['status']
    if (typeof name !== 'string' || typeof status !== 'string') continue
    if (name.toLowerCase() !== componentName.toLowerCase()) continue
    return { indicator: indicatorFromComponent(status), description: name }
  }
  return undefined
}

/** The older `status.json` shape, kept for the top-level indicator. */
export function parseStatus(raw: unknown): ProviderStatus | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const status = (raw as Record<string, unknown>)['status']
  if (typeof status !== 'object' || status === null) return undefined
  const fields = status as Record<string, unknown>
  if (typeof fields['indicator'] !== 'string') return undefined
  return {
    indicator: indicatorFromStatuspage(fields['indicator']),
    description: typeof fields['description'] === 'string' ? fields['description'] : '',
  }
}

async function fetchOne(
  endpoint: StatusEndpoint,
  fetcher: typeof fetch,
): Promise<ProviderStatus | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
  try {
    const response = await fetcher(endpoint.url, {
      headers: { 'User-Agent': 'Tokendex' },
      signal: controller.signal,
    })
    if (response.status !== 200) return undefined
    return parseComponent(await response.json(), endpoint.componentName)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A provider whose lookup failed is **omitted** rather than reported as unknown, so the
 * caller keeps whatever it last knew instead of flickering to "unknown" on one dropped
 * request.
 */
export async function fetchProviderStatuses(
  fetcher: typeof fetch = fetch,
  endpoints: StatusEndpoint[] = STATUS_ENDPOINTS,
): Promise<Record<string, ProviderStatus>> {
  const results = await Promise.all(
    endpoints.map(async (endpoint) => [endpoint.id, await fetchOne(endpoint, fetcher)] as const),
  )
  const out: Record<string, ProviderStatus> = {}
  for (const [id, status] of results) {
    if (status !== undefined) out[id] = status
  }
  return out
}
