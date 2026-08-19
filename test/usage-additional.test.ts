import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import initSqlJs from 'sql.js'
import {
  copilotDate,
  copilotDayCutoff,
  copilotEntries,
  cursorEntries,
  cursorRowQuery,
  hermesEntries,
  kiroTurnEntries,
  openCodeEntries,
  parseCursorBubble,
  parseOpenCodeMessage,
} from '../src/core/usage/additional.js'
import { entryTotal } from '../src/core/usage/entry.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ptb-add-'))
}

/** Builds a real SQLite file so the tests exercise the actual query path, not a stub. */
async function makeDatabase(path: string, statements: string[]): Promise<void> {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  for (const sql of statements) db.run(sql)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.from(db.export()))
  db.close()
}

const DAY = Date.UTC(2026, 6, 3, 12, 0, 0)

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

describe('opencode', () => {
  const message = (over: Record<string, unknown> = {}) => ({
    id: 'msg-1',
    providerID: 'anthropic',
    modelID: 'claude-opus-4-8',
    time: { created: DAY },
    tokens: { input: 100, output: 20, cache: { read: 500, write: 10 }, total: 630 },
    cost: 0.42,
    ...over,
  })

  it('maps the four token kinds and the reported cost', () => {
    const entry = parseOpenCodeMessage(message(), 'fallback')!
    expect(entry).toMatchObject({ input: 100, output: 20, cacheRead: 500, cacheWrite: 10 })
    expect(entry.explicitCost).toBeCloseTo(0.42, 9)
    expect(entryTotal(entry)).toBe(630)
  })

  it('requires a provider, a model and a time', () => {
    expect(parseOpenCodeMessage(message({ providerID: undefined }), 'f')).toBeUndefined()
    expect(parseOpenCodeMessage(message({ modelID: undefined }), 'f')).toBeUndefined()
    expect(parseOpenCodeMessage(message({ time: {} }), 'f')).toBeUndefined()
  })

  it('falls back to the file name when the message carries no id', () => {
    expect(parseOpenCodeMessage(message({ id: undefined }), 'from-file')?.id).toBe('opencode|from-file')
  })

  it('reads the database', async () => {
    const root = tempDir()
    await makeDatabase(join(root, 'opencode.db'), [
      'CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)',
      `INSERT INTO message VALUES ('m1','s1','${JSON.stringify(message()).replace(/'/g, "''")}',${DAY})`,
    ])
    const entries = await openCodeEntries(0, [root])
    expect(entries).toHaveLength(1)
    expect(entryTotal(entries[0]!)).toBe(630)
  })

  // Older databases had no time_created column: a failed query must fall back to the full
  // table rather than report nothing.
  it('falls back when time_created does not exist', async () => {
    const root = tempDir()
    await makeDatabase(join(root, 'opencode.db'), [
      'CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)',
      `INSERT INTO message VALUES ('m1','s1','${JSON.stringify(message()).replace(/'/g, "''")}')`,
    ])
    expect(await openCodeEntries(0, [root])).toHaveLength(1)
  })

  it('reads legacy per-message json files', async () => {
    const root = tempDir()
    const dir = join(root, 'storage', 'message', 'ses')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'msg-9.json'), JSON.stringify(message({ id: undefined })), 'utf8')
    const entries = await openCodeEntries(0, [root])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('opencode|msg-9')
  })
})

// ---------------------------------------------------------------------------
// Hermes
// ---------------------------------------------------------------------------

