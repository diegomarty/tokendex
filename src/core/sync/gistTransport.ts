/**
 * The sync store as one private gist in the player's GitHub account (`docs/sync.md` §4.2).
 *
 * One file per device (`payload.ts` names them), plus a README saying what the gist is, so
 * someone who finds it in their account knows not to delete it. Found again on another machine by
 * its description — the gist id is remembered per machine (`ourData()/sync.json`), so every new
 * machine discovers it once. Two machines opting in at the same moment can each create one;
 * discovery always picks the **oldest**, so both settle on the same gist on their next read.
 *
 * The API has no compare-and-swap on PATCH, and none is needed: no file has two writers. What it
 * does have, measured against real GitHub (2026-10-22), is **409 Conflict for concurrent PATCHes
 * of one gist, even of different files** — three of four refused, every round. Nothing is lost
 * silently, but two devices pushing in the same second is ordinary, so a conflict is retried after
 * a jittered pause. Every write is still read back, and written again once if it did not land.
 *
 * Errors never carry request headers (`transport.ts`): the token must not reach a log.
 */

import { type Fetcher, retryAfterSeconds } from '../limits/claude.js'
import { type ReadResult, type RemoteFile, SyncError, type SyncTransport } from './transport.js'

export const GIST_DESCRIPTION = 'Tokendex sync — managed by the Tokendex VS Code extension'
export const GIST_README_NAME = 'README.md'
const GIST_README = [
  '# Tokendex sync',
  '',
  'This private gist carries your Tokendex game between your computers: one file per device,',
  'written by the Tokendex VS Code extension. Deleting it stops sync; each computer keeps its',
  'own copy of the game and a new gist is created the next time sync runs.',
  '',
].join('\n')

const API_BASE = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 15_000
/** PATCH attempts while GitHub answers 409; then the round fails and the runner backs off. */
const CONFLICT_ATTEMPTS = 6
const CONFLICT_PAUSE_MS = 400
const CONFLICT_PAUSE_CEILING_MS = 8_000
/** Discovery reads at most this many pages of 100 gists. Past 1,000 gists, create a new one. */
const MAX_DISCOVERY_PAGES = 10

export interface GistTransportOptions {
  token: string
  /** The gist found or created earlier on this machine, if any. */
  gistID?: string
  /** Called whenever the gist in use changes, so the host can remember it. */
  onGistID?: (id: string) => void
  fetcher?: Fetcher
  apiBase?: string
  timeoutMs?: number
  /** The pause between conflicting PATCHes; tests make it instant. */
  sleep?: (ms: number) => Promise<void>
  /** For the hourly rediscovery; tests move it by hand. */
  now?: () => number
}

/** How often a remembered gist is checked against discovery (see `read`). */
const REDISCOVER_EVERY_MS = 60 * 60_000

interface GistFile {
  filename?: unknown
  content?: unknown
  truncated?: unknown
  raw_url?: unknown
}

interface GistSummary {
  id?: unknown
  description?: unknown
  public?: unknown
  created_at?: unknown
}

/** `complete`: the whole list was read, so "not found" means not there, not "past the last page". */
interface Discovery {
  oldest: string | undefined
  complete: boolean
}

/** A response read whole — status, headers and body — inside the request's timeout. */
interface Answer {
  status: number
  headers: Headers
  text: string
}

export class GistTransport implements SyncTransport {
  private gistID: string | undefined
  private lastDiscovery: number | undefined
  private readonly fetcher: Fetcher
  private readonly apiBase: string
  private readonly now: () => number

  constructor(private readonly options: GistTransportOptions) {
    this.gistID = options.gistID
    this.fetcher = options.fetcher ?? fetch
    this.apiBase = options.apiBase ?? API_BASE
    this.now = options.now ?? Date.now
  }

  async read(etag?: string): Promise<ReadResult> {
    await this.rediscoverIfDue()
    let answer = await this.request('GET', `/gists/${await this.ensureGist()}`, undefined, etag)
    if (answer.status === 404) {
      // Deleted from under us: find another or start a new one, and read that in full. Once —
      // a gist that vanishes again at once is not something to chase in a loop.
      this.forget()
      answer = await this.request('GET', `/gists/${await this.ensureGist()}`)
      if (answer.status === 404)
        throw new SyncError('notFound', 'the sync gist could not be found or created')
    }
    if (answer.status === 304) return { kind: 'notModified' }
    const unread: string[] = []
    const files = await this.files(parse(answer), unread)
    const newEtag = answer.headers.get('ETag') ?? undefined
    return {
      kind: 'files',
      files,
      ...(newEtag === undefined ? {} : { etag: newEtag }),
      ...(unread.length === 0 ? {} : { unread }),
    }
  }

