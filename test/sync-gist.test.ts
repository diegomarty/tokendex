import { describe, expect, it } from 'vitest'
import { GIST_DESCRIPTION, GIST_README_NAME, GistTransport } from '../src/core/sync/gistTransport.js'
import { SyncError } from '../src/core/sync/transport.js'

const TOKEN = 'gho_secret-token-value'

interface FakeGist {
  id: string
  description: string
  public: boolean
  created_at: string
  files: Map<string, string>
  version: number
}

/**
 * Just enough of the GitHub gist API: list, create, get (with ETag / If-None-Match), patch, and
 * raw URLs for truncated files. Each test bends one behaviour.
 */
class FakeGitHub {
  gists = new Map<string, FakeGist>()
  calls: string[] = []
  /** Statuses to answer instead, consumed in order, keyed by "METHOD path". */
  scripted = new Map<string, Response[]>()
  /** Files whose `content` is cut off in the gist object, as GitHub does for large ones. */
  truncate = new Set<string>()
  /** Gists that exist but are not in the list: another account's, readable by id. */
  unlisted = new Set<string>()
  /** Swallow the next PATCH: answer 200 but keep nothing — a write lost to a concurrent one. */
  losePatches = 0
  authHeaders: string[] = []
  private next = 1

  /** The gist's files as the API shows them: content cut off for the ones marked truncated. */
  filesOf(gist: FakeGist): Record<string, unknown> {
    const files: Record<string, unknown> = {}
    for (const [name, text] of gist.files) {
      const cut = this.truncate.has(name)
      files[name] = {
        filename: name,
        content: cut ? text.slice(0, 3) : text,
        truncated: cut,
        raw_url: `https://raw.example/${gist.id}/${name}`,
      }
    }
    return files
  }

  add(over: Partial<FakeGist> = {}): FakeGist {
    const gist: FakeGist = {
      id: `g${this.next++}`,
      description: GIST_DESCRIPTION,
      public: false,
      created_at: '2026-10-01T00:00:00Z',
      files: new Map(),
      version: 1,
      ...over,
    }
    this.gists.set(gist.id, gist)
    return gist
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const key = `${method} ${url.pathname}`
    this.calls.push(key)
    this.authHeaders.push(String((init?.headers as Record<string, string>)['Authorization']))
    const scripted = this.scripted.get(key)?.shift()
    if (scripted !== undefined) return scripted

    if (url.hostname === 'raw.example') {
      const [, id, name] = url.pathname.split('/')
      const text = this.gists.get(id!)?.files.get(name!)
      return text === undefined ? new Response('', { status: 404 }) : new Response(text)
    }
    if (method === 'GET' && url.pathname === '/gists') {
      const page = Number(url.searchParams.get('page'))
      const all = [...this.gists.values()]
        .filter((g) => !this.unlisted.has(g.id))
        .map((g) => ({
          id: g.id,
          description: g.description,
          public: g.public,
          created_at: g.created_at,
        }))
      const slice = all.slice((page - 1) * 100, page * 100)
      const more = all.length > page * 100
      return Response.json(slice, { headers: more ? { Link: '<x>; rel="next"' } : {} })
    }
    if (method === 'POST' && url.pathname === '/gists') {
      const body = JSON.parse(String(init?.body))
      const gist = this.add({
        description: body.description,
        public: body.public,
        created_at: '2026-10-22T00:00:00Z',
      })
      for (const [name, file] of Object.entries(body.files as Record<string, { content: string }>)) {
        gist.files.set(name, file.content)
      }
      return Response.json({ id: gist.id }, { status: 201 })
    }
    const gist = this.gists.get(url.pathname.split('/')[2] ?? '')
    if (gist === undefined) return new Response('', { status: 404 })
    const etag = `"v${gist.version}"`
    if (method === 'GET') {
      if ((init?.headers as Record<string, string>)['If-None-Match'] === etag)
        return new Response(null, { status: 304 })
      return Response.json({ id: gist.id, files: this.filesOf(gist) }, { headers: { ETag: etag } })
    }
    if (method === 'PATCH') {
      if (this.losePatches > 0) {
        // Answers with the gist as it is — without our change, as if another write won.
        this.losePatches -= 1
        return Response.json({ id: gist.id, files: this.filesOf(gist) })
      }
      const body = JSON.parse(String(init?.body)) as { files: Record<string, { content: string } | null> }
      for (const [name, file] of Object.entries(body.files)) {
        if (file === null) gist.files.delete(name)
        else gist.files.set(name, file.content)
      }
      gist.version += 1
      return Response.json({ id: gist.id, files: this.filesOf(gist) })
    }
    return new Response('', { status: 405 })
  }
}