describe('hermes', () => {
  async function hermesDB(root: string, row: string): Promise<void> {
    await makeDatabase(join(root, 'state.db'), [
      `CREATE TABLE sessions (id TEXT, model TEXT, billing_provider TEXT, started_at REAL,
        message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, actual_cost_usd REAL)`,
      row,
    ])
  }
  const seconds = Math.floor(DAY / 1000)

  it('adds reasoning to output and prefers the actual cost', async () => {
    const root = tempDir()
    await hermesDB(
      root,
      `INSERT INTO sessions VALUES ('s1','claude-opus-4-8','anthropic',${seconds},3,100,20,50,10,7,0.9,0.5)`,
    )
    const e = (await hermesEntries(0, [root]))[0]!
    expect(e.output).toBe(20 + 7)
    expect(e.cacheRead).toBe(50)
    expect(e.cacheWrite).toBe(10)
    expect(e.explicitCost).toBeCloseTo(0.5, 9)
  })

  it('falls back to the estimated cost when there is no actual one', async () => {
    const root = tempDir()
    await hermesDB(root, `INSERT INTO sessions VALUES ('s1','m','p',${seconds},1,10,1,0,0,0,0.9,0)`)
    expect((await hermesEntries(0, [root]))[0]?.explicitCost).toBeCloseTo(0.9, 9)
  })

  it('skips rows with no model', async () => {
    const root = tempDir()
    await hermesDB(root, `INSERT INTO sessions VALUES ('s1','   ','p',${seconds},1,10,1,0,0,0,0,0)`)
    expect(await hermesEntries(0, [root])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

describe('cursor', () => {
  const bubble = (over: Record<string, unknown> = {}) => ({
    tokenCount: { inputTokens: 300, outputTokens: 40 },
    createdAt: new Date(DAY).toISOString(),
    modelType: 'claude-4-sonnet',
    ...over,
  })

  it('parses a bubble', () => {
    const e = parseCursorBubble(bubble(), 'bubbleId:x', 0)!
    expect(e).toMatchObject({
      id: 'cursor|bubbleId:x',
      input: 300,
      output: 40,
      model: 'claude-4-sonnet',
    })
  })

  it('skips a bubble with no tokens at all', () => {
    expect(
      parseCursorBubble(bubble({ tokenCount: { inputTokens: 0, outputTokens: 0 } }), 'k', 0),
    ).toBeUndefined()
  })

  // [trigger branch] `parseFloat` takes a leading prefix, so an ISO date would parse as its
  // year (2026) and land in 1970. The coercion rejects a non-numeric string outright instead,
  // and this is the case that proves it.
  it('accepts both an ISO string and an epoch number for createdAt', () => {
    expect(parseCursorBubble(bubble({ createdAt: DAY }), 'k', 0)?.date).toBe(DAY)
    expect(parseCursorBubble(bubble(), 'k', 0)?.date).toBe(DAY)
    expect(parseCursorBubble(bubble({ createdAt: '2026-07-03T12:00:00.000Z' }), 'k', 0)?.date).toBe(DAY)
  })

  it('names an unknown model rather than dropping the row', () => {
    expect(parseCursorBubble(bubble({ modelType: null }), 'k', 0)?.model).toBe('unknown')
  })

  // A cold pass uses the key index; an incremental one needs NOT INDEXED or SQLite prefers
  // that index and walks every bubble instead of only the new rows.
  it('switches SQL between the cold and incremental passes', () => {
    expect(cursorRowQuery(0).sql).not.toContain('NOT INDEXED')
    expect(cursorRowQuery(0).params).toEqual([])
    expect(cursorRowQuery(500).sql).toContain('NOT INDEXED')
    expect(cursorRowQuery(500).params).toEqual([500])
  })

  async function cursorDB(root: string, rows: { key: string; value: unknown }[]): Promise<void> {
    const inserts = rows.map(
      (r) =>
        `INSERT INTO cursorDiskKV VALUES ('${r.key}','${JSON.stringify(r.value).replace(/'/g, "''")}')`,
    )
    await makeDatabase(join(root, 'state.vscdb'), [
      'CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)',
      ...inserts,
    ])
  }

  it('reads bubbles and reports a watermark', async () => {
    const root = tempDir()
    await cursorDB(root, [
      { key: 'bubbleId:a', value: bubble() },
      { key: 'other:z', value: {} },
    ])
    const result = await cursorEntries(0, { roots: [root] })
    expect(result.entries).toHaveLength(1)
    expect(Object.values(result.highWaterByPath)[0]).toBeGreaterThan(0)
    expect(result.didReset).toBe(false)
  })

  // [trigger branch] A database that shrank below the watermark was rebuilt, so everything
  // must be rescanned cold and the caller must discard what it held.
  it('resets when the store shrinks below the watermark', async () => {
    const root = tempDir()
    await cursorDB(root, [{ key: 'bubbleId:a', value: bubble() }])
    const db = join(root, 'state.vscdb')
    const result = await cursorEntries(0, { roots: [root], afterRowIDByPath: { [db]: 9_999 } })
    expect(result.didReset).toBe(true)
    expect(result.entries).toHaveLength(1) // recovered by the cold rescan
  })

  // An incremental pass that matched nothing must keep the watermark, or the next scan
  // replays the whole month.
  it('keeps the watermark when nothing new arrived', async () => {
    const root = tempDir()
    await cursorDB(root, [{ key: 'bubbleId:a', value: bubble() }])
    const db = join(root, 'state.vscdb')
    const first = await cursorEntries(0, { roots: [root] })
    const mark = first.highWaterByPath[db]!
    const second = await cursorEntries(0, { roots: [root], afterRowIDByPath: { [db]: mark } })
    expect(second.entries).toEqual([])
    expect(second.highWaterByPath[db]).toBe(mark)
  })

  // A failed read is not a shrink: open or prepare can fail while the writer holds the file,
  // and collapsing that into 0 would wipe the cache for a whole refresh interval.
  it('preserves the watermark when the database cannot be read', async () => {
    const root = tempDir()
    const db = join(root, 'state.vscdb')
    const result = await cursorEntries(0, { roots: [root], afterRowIDByPath: { [db]: 77 } })
    expect(result.highWaterByPath[db]).toBe(77)
    expect(result.didReset).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------

describe('copilot', () => {
  it('normalises both date shapes it writes', () => {
    expect(copilotDate('2026-07-03T12:00:00Z')).toBe(DAY)
    expect(copilotDate('2026-07-03 12:00:00')).toBe(DAY) // the datetime('now') default
    expect(copilotDate('nope')).toBeUndefined()
  })

  // `created_at` is text, so the cutoff is lexicographic. A row with a UTC offset can render
  // an earlier calendar day than the instant it represents, and once a later id advances the
  // watermark a dropped row is lost for good — hence backing off a full day.
  it('backs the coarse cutoff off by a day', () => {
    expect(copilotDayCutoff(Date.UTC(2026, 0, 4, 1, 0, 0))).toBe('2026-01-03 00:00:00')
  })

  async function copilotDB(root: string, rows: string[]): Promise<void> {
    await makeDatabase(join(root, 'session-store.db'), [
      `CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, created_at TEXT)`,
      ...rows,
    ])
  }

  // input_tokens is the whole prompt: cached reads and writes are a subset. Not subtracting
  // counts the same prompt tokens three times.
  it('subtracts the cache from the prompt total', async () => {
    const root = tempDir()
    await copilotDB(root, [
      `INSERT INTO assistant_usage_events VALUES (1,'gpt-5.5',1000,50,600,100,'2026-07-03T12:00:00Z')`,
    ])
    const e = (await copilotEntries(0, { roots: [root] })).entries[0]!
    expect(e.input).toBe(1000 - 600 - 100)
    expect(e.cacheRead).toBe(600)
    expect(e.cacheWrite).toBe(100)
    expect(e.output).toBe(50)
  })

  // The row id is unique only within one store, and $COPILOT_HOME may name several. Without
  // the database in the key, id 1 of each would collapse during de-duplication.
  it('keys entries by database as well as row id', async () => {
    const a = tempDir()
    const b = tempDir()
    for (const root of [a, b]) {
      await copilotDB(root, [
        `INSERT INTO assistant_usage_events VALUES (1,'m',100,10,0,0,'2026-07-03T12:00:00Z')`,
      ])
    }
    expect((await copilotEntries(0, { roots: [a, b] })).entries).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Kiro
// ---------------------------------------------------------------------------

describe('kiro', () => {
  const turn = (ms: number, user: string, assistant: string) => ({
    user: { content: user },
    assistant: { content: assistant },
    request_metadata: { request_start_timestamp_ms: ms, model_id: 'claude-4', response_size: 400 },
  })

  // Every turn resends the whole conversation, so a turn's prompt is the accumulated history
  // plus its own message — not just what was typed.
  it('accumulates history into each prompt', () => {
    const entries = kiroTurnEntries(
      'c1',
      {
        history: [
          turn(DAY, 'a'.repeat(400), 'b'.repeat(400)),
          turn(DAY + 1000, 'c'.repeat(400), 'd'.repeat(400)),
        ],
      },
      0,
    )
    expect(entries).toHaveLength(2)
    expect(entries[1]!.input).toBeGreaterThan(entries[0]!.input)
    expect(entries[0]!.input).toBe(400 / 4)
    expect(entries[1]!.input).toBe((400 + 400 + 400) / 4)
  })

  // Compaction removes turns from history but they are still resent, so the summary seeds the
  // running total.
  it('seeds the running total from latest_summary', () => {
    const withSummary = kiroTurnEntries(
      'c1',
      {
        latest_summary: 's'.repeat(800),
        history: [turn(DAY, 'a'.repeat(400), 'b')],
      },
      0,
    )
    const without = kiroTurnEntries('c1', { history: [turn(DAY, 'a'.repeat(400), 'b')] }, 0)
    expect(withSummary[0]!.input).toBe(without[0]!.input + 800 / 4)
  })

  // A turn with no timestamp has nothing stable to key an id on, but its bytes still get
  // resent, so they must keep accumulating.
  it('skips a turn with no timestamp yet still counts its bytes', () => {
    const entries = kiroTurnEntries(
      'c1',
      {
        history: [
          { user: { content: 'x'.repeat(400) }, assistant: { content: 'y'.repeat(400) } },
          turn(DAY, 'z'.repeat(400), 'w'),
        ],
      },
      0,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.input).toBe((400 + 400 + 400) / 4)
  })

  // A base64 blob would dwarf the actual text and is not separately modelled.
  it('excludes images from the byte count', () => {
    const withImage = kiroTurnEntries(
      'c1',
      {
        history: [
          {
            user: { content: 'a'.repeat(400), images: 'Z'.repeat(100_000) },
            assistant: {},
            request_metadata: { request_start_timestamp_ms: DAY, model_id: 'm', response_size: 4 },
          },
        ],
      },
      0,
    )
    expect(withImage[0]!.input).toBe(100)
  })

  it('honours the window', () => {
    expect(kiroTurnEntries('c1', { history: [turn(DAY, 'a'.repeat(400), 'b')] }, DAY + 60_000)).toEqual(
      [],
    )
  })

  it('derives output from the streamed response size', () => {
    expect(kiroTurnEntries('c1', { history: [turn(DAY, 'a'.repeat(400), 'b')] }, 0)[0]!.output).toBe(
      400 / 4,
    )
  })
})