  /**
   * Writes one file and checks it landed — from the PATCH answer, which is the gist after our
   * write, so a push costs one request rather than a write and a full re-read.
   */
  async write(name: string, text: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await this.patch({ [name]: { content: text } })
      const files = await this.files(parse(answer)).catch(() => [])
      if (files.some((file) => file.name === name && file.text === text)) return
    }
    throw new SyncError('protocol', `the gist did not keep ${name} after two writes`)
  }

  private async patch(files: Record<string, { content: string }>): Promise<Answer> {
    const answer = await this.patchThroughConflicts({ files })
    if (answer.status !== 404) return answer
    this.forget()
    const again = await this.patchThroughConflicts({ files })
    if (again.status === 404)
      throw new SyncError('notFound', 'the sync gist could not be found or created')
    return again
  }

  /**
   * One PATCH, repeated while GitHub refuses it as a conflict with another in flight. The pause
   * doubles and is jittered, so two devices that collided do not collide again in lockstep.
   */
  private async patchThroughConflicts(body: unknown): Promise<Answer> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const pause = Math.min(CONFLICT_PAUSE_MS * 2 ** (attempt - 1), CONFLICT_PAUSE_CEILING_MS)
        await sleep(pause * (0.5 + Math.random()))
      }
      const answer = await this.request('PATCH', `/gists/${await this.ensureGist()}`, body)
      if (answer.status !== 409) return answer
    }
    // Retryable: the runner backs off and the next round tries again.
    throw new SyncError(
      'network',
      `the gist stayed busy for ${CONFLICT_ATTEMPTS} attempts (409 Conflict)`,
    )
  }

  /** The gist's files; a truncated one whose raw URL did not answer goes to `unread`. */
  private async files(body: unknown, unread: string[] = []): Promise<RemoteFile[]> {
    const raw = (body as { files?: unknown } | null)?.files
    if (typeof raw !== 'object' || raw === null) throw new SyncError('protocol', 'a gist without files')
    const files: RemoteFile[] = []
    for (const [key, value] of Object.entries(raw as Record<string, GistFile>)) {
      const name = typeof value.filename === 'string' ? value.filename : key
      let text = typeof value.content === 'string' ? value.content : undefined
      // Large files come back truncated in the gist object; the raw URL serves them whole.
      if ((value.truncated === true || text === undefined) && typeof value.raw_url === 'string') {
        const answer = await this.request('GET', value.raw_url)
        if (answer.status !== 200) {
          unread.push(name)
          continue
        }
        text = answer.text
      }
      if (text !== undefined) files.push({ name, text })
    }
    return files
  }

  private forget(): void {
    this.gistID = undefined
  }

  private async ensureGist(): Promise<string> {
    if (this.gistID !== undefined) return this.gistID
    const id = (await this.discoverNow()).oldest ?? (await this.create())
    this.use(id)
    return id
  }

  /**
   * A remembered gist is not trusted for ever. Two machines that opted in at once can each have
   * created one, and each would then sync alone, silently, with zero peers. So the first read of
   * every transport, and one an hour after, runs discovery again and moves to the oldest gist —
   * where every machine converges. Our own file arrives there on the next push (the engine pushes
   * whenever the gist does not hold it).
   */
  private async rediscoverIfDue(): Promise<void> {
    if (this.gistID === undefined) return // `ensureGist` discovers anyway
    if (this.lastDiscovery !== undefined && this.now() - this.lastDiscovery < REDISCOVER_EVERY_MS) return
    const { oldest, complete } = await this.discoverNow()
    if (oldest !== undefined && oldest !== this.gistID) this.use(oldest)
    // None in this account, after reading its whole list: the remembered gist is another account's
    // — the player signed in as someone else. A secret gist reads for anyone with its id, so
    // keeping it would go on folding that account's game into this one. The list just read is the
    // whole of it, so this account has none: create it, rather than read the list again.
    else if (oldest === undefined && complete) this.use(await this.create())
  }

  private use(id: string): void {
    this.gistID = id
    this.options.onGistID?.(id)
  }

  private async discoverNow(): Promise<Discovery> {
    const found = await this.discover()
    this.lastDiscovery = this.now()
    return found
  }

  /** The oldest of the player's private gists carrying our description, if there is one. */
  private async discover(): Promise<Discovery> {
    const found: { id: string; createdAt: string }[] = []
    let complete = false
    for (let page = 1; page <= MAX_DISCOVERY_PAGES; page++) {
      const answer = await this.request('GET', `/gists?per_page=100&page=${page}`)
      if (answer.status !== 200) break
      const list = parse(answer)
      if (!Array.isArray(list)) throw new SyncError('protocol', 'an unreadable gist list')
      for (const gist of list as GistSummary[]) {
        if (gist.description !== GIST_DESCRIPTION || gist.public !== false) continue
        if (typeof gist.id !== 'string') continue
        found.push({ id: gist.id, createdAt: typeof gist.created_at === 'string' ? gist.created_at : '' })
      }
      if (!/rel="next"/.test(answer.headers.get('Link') ?? '')) {
        complete = true
        break
      }
    }
    found.sort((a, b) =>
      a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.id < b.id ? -1 : 1,
    )
    return { oldest: found[0]?.id, complete }
  }

  private async create(): Promise<string> {
    const answer = await this.request('POST', '/gists', {
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_README_NAME]: { content: GIST_README } },
    })
    const id = (parse(answer) as GistSummary | null)?.id
    if (typeof id !== 'string') throw new SyncError('protocol', 'GitHub created a gist without an id')
    return id
  }

  /**
   * One request, **read whole inside the timeout**: headers and body alike. Clearing the timer when
   * the headers arrived left a body that stalled after them free to hold the round — and the
   * runner, one round at a time — for ever.
   *
   * Returns the answer for the statuses callers decide on (2xx, 304, 404, 409, 422) and throws a
   * `SyncError` for everything else. Messages name the request without the gist id: it is the
   * access control of a secret gist, and error text reaches the output channel.
   */
  private async request(
    method: string,
    pathOrURL: string,
    body?: unknown,
    etag?: string,
  ): Promise<Answer> {
    const url = pathOrURL.startsWith('https://') ? pathOrURL : `${this.apiBase}${pathOrURL}`
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.options.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Tokendex',
    }
    if (etag !== undefined) headers['If-None-Match'] = etag
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const what = `${method} ${
      url.startsWith(this.apiBase)
        ? url.slice(this.apiBase.length).replace(/\/gists\/[^/?]+/, '/gists/…')
        : 'raw file'
    }`

    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`no answer within ${this.options.timeoutMs ?? REQUEST_TIMEOUT_MS} ms`))
      }, this.options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    })
    let answer: Answer
    try {
      answer = await Promise.race([
        (async () => {
          const response = await this.fetcher(url, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
          })
          const text = response.status === 304 ? '' : await response.text()
          return { status: response.status, headers: response.headers, text }
        })(),
        timeout,
      ])
    } catch (e) {
      throw new SyncError('network', `${what}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
    }

    const { status } = answer
    if ((status >= 200 && status < 300) || [304, 404, 409, 422].includes(status)) return answer
    // A 403 is a rate limit when the primary quota is spent, when the server says when to come
    // back, or when its message says so — the secondary limit sends neither header.
    const limited =
      status === 429 ||
      (status === 403 &&
        (answer.headers.get('x-ratelimit-remaining') === '0' ||
          answer.headers.has('Retry-After') ||
          /rate limit/i.test(answer.text)))
    if (limited)
      throw new SyncError('rateLimited', `${what}: rate limited`, rateLimitWait(answer.headers))
    if (status === 401 || status === 403) {
      throw new SyncError('auth', `${what}: GitHub refused the credential (${status})`)
    }
    if (status === 413) throw new SyncError('tooLarge', `${what}: the save is too large for a gist`)
    if (status >= 500) throw new SyncError('network', `${what}: GitHub answered ${status}`)
    throw new SyncError('protocol', `${what}: GitHub answered ${status}`)
  }
}

/** The answer's body as JSON; a body that is not JSON is a protocol error, not a crash. */
function parse(answer: Answer): unknown {
  try {
    return JSON.parse(answer.text)
  } catch {
    throw new SyncError('protocol', `GitHub answered ${answer.status} with a body that is not JSON`)
  }
}

/** Milliseconds to wait, from `Retry-After` or the primary limit's reset time. */
function rateLimitWait(headers: Headers): number | undefined {
  const retryAfter = retryAfterSeconds(headers.get('Retry-After'))
  if (retryAfter !== undefined) return retryAfter * 1000
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now())
  return undefined
}
