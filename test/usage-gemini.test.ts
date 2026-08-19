import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { geminiEntries, parseGeminiFile } from '../src/core/usage/gemini.js'
import { entryTotal } from '../src/core/usage/entry.js'

function chatsDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ptb-gemini-')), 'tmp', 'hash1', 'chats')
  mkdirSync(dir, { recursive: true })
  return dir
}

const NEW_JSONL = [
  '{"type":"session_metadata","sessionId":"s1","startTime":"2026-07-03T01:00:00.000Z"}',
  '{"type":"user","id":"m1","timestamp":"2026-07-03T01:00:05.000Z","content":[{"text":"hi"}]}',
  '{"type":"gemini","id":"m2","timestamp":"2026-07-03T01:00:10.000Z","model":"gemini-2.5-pro","tokens":{"input":1000,"output":50,"cached":600,"thoughts":30,"tool":20,"total":1100}}',
  '{"type":"gemini","id":"m3","timestamp":"2026-07-03T01:01:00.000Z","model":"gemini-2.5-flash","tokens":{"input":10,"output":5,"cached":0,"thoughts":0,"tool":0,"total":15}}',
  '{"type":"message_update","id":"m3","tokens":{"input":10,"output":8,"cached":0,"thoughts":2,"tool":0,"total":20}}',
].join('\n')

const LEGACY_JSON = JSON.stringify({
  sessionId: 's0',
  startTime: '2026-07-02T00:00:00.000Z',
  messages: [
    {
      id: 'a1',
      type: 'gemini',
      timestamp: '2026-07-02T00:10:00.000Z',
      model: 'gemini-2.5-pro',
      tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 0, total: 110 },
    },
    { id: 'a2', type: 'user', content: [{ text: 'x' }] },
  ],
})

describe('gemini .jsonl', () => {
  it('preserves usageMetadata semantics and lets message_update win', async () => {
    const dir = chatsDir()
    const path = join(dir, 'session-2026-07-03T01-00-abcd1234.jsonl')
    writeFileSync(path, NEW_JSONL, 'utf8')

    const entries = await parseGeminiFile(path)
    expect(entries).toHaveLength(2) // the user turn and the metadata line carry no tokens

    const m2 = entries[0]!
    expect(m2.model).toBe('gemini-2.5-pro')
    expect(m2.input).toBe(420) // (1000 - 600 uncached) + 20 tool
    expect(m2.cacheRead).toBe(600)
    expect(m2.output).toBe(80) // 50 + 30 thoughts
    expect(m2.cacheWrite).toBe(0)
    // The identity that makes the mapping trustworthy: entry total == totalTokenCount.
    expect(entryTotal(m2)).toBe(1100)

    const m3 = entries[1]!
    expect(m3.output).toBe(10) // the update (8 output + 2 thoughts) is the final value
    expect(entryTotal(m3)).toBe(20)
  })

  it('keeps the order the messages appeared in', async () => {
    const dir = chatsDir()
    const path = join(dir, 'session-a.jsonl')
    writeFileSync(path, NEW_JSONL, 'utf8')
    expect((await parseGeminiFile(path)).map((e) => e.id.split('|').pop())).toEqual(['m2', 'm3'])
  })

  /**
   * A `message_update` replaces the whole entry, and those records carry no `model`, so the
   * updated turn falls back to the bare "gemini" name.
   *
   * This is an upstream defect worth reporting: "gemini" matches neither the pricing table
   * nor the pro/flash family fallback, so an updated turn is silently priced at zero. Fixing
   * it here would diverge from upstream and from any parity check against it, so the
   * behaviour is pinned rather than corrected.
   */
  it('loses the model on an updated turn, as upstream does', async () => {
    const dir = chatsDir()
    const path = join(dir, 'session-b.jsonl')
    writeFileSync(path, NEW_JSONL, 'utf8')
    const entries = await parseGeminiFile(path)
    expect(entries[0]?.model).toBe('gemini-2.5-pro')
    expect(entries[1]?.model).toBe('gemini')
  })
})

describe('gemini legacy .json', () => {
  it('collects only the messages that carry tokens', async () => {
    const dir = chatsDir()
    const path = join(dir, 'checkpoint-old.json')
    writeFileSync(path, LEGACY_JSON, 'utf8')

    const entries = await parseGeminiFile(path)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ input: 100, output: 10 })
    expect(entryTotal(entries[0]!)).toBe(110)
  })

  it('falls back to the session start when a message has no timestamp', async () => {
    const dir = chatsDir()
    const path = join(dir, 'no-ts.json')
    writeFileSync(
      path,
      JSON.stringify({
        startTime: '2026-07-02T00:00:00.000Z',
        messages: [{ id: 'a1', tokens: { input: 5, output: 5, total: 10 } }],
      }),
      'utf8',
    )
    expect(await parseGeminiFile(path)).toHaveLength(1)
  })
})

describe('gemini scanning', () => {
  // `.json` is Gemini-only: enabling it everywhere would drag Claude's `.meta.json` sidecars
  // into the scan.
  it('collects both extensions', async () => {
    const dir = chatsDir()
    writeFileSync(join(dir, 'session-a.jsonl'), NEW_JSONL, 'utf8')
    writeFileSync(join(dir, 'checkpoint-b.json'), LEGACY_JSON, 'utf8')

    const root = join(dir, '..', '..')
    const entries = await geminiEntries(0, root)
    expect(entries).toHaveLength(3)
    expect(entries.reduce((s, e) => s + entryTotal(e), 0)).toBe(1100 + 20 + 110)
  })

  it('yields nothing for a file with no tokens at all', async () => {
    const dir = chatsDir()
    const path = join(dir, '..', 'logs.json')
    writeFileSync(
      path,
      JSON.stringify({ entries: [{ sessionId: 'x', type: 'user', message: 'hello' }] }),
      'utf8',
    )
    expect(await parseGeminiFile(path)).toEqual([])
  })

  it('honours the mtime window', async () => {
    const dir = chatsDir()
    writeFileSync(join(dir, 'session-a.jsonl'), NEW_JSONL, 'utf8')
    expect(await geminiEntries(Date.now() + 60_000, join(dir, '..', '..'))).toEqual([])
  })
})
