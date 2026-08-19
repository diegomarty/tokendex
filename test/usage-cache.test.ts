import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { LocalUsageCache } from '../src/core/usage/cache.js'
import { appendAll, entryTotal } from '../src/core/usage/entry.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ptb-cache-'))
}

const TS = '2026-06-30T10:00:00.000Z'

function claudeLine(id: string, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: TS,
    requestId: `R-${id}`,
    message: {
      id,
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 100,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
}

function codexLine(ts: string, output: number): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 200,
          output_tokens: output,
          total_tokens: 1000 + output,
        },
      },
    },
  })
}

function forkedMeta(ts: string): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: ts,
    payload: {
      id: 'child',
      forked_from_id: 'parent',
      parent_thread_id: 'parent',
      thread_source: 'user',
    },
  })
}

function subagentMeta(ts: string): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: ts,
    payload: {
      id: 'sub-1',
      session_id: 'parent',
      forked_from_id: 'parent',
      parent_thread_id: 'parent',
      thread_source: 'subagent',
    },
  })
}

function write(dir: string, name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

/** Rewrite a file and force a distinct mtime, which is what invalidates a blob. */
function touchWithNewContent(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n'), 'utf8')
  const future = new Date(Date.now() + 5000)
  utimesSync(path, future, future)
}

/**
 * Rewrite a file while pinning mtime to an exact whole second.
 *
 * Restoring a captured `Date` is not enough: `utimesSync` truncates sub-second precision, so
 * the restored `mtimeMs` differs from the cached one and the blob is invalidated — making the
 * test look like a cache miss when the cache is fine.
 */
// Must stay inside the 40-day prune window: an older value is dropped by `prune()` on save,
// which looks like a cache miss but is the cache working correctly.
const PINNED_MTIME_SECONDS = Math.floor(Date.now() / 1000)
function rewritePinningMtime(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
  utimesSync(path, PINNED_MTIME_SECONDS, PINNED_MTIME_SECONDS)
}

describe('blob reuse', () => {
  it('does not re-parse an unchanged file', async () => {
    const root = tempDir()
    write(root, 'a.jsonl', [claudeLine('A', 10)])
    const cacheFile = join(tempDir(), 'cache.json.gz')
    const cache = new LocalUsageCache({ claudeRoots: [root], filePath: cacheFile })

    rewritePinningMtime(join(root, 'a.jsonl'), claudeLine('A', 10))
    const first = await cache.claudeEntries(0)
    // Replace the content WITHOUT changing mtime/size: a correct cache serves the old blob.
    rewritePinningMtime(join(root, 'a.jsonl'), claudeLine('A', 99))

    const second = await cache.claudeEntries(0)
    expect(second.map(entryTotal)).toEqual(first.map(entryTotal))
    expect(second[0]?.output).toBe(10) // still the cached parse
  })

  it('re-parses a changed file', async () => {
    const root = tempDir()
    const path = write(root, 'a.jsonl', [claudeLine('A', 10)])
    const cache = new LocalUsageCache({ claudeRoots: [root], filePath: join(tempDir(), 'c.gz') })

    await cache.claudeEntries(0)
    touchWithNewContent(path, [claudeLine('A', 10), claudeLine('B', 20)])
    expect(await cache.claudeEntries(0)).toHaveLength(2)
  })

  it('scans several roots and de-duplicates across them', async () => {
    const a = tempDir()
    const b = tempDir()
    write(a, 'a.jsonl', [claudeLine('SHARED', 10)])
    write(b, 'b.jsonl', [claudeLine('SHARED', 10), claudeLine('ONLY-B', 5)])
    const cache = new LocalUsageCache({ claudeRoots: [a, b], filePath: join(tempDir(), 'c.gz') })
    expect(await cache.claudeEntries(0)).toHaveLength(2)
  })

  it('honours the modifiedSince window', async () => {
    const root = tempDir()
    write(root, 'a.jsonl', [claudeLine('A', 10)])
    const cache = new LocalUsageCache({ claudeRoots: [root], filePath: join(tempDir(), 'c.gz') })
    expect(await cache.claudeEntries(Date.now() + 60_000)).toHaveLength(0)
  })
})

describe('codex through the cache', () => {
  it('still drops a forked replay burst', async () => {
    const root = tempDir()
    write(root, 'rollout-child.jsonl', [
      forkedMeta('2026-07-29T01:00:00.000Z'),
      codexLine('2026-07-29T01:00:00.010Z', 50),
      codexLine('2026-07-29T01:00:00.020Z', 51),
      codexLine('2026-07-29T01:00:03.000Z', 52),
    ])
    const cache = new LocalUsageCache({ codexRoot: root, filePath: join(tempDir(), 'c.gz') })
    const entries = await cache.codexEntries(0)
    expect(entries.map((e) => e.output)).toEqual([52])
  })

  it('keeps a subagent first turn when the parent is missing', async () => {
    const root = tempDir()
    write(root, 'rollout-sub.jsonl', [
      subagentMeta('2026-07-29T01:00:00.000Z'),
      codexLine('2026-07-29T01:00:00.010Z', 1),
      codexLine('2026-07-29T01:00:00.020Z', 2),
    ])
    const cache = new LocalUsageCache({ codexRoot: root, filePath: join(tempDir(), 'c.gz') })
    expect((await cache.codexEntries(0)).map((e) => e.output)).toEqual([1, 2])
  })

  it('round-trips parsed rollouts across instances', async () => {
    const root = tempDir()
    write(root, 'rollout-child.jsonl', [
      forkedMeta('2026-07-29T01:00:00.000Z'),
      codexLine('2026-07-29T01:00:00.010Z', 50),
      codexLine('2026-07-29T01:00:03.000Z', 52),
    ])
    const file = join(tempDir(), 'c.gz')
    const first = new LocalUsageCache({ codexRoot: root, filePath: file })
    const before = await first.codexEntries(0)
    await first.save()

    const second = new LocalUsageCache({ codexRoot: root, filePath: file })
    expect((await second.codexEntries(0)).map((e) => e.output)).toEqual(before.map((e) => e.output))
  })
})

describe('session index', () => {
  it('drops entries for deleted rollouts', async () => {
    const root = tempDir()
    write(root, 'rollout-a.jsonl', [codexLine('2026-07-29T01:00:00.000Z', 1)])
    write(root, 'rollout-b.jsonl', [codexLine('2026-07-29T01:00:01.000Z', 2)])
    const file = join(tempDir(), 'c.gz')
    const cache = new LocalUsageCache({ codexRoot: root, filePath: file })
    await cache.codexEntries(0)
    await cache.save()

    rmSync(join(root, 'rollout-b.jsonl'))
    const next = new LocalUsageCache({ codexRoot: root, filePath: file })
    await next.codexEntries(0)
    expect(await next.codexSessionIndexCount()).toBe(1)
  })

  // A wholly failed enumeration (missing root, transient permission error) must not be read
  // as "everything was deleted", which would throw away an index built to find old parents.
  it('does not wipe the index when the root enumerates empty', async () => {
    const root = tempDir()
    write(root, 'rollout-a.jsonl', [codexLine('2026-07-29T01:00:00.000Z', 1)])
    const file = join(tempDir(), 'c.gz')
    const cache = new LocalUsageCache({ codexRoot: root, filePath: file })
    await cache.codexEntries(0)
    await cache.save()

    const missingRoot = join(tempDir(), 'gone')
    const next = new LocalUsageCache({ codexRoot: missingRoot, filePath: file })
    await next.codexEntries(0)
    expect(await next.codexSessionIndexCount()).toBe(1)
  })

  it('retries a probe read failure instead of persisting it', async () => {
    const root = tempDir()
    // A child with an orphaned parent forces the probe path over the other file. That other
    // file must sit OUTSIDE the lookup window — inside it, it is already loaded and there is
    // nothing left to probe.
    write(root, 'rollout-child.jsonl', [
      forkedMeta('2026-07-29T01:00:00.000Z'),
      codexLine('2026-07-29T01:00:03.000Z', 5),
    ])
    const other = write(root, 'rollout-other.jsonl', [codexLine('2026-07-29T01:00:00.000Z', 1)])
    const ancient = new Date(Date.now() - 200 * 86_400_000)
    utimesSync(other, ancient, ancient)
    const since = Date.now() - 86_400_000

    let calls = 0
    const failing = async (): Promise<string | undefined> => {
      calls += 1
      throw new Error('EIO')
    }
    const file = join(tempDir(), 'c.gz')
    const cache = new LocalUsageCache({ codexRoot: root, filePath: file, codexProbe: failing })
    await cache.codexEntries(since)
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(0)

    // A failure is not indexed, so a later pass probes again rather than freezing "no id".
    const retry = new LocalUsageCache({ codexRoot: root, filePath: file, codexProbe: failing })
    await retry.codexEntries(since)
    expect(calls).toBeGreaterThan(afterFirst)
  })
})

describe('persistence', () => {
  it('round-trips across instances so the cold parse happens once', async () => {
    const root = tempDir()
    write(root, 'a.jsonl', [claudeLine('A', 10)])
    const file = join(tempDir(), 'c.gz')

    rewritePinningMtime(join(root, 'a.jsonl'), claudeLine('A', 10))
    const first = new LocalUsageCache({ claudeRoots: [root], filePath: file })
    await first.claudeEntries(0)
    await first.save()

    // Content replaced without touching mtime/size: a loaded snapshot serves the old blob,
    // which is exactly what proves it was reused rather than re-parsed.
    rewritePinningMtime(join(root, 'a.jsonl'), claudeLine('A', 77))

    const second = new LocalUsageCache({ claudeRoots: [root], filePath: file })
    expect((await second.claudeEntries(0))[0]?.output).toBe(10)
  })

  it('writes a compressed snapshot', async () => {
    const root = tempDir()
    write(root, 'a.jsonl', [claudeLine('A', 10)])
    const file = join(tempDir(), 'c.gz')
    const cache = new LocalUsageCache({ claudeRoots: [root], filePath: file })
    await cache.claudeEntries(0)
    await cache.save()

    const raw = await import('node:fs/promises').then((m) => m.readFile(file))
    expect(() => gunzipSync(raw)).not.toThrow()
    expect(raw.length).toBeLessThan(gunzipSync(raw).length)
  })

  it('degrades to a cold parse on a corrupt cache instead of throwing', async () => {
    const root = tempDir()
    write(root, 'a.jsonl', [claudeLine('A', 10)])
    const file = join(tempDir(), 'c.gz')
    writeFileSync(file, 'not a cache', 'utf8')

    const cache = new LocalUsageCache({ claudeRoots: [root], filePath: file })
    expect(await cache.claudeEntries(0)).toHaveLength(1)
  })

  it('prunes blobs older than 40 days but keeps the session index', async () => {
    const root = tempDir()
    const codexRoot = tempDir()
    const path = write(root, 'old.jsonl', [claudeLine('A', 10)])
    write(codexRoot, 'rollout-a.jsonl', [codexLine('2026-07-29T01:00:00.000Z', 1)])

    const old = new Date(Date.now() - 100 * 86_400_000)
    utimesSync(path, old, old)

    const file = join(tempDir(), 'c.gz')
    const cache = new LocalUsageCache({ claudeRoots: [root], codexRoot, filePath: file })
    await cache.claudeEntries(0) // window 0 still picks the old file up
    await cache.codexEntries(0)
    await cache.save()

    const next = new LocalUsageCache({ claudeRoots: [root], codexRoot, filePath: file })
    // The old blob is gone from the snapshot; the index that finds ancient parents is not.
    expect(await next.codexSessionIndexCount()).toBe(1)
  })

  it('throttles writes to once a minute', async () => {
    const root = tempDir()
    const path = write(root, 'a.jsonl', [claudeLine('A', 10)])
    const file = join(tempDir(), 'c.gz')
    let clock = 1_000_000
    const cache = new LocalUsageCache({ claudeRoots: [root], filePath: file, now: () => clock })

    await cache.claudeEntries(0) // first pass writes
    const firstWrite = statSync(file).mtimeMs

    touchWithNewContent(path, [claudeLine('A', 10), claudeLine('B', 20)])
    clock += 30_000 // under the throttle
    await cache.claudeEntries(0)
    expect(statSync(file).mtimeMs).toBe(firstWrite)

    clock += 40_000 // now past 60s
    touchWithNewContent(path, [claudeLine('A', 10), claudeLine('B', 20), claudeLine('C', 30)])
    await cache.claudeEntries(0)
    expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(firstWrite)
  })
})

describe('save behaviour', () => {
  /** A real SQLite file, because the idle-scan gate must be judged on the actual query path. */
  async function cursorDB(root: string, bubbles: number): Promise<void> {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run('CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)')
    for (let i = 0; i < bubbles; i++) {
      const bubble = JSON.stringify({
        tokenCount: { inputTokens: 300, outputTokens: 40 },
        createdAt: new Date().toISOString(),
        modelType: 'claude-4-sonnet',
      })
      db.run(`INSERT INTO cursorDiskKV VALUES ('bubbleId:${'b' + String(i)}','${bubble}')`)
    }
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'state.vscdb'), Buffer.from(db.export()))
    db.close()
  }

  // [trigger branch] Before the gate, `incrementalEntries` forced `dirty` on every call, so
  // every idle scan re-gzipped and rewrote the whole snapshot even though nothing moved.
  it('does not rewrite the cache when an idle incremental scan changed nothing', async () => {
    const root = tempDir()
    await cursorDB(root, 1)
    const file = join(tempDir(), 'c.gz')
    let clock = 1_000_000
    const cache = new LocalUsageCache({ cursorRoots: [root], filePath: file, now: () => clock })

    const fs = await import('node:fs')
    const writes = vi.spyOn(fs.promises, 'writeFile')
    try {
      expect((await cache.cursorEntries(0)).length).toBe(1)
      expect(writes).toHaveBeenCalledTimes(1) // first pass parsed something and persisted it

      clock += 120_000 // well past the save throttle, so only the dirty gate can stop a write
      expect((await cache.cursorEntries(0)).length).toBe(1)
      expect(writes).toHaveBeenCalledTimes(1) // idle: same rows, same watermark, no write

      // The gate must not overshoot: a genuinely new row still reaches disk.
      await cursorDB(root, 2)
      clock += 120_000
      expect((await cache.cursorEntries(0)).length).toBe(2)
      expect(writes).toHaveBeenCalledTimes(2)
    } finally {
      writes.mockRestore()
    }
  })

  // The ten providers finish a scan close together and each calls saveIfNeeded; without
  // single-flighting they gzip the same snapshot concurrently and race on one `.tmp` file.
  it('single-flights concurrent saves into one write', async () => {
    const root = tempDir()
    write(root, 'a.jsonl', [claudeLine('A', 10)])
    const file = join(tempDir(), 'c.gz')
    const cache = new LocalUsageCache({ claudeRoots: [root], filePath: file })
    await cache.claudeEntries(0) // loads and parses; also performs the first save

    const fs = await import('node:fs')
    const writes = vi.spyOn(fs.promises, 'writeFile')
    try {
      await Promise.all([cache.save(), cache.save(), cache.save()])
      expect(writes).toHaveBeenCalledTimes(1)
    } finally {
      writes.mockRestore()
    }
  })
})

describe('appendAll', () => {
  // `push(...arr)` passes one stack argument per element and overflows somewhere past ~150k,
  // a size a single cold Cursor or Claude scan genuinely reaches. The helper must not.
  it('appends 300k entries without overflowing the stack', () => {
    const source = Array.from({ length: 300_000 }, (_, i) => i)
    const target: number[] = [-1]
    appendAll(target, source)
    expect(target.length).toBe(300_001)
    expect(target[0]).toBe(-1)
    expect(target[300_000]).toBe(299_999)
  })
})