function transport(github: FakeGitHub, gistID?: string, seen: string[] = []) {
  return new GistTransport({
    token: TOKEN,
    fetcher: github.fetch as typeof fetch,
    apiBase: 'https://api.example',
    ...(gistID === undefined ? {} : { gistID }),
    onGistID: (id) => seen.push(id),
  })
}

describe('GistTransport', () => {
  it('creates a private gist with a README when there is none, and remembers it', async () => {
    const github = new FakeGitHub()
    const seen: string[] = []
    const t = transport(github, undefined, seen)
    await t.write('tokendex-a.json', '{"a":1}')
    const [gist] = [...github.gists.values()]
    expect(gist?.public).toBe(false)
    expect(gist?.files.has(GIST_README_NAME)).toBe(true)
    expect(gist?.files.get('tokendex-a.json')).toBe('{"a":1}')
    expect(seen).toEqual([gist?.id])
  })

  // Two machines that opted in at once each created a gist. Both must settle on the same one.
  it('discovers the oldest matching private gist, ignoring look-alikes', async () => {
    const github = new FakeGitHub()
    github.add({ created_at: '2026-10-05T00:00:00Z' })
    const oldest = github.add({ created_at: '2026-10-02T00:00:00Z' })
    github.add({ created_at: '2026-01-01T00:00:00Z', public: true })
    github.add({ created_at: '2026-01-01T00:00:00Z', description: 'something else' })
    const seen: string[] = []
    await transport(github, undefined, seen).read()
    expect(seen).toEqual([oldest.id])
  })

  it('pages through the gist list', async () => {
    const github = new FakeGitHub()
    for (let i = 0; i < 150; i++)
      github.add({ description: 'unrelated', created_at: '2026-01-01T00:00:00Z' })
    const ours = github.add()
    const seen: string[] = []
    await transport(github, undefined, seen).read()
    expect(seen).toEqual([ours.id])
  })

  it('answers notModified for a matching etag', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    const t = transport(github, gist.id)
    const first = await t.read()
    expect(first.kind).toBe('files')
    const etag = first.kind === 'files' ? first.etag : undefined
    expect(await t.read(etag)).toEqual({ kind: 'notModified' })
  })

  it('reads a truncated file whole from its raw URL', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    gist.files.set('tokendex-a.json', 'x'.repeat(5000))
    github.truncate.add('tokendex-a.json')
    const read = await transport(github, gist.id).read()
    expect(read.kind === 'files' && read.files[0]?.text.length).toBe(5000)
  })

  // [trigger branch] A truncated file whose raw URL did not answer 200 was dropped without a
  // word, and the gist's etag kept: that peer was not read again until the gist next changed.
  it('lists a truncated file it could not fetch as unread', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    gist.files.set('tokendex-a.json', 'x'.repeat(5000))
    gist.files.set('tokendex-b.json', 'small')
    github.truncate.add('tokendex-a.json')
    github.scripted.set(`GET /${gist.id}/tokendex-a.json`, [new Response('', { status: 404 })])
    const read = await transport(github, gist.id).read()
    expect(read).toMatchObject({ kind: 'files', unread: ['tokendex-a.json'] })
    expect(read.kind === 'files' && read.files.map((f) => f.name)).toEqual(['tokendex-b.json'])
  })

  // [trigger branch] Signed in to another account, discovery found nothing and the remembered id —
  // the first account's secret gist, readable by id — stayed in use, folding that game into this one.
  it("leaves a remembered gist that is not in the signed-in account's list", async () => {
    const github = new FakeGitHub()
    const other = github.add()
    other.files.set('tokendex-b.json', 'another account')
    github.unlisted.add(other.id)
    const seen: string[] = []
    const read = await transport(github, other.id, seen).read()
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe(other.id)
    expect(read.kind === 'files' && read.files.map((f) => f.name)).toEqual([GIST_README_NAME])
  })

  // Only a list read to its end says "not there": a list that failed says nothing.
  it('keeps a remembered gist when the list could not be read whole', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    github.unlisted.add(gist.id)
    github.scripted.set('GET /gists', [new Response('', { status: 422 })])
    const seen: string[] = []
    await transport(github, gist.id, seen).read()
    expect(seen).toEqual([])
  })

  // [trigger branch] A PATCH that reported success while a concurrent one kept the old file.
  it('reads every write back and writes again when it did not land', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    github.losePatches = 1
    await transport(github, gist.id).write('tokendex-a.json', 'new')
    expect(gist.files.get('tokendex-a.json')).toBe('new')
    expect(github.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(2)
  })

  // [trigger branch] Measured against real GitHub: concurrent PATCHes of one gist, even of
  // different files, are refused with 409 Conflict — three of four, every round. Two devices
  // pushing in the same second is ordinary, so a conflict is retried, not a failed round.
  it('retries a write refused with 409 Conflict', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    const conflict = () => new Response('', { status: 409 })
    github.scripted.set(`PATCH /gists/${gist.id}`, [conflict(), conflict()])
    const waits: number[] = []
    const t = new GistTransport({
      token: TOKEN,
      gistID: gist.id,
      fetcher: github.fetch as typeof fetch,
      apiBase: 'https://api.example',
      sleep: async (ms) => void waits.push(ms),
    })
    await t.write('tokendex-a.json', 'x')
    expect(gist.files.get('tokendex-a.json')).toBe('x')
    expect(waits).toHaveLength(2)
  })

  it('reports a conflict that does not clear as retryable later', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    github.scripted.set(
      `PATCH /gists/${gist.id}`,
      Array.from({ length: 20 }, () => new Response('', { status: 409 })),
    )
    const t = new GistTransport({
      token: TOKEN,
      gistID: gist.id,
      fetcher: github.fetch as typeof fetch,
      apiBase: 'https://api.example',
      sleep: async () => undefined,
    })
    await expect(t.write('tokendex-a.json', 'x')).rejects.toMatchObject({ reason: 'network' })
  })

  it('gives up with a protocol error when two writes in a row do not land', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    github.losePatches = 2
    await expect(transport(github, gist.id).write('tokendex-a.json', 'new')).rejects.toMatchObject({
      reason: 'protocol',
    })
  })

  // The gist was deleted by hand: sync carries on in a new one rather than failing for ever.
  it('recreates a deleted gist', async () => {
    const github = new FakeGitHub()
    const seen: string[] = []
    const t = transport(github, 'gone', seen)
    await t.write('tokendex-a.json', 'x')
    expect(seen).toHaveLength(1)
    expect(github.gists.get(seen[0]!)?.files.get('tokendex-a.json')).toBe('x')
  })

  it('maps refusals to reasons without leaking the token', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    const cases: [Response, string, number | undefined][] = [
      [new Response('', { status: 401 }), 'auth', undefined],
      [new Response('', { status: 429, headers: { 'Retry-After': '120' } }), 'rateLimited', 120_000],
      [
        new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
        'rateLimited',
        undefined,
      ],
      [new Response('', { status: 403 }), 'auth', undefined],
      [new Response('', { status: 502 }), 'network', undefined],
    ]
    for (const [response, reason, retryAfterMs] of cases) {
      github.scripted.set(`GET /gists/${gist.id}`, [response])
      const error = await transport(github, gist.id)
        .read()
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SyncError)
      expect((error as SyncError).reason).toBe(reason)
      if (retryAfterMs !== undefined) expect((error as SyncError).retryAfterMs).toBe(retryAfterMs)
      expect((error as SyncError).message).not.toContain(TOKEN)
    }
    expect(github.authHeaders.every((h) => h === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('reports a network failure as such', async () => {
    const t = new GistTransport({
      token: TOKEN,
      gistID: 'g1',
      fetcher: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    await expect(t.read()).rejects.toMatchObject({ reason: 'network' })
  })

  // [trigger branch] The timeout was cleared when the headers arrived, so a body that stalled
  // after them held the round — and the runner, one round at a time — for ever.
  it('times out a body that stalls after the headers', async () => {
    const stalled = new Response(new ReadableStream({ start: () => undefined }), { status: 200 })
    const t = new GistTransport({
      token: TOKEN,
      gistID: 'g1',
      timeoutMs: 30,
      fetcher: (async () => stalled) as typeof fetch,
    })
    await expect(t.read()).rejects.toMatchObject({ reason: 'network' })
  })

  // [trigger branch] GitHub's secondary rate limit answers 403 with neither Retry-After nor a
  // spent primary quota. Read as "credential refused", it stopped sync until a reload.
  it('reads a secondary rate limit as a rate limit, not a refused credential', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    const t = transport(github, gist.id)
    await t.read()
    github.scripted.set(`GET /gists/${gist.id}`, [
      new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '4000' },
      }),
    ])
    await expect(t.read()).rejects.toMatchObject({ reason: 'rateLimited' })
  })

  // The gist id is the access control of a secret gist; error text reaches the output channel,
  // and from there bug reports.
  it('never puts the gist id in an error message', async () => {
    const github = new FakeGitHub()
    const gist = github.add({ id: 'secretgistid0123' })
    const t = transport(github, gist.id)
    await t.read()
    github.scripted.set(`GET /gists/${gist.id}`, [new Response('', { status: 502 })])
    const error = (await t.read().catch((e: unknown) => e)) as SyncError
    expect(error.reason).toBe('network')
    expect(error.message).not.toContain('secretgistid0123')
  })

  // [trigger branch] Two machines that opted in at once each created a gist and remembered it,
  // and a remembered id was never questioned: each synced alone for ever. Discovery runs on a
  // transport's first read and hourly after, and moves to the oldest gist.
  it('moves to the oldest gist even when another id is remembered', async () => {
    const github = new FakeGitHub()
    const oldest = github.add({ created_at: '2026-10-01T00:00:00Z' })
    const mine = github.add({ created_at: '2026-10-02T00:00:00Z' })
    oldest.files.set('tokendex-b.json', 'theirs')
    const seen: string[] = []
    const read = await transport(github, mine.id, seen).read()
    expect(seen).toEqual([oldest.id])
    expect(read.kind === 'files' && read.files.map((f) => f.name)).toContain('tokendex-b.json')
  })

  it('rediscovers at most hourly', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    let now = 0
    const t = new GistTransport({
      token: TOKEN,
      gistID: gist.id,
      fetcher: github.fetch as typeof fetch,
      apiBase: 'https://api.example',
      now: () => now,
    })
    await t.read()
    await t.read()
    expect(github.calls.filter((c) => c === 'GET /gists')).toHaveLength(1)
    now += 61 * 60_000
    await t.read()
    expect(github.calls.filter((c) => c === 'GET /gists')).toHaveLength(2)
  })

  // The PATCH answer is the gist after our write: checking it there saves re-downloading the
  // whole gist on every push.
  it('checks a write from the PATCH answer, without reading the gist again', async () => {
    const github = new FakeGitHub()
    const gist = github.add()
    const t = transport(github, gist.id)
    await t.read()
    github.calls = []
    await t.write('tokendex-a.json', 'x')
    expect(github.calls).toEqual([`PATCH /gists/${gist.id}`])
  })
})
