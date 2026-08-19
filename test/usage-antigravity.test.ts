import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import initSqlJs from 'sql.js'
import {
  TOKEN_CEILING,
  antigravityEntries,
  parseGenerationMetadata,
  protoString,
  protoVarint,
  tokenCount,
  walk,
} from '../src/core/usage/antigravity.js'
import { entryTotal } from '../src/core/usage/entry.js'

// --- minimal protobuf writer, so the fixtures are real wire bytes ---

function varint(value: number): number[] {
  const out: number[] = []
  let v = value
  while (v > 127) {
    out.push((v % 128) + 128)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

const tagVarint = (field: number, value: number) => [...varint(field * 8), ...varint(value)]
const tagBytes = (field: number, payload: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(payload.length),
  ...payload,
]
const utf8 = (text: string) => [...Buffer.from(text, 'utf8')]

const SECONDS = Math.floor(Date.UTC(2026, 6, 3, 12, 0, 0) / 1000)

/** A `gen_metadata.data` blob shaped exactly as the CLI writes it. */
function genMetadata(
  o: {
    input?: number
    output?: number
    cacheWrite?: number
    cacheRead?: number
    responseID?: string | null
    model?: string | null
    seconds?: number | null
  } = {},
): Uint8Array {
  const usage: number[] = []
  if (o.input !== undefined) usage.push(...tagVarint(2, o.input))
  if (o.output !== undefined) usage.push(...tagVarint(3, o.output))
  if (o.cacheWrite !== undefined) usage.push(...tagVarint(4, o.cacheWrite))
  if (o.cacheRead !== undefined) usage.push(...tagVarint(5, o.cacheRead))
  if (o.responseID !== null) usage.push(...tagBytes(11, utf8(o.responseID ?? 'resp-1')))

  const chatModel: number[] = [...tagBytes(4, usage)]
  const seconds = o.seconds === undefined ? SECONDS : o.seconds
  if (seconds !== null) {
    // chat_start_metadata (9) -> created_at (4) -> seconds (1)
    chatModel.push(...tagBytes(9, tagBytes(4, tagVarint(1, seconds))))
  }
  if (o.model !== null) chatModel.push(...tagBytes(19, utf8(o.model ?? 'gemini-3.6-flash')))

  return Uint8Array.from(tagBytes(1, chatModel))
}

describe('protobuf wire format', () => {
  it('reads varints, strings and nested messages', () => {
    const bytes = Uint8Array.from([...tagVarint(1, 300), ...tagBytes(2, utf8('hola'))])
    expect(protoVarint(bytes, 1)).toBe(300)
    expect(protoString(bytes, 2)).toBe('hola')
    expect(protoVarint(bytes, 9)).toBeUndefined()
  })

  it('skips fixed-width fields instead of misreading them', () => {
    const bytes = Uint8Array.from([...varint(1 * 8 + 5), 1, 2, 3, 4, ...tagVarint(2, 7)])
    expect(protoVarint(bytes, 2)).toBe(7)
  })

  // Groups were removed from the language, so meeting one means these bytes are not the
  // message we took them for — parsing must stop rather than invent fields.
  it('stops at a group tag', () => {
    const bytes = Uint8Array.from([...varint(1 * 8 + 3), ...tagVarint(2, 7)])
    expect(protoVarint(bytes, 2)).toBeUndefined()
  })

  it('stops on a truncated length-delimited field rather than reading past the end', () => {
    const bytes = Uint8Array.from([...varint(1 * 8 + 2), 200, 1, 2])
    let visited = 0
    walk(bytes, () => {
      visited += 1
      return true
    })
    expect(visited).toBe(0)
  })

  // An absent field is a legitimate zero (cache_write is declared and never written), while a
  // value past the ceiling is a sentinel. The caller has to tell those apart.
  it('distinguishes an absent counter from an impossible one', () => {
    const present = Uint8Array.from(tagVarint(2, 42))
    expect(tokenCount(present, 2)).toBe(42)
    expect(tokenCount(present, 4)).toBe(0) // absent
    const absurd = Uint8Array.from(tagVarint(2, TOKEN_CEILING + 1))
    expect(tokenCount(absurd, 2)).toBeUndefined()
  })
})

describe('generation records', () => {
  it('maps the four counters and names the model', () => {
    const record = parseGenerationMetadata(
      genMetadata({ input: 100, output: 20, cacheWrite: 0, cacheRead: 500 }),
      'conv',
      1,
    )
    expect(record.entry).toMatchObject({
      id: 'antigravity|resp-1',
      input: 100,
      output: 20,
      cacheRead: 500,
      model: 'antigravity/gemini-3.6-flash',
    })
    expect(entryTotal(record.entry!)).toBe(620)
  })

  // A copied conversation must not read as fresh spend, so identity comes from the turn.
  it('keys on response_id, falling back to the file position', () => {
    expect(parseGenerationMetadata(genMetadata({ input: 5 }), 'conv', 7).entry?.id).toBe(
      'antigravity|resp-1',
    )
    expect(
      parseGenerationMetadata(genMetadata({ input: 5, responseID: null }), 'conv', 7).entry?.id,
    ).toBe('antigravity|conv|7')
  })

  // The prefix short-circuits the rate lookup: Antigravity is a subscription and bills no
  // per-token amount, so an estimate would be an invented bill.
  it('always prefixes the model so it stays unpriced', () => {
    expect(parseGenerationMetadata(genMetadata({ input: 5, model: null }), 'c', 0).entry?.model).toBe(
      'antigravity/unknown',
    )
  })

  it('discards an out-of-range counter without losing the record', () => {
    const record = parseGenerationMetadata(genMetadata({ input: TOKEN_CEILING + 1, output: 20 }), 'c', 0)
    expect(record.discardedCounters).toBe(1)
    expect(record.entry?.output).toBe(20)
    expect(record.entry?.input).toBe(0) // the bad counter is dropped, not clamped
  })

  it('yields nothing without a usable timestamp', () => {
    expect(
      parseGenerationMetadata(genMetadata({ input: 5, seconds: null }), 'c', 0).entry,
    ).toBeUndefined()
    // A malformed varint can carry the whole uint64 range; that is not a time.
    expect(parseGenerationMetadata(genMetadata({ input: 5, seconds: 5 }), 'c', 0).entry).toBeUndefined()
    expect(
      parseGenerationMetadata(genMetadata({ input: 5, seconds: 9_999_999_999 }), 'c', 0).entry,
    ).toBeUndefined()
  })

  it('yields nothing for an all-zero record', () => {
    expect(parseGenerationMetadata(genMetadata({ input: 0, output: 0 }), 'c', 0).entry).toBeUndefined()
  })

  it('yields nothing for bytes that are not this message', () => {
    expect(parseGenerationMetadata(Uint8Array.from([1, 2, 3]), 'c', 0).entry).toBeUndefined()
  })
})

describe('conversation stores', () => {
  async function writeConversation(dir: string, name: string, blobs: Uint8Array[]): Promise<void> {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)')
    blobs.forEach((blob, i) => {
      const stmt = db.prepare('INSERT INTO gen_metadata VALUES (?, ?)')
      stmt.run([i, blob])
      stmt.free()
    })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), Buffer.from(db.export()))
    db.close()
  }

  it('reads every conversation in the directory', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ptb-anti-')), 'conversations')
    await writeConversation(root, 'a.db', [genMetadata({ input: 100, responseID: 'r1' })])
    await writeConversation(root, 'b.db', [genMetadata({ input: 50, responseID: 'r2' })])
    const entries = await antigravityEntries(0, root)
    expect(entries.map((e) => e.id).sort()).toEqual(['antigravity|r1', 'antigravity|r2'])
  })

  it('applies the window on the parsed date, since it lives inside the protobuf', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ptb-anti-')), 'conversations')
    await writeConversation(root, 'a.db', [genMetadata({ input: 100 })])
    expect(await antigravityEntries(SECONDS * 1000 + 60_000, root)).toEqual([])
  })

  it('reports nothing when the CLI has never run', async () => {
    expect(await antigravityEntries(0, join(tmpdir(), 'no-such-antigravity'))).toEqual([])
  })

  it('skips a file that is not a conversation store', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ptb-anti-')), 'conversations')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'junk.db'), 'not a database', 'utf8')
    await writeConversation(root, 'good.db', [genMetadata({ input: 10 })])
    expect(await antigravityEntries(0, root)).toHaveLength(1)
  })
})
