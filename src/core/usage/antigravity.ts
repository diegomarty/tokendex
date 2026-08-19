/**
 * Antigravity CLI usage.
 *
 * The CLI writes one SQLite database per conversation under
 * `~/.gemini/antigravity-cli/conversations/<conversation>.db`, and keeps the per-call token
 * ledger inside a **protobuf blob**. It shares the `~/.gemini/` parent with Gemini CLI and
 * nothing else, so the Gemini file scan never sees any of it.
 *
 * The field numbers are the writer's own contract, read out of the `FileDescriptorProto` pool
 * the CLI binary embeds rather than inferred from samples. Two of them are shaped so that
 * guessing would have been wrong: `input_tokens` **excludes** cache reads (the opposite of
 * Gemini's `promptTokenCount`), and `output_tokens` is already the sum of its two siblings.
 *
 *     gen_metadata.data              exa.cortex_pb.CortexStepGeneratorMetadata
 *       1     chat_model               exa.cortex_pb.ChatModelMetadata
 *       1.4     usage                  exa.codeium_common_pb.ModelUsageStats
 *       1.4.2     input_tokens         prompt tokens, cache reads NOT included
 *       1.4.3     output_tokens        thinking + response output
 *       1.4.4     cache_write_tokens   declared, never written by this CLI
 *       1.4.5     cache_read_tokens    prompt cache hit
 *       1.4.11    response_id          globally unique per call
 *       1.9     chat_start_metadata    exa.cortex_pb.ChatStartMetadata
 *       1.9.4     created_at           google.protobuf.Timestamp
 *       1.19    response_model         e.g. "gemini-3.6-flash"
 *
 * There is no total field anywhere in the schema, so the total is the sum of the parts.
 */

import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import * as AppPaths from '../appPaths.js'
import { type Entry, appendAll, localDayKey } from './entry.js'
import { queryRows, withDatabase } from './sqlite.js'

// MARK: - Protobuf wire format

/**
 * Tokens are `uint64` on the wire. A value this far past the largest context window is a
 * sentinel, not a count, and widening it into arithmetic would poison every aggregate it
 * reaches — today's total, the burn tier, the companion.
 *
 * Deliberately tighter than the JSON readers' ceiling, and with a different remedy: those
 * clamp (they must survive sums taken straight after parsing), this **discards the counter**
 * and keeps the rest of the record. Nothing here adds two parsed values before the total, so
 * a tighter bound costs nothing.
 */
export const TOKEN_CEILING = 1_000_000_000

type Visit = (field: number, value: number, payload: Uint8Array | undefined) => boolean

function readVarint(data: Uint8Array, start: number): { value: number; next: number } | undefined {
  let value = 0
  let shift = 0
  let index = start
  while (index < data.length) {
    const byte = data[index]!
    index += 1
    // Assembled in floating point rather than with `<<`, which is 32-bit in JS and would
    // silently wrap a field number or a large count.
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: index }
    shift += 7
    if (shift > 63) return undefined // a varint is at most ten bytes
  }
  return undefined
}

/**
 * Visits each field in order until `visit` returns false or the bytes stop making sense.
 * Length-delimited fields arrive as `payload`, varints as `value`. Fixed-width fields are
 * skipped: nothing this reader wants is encoded that way.
 */
export function walk(data: Uint8Array, visit: Visit): void {
  let index = 0
  while (index < data.length) {
    const key = readVarint(data, index)
    if (key === undefined) return
    index = key.next
    const field = Math.floor(key.value / 8)
    if (field <= 0) return

    switch (key.value % 8) {
      case 0: {
        const value = readVarint(data, index)
        if (value === undefined) return
        index = value.next
        if (!visit(field, value.value, undefined)) return
        break
      }
      case 1:
        if (data.length - index < 8) return
        index += 8
        break
      case 2: {
        const length = readVarint(data, index)
        if (length === undefined || length.value > data.length - length.next) return
        const end = length.next + length.value
        if (!visit(field, 0, data.subarray(length.next, end))) return
        index = end
        break
      }
      case 5:
        if (data.length - index < 4) return
        index += 4
        break
      default:
        // Groups (3 and 4) were removed from the language, so meeting one means these bytes
        // are not the message we took them for.
        return
    }
  }
}

export function protoVarint(data: Uint8Array, field: number): number | undefined {
  let result: number | undefined
  walk(data, (number, value, payload) => {
    if (number !== field || payload !== undefined) return true
    result = value
    return false
  })
  return result
}

export function protoMessage(data: Uint8Array, field: number): Uint8Array | undefined {
  let result: Uint8Array | undefined
  walk(data, (number, _value, payload) => {
    if (number !== field || payload === undefined) return true
    result = payload
    return false
  })
  return result
}

export function protoString(data: Uint8Array, field: number): string | undefined {
  const payload = protoMessage(data, field)
  if (payload === undefined || payload.length === 0) return undefined
  const text = Buffer.from(payload).toString('utf8')
  return text === '' ? undefined : text
}

/**
 * `undefined` means the field was present and its value cannot be a count.
 *
 * That is not the same as the field being **absent**, which is a legitimate zero —
 * `cache_write_tokens` is declared and never written by this CLI — and the caller needs to
 * tell them apart to be able to say that a discard happened.
 */
export function tokenCount(data: Uint8Array, field: number): number | undefined {
  const value = protoVarint(data, field)
  if (value === undefined) return 0
  return value <= TOKEN_CEILING ? value : undefined
}

// MARK: - Records

export interface AntigravityRecord {
  entry?: Entry
  /** Counters dropped for exceeding the ceiling. Totalled by the scan rather than logged here. */
  discardedCounters: number
}

/** `chat_start_metadata.created_at`, a `google.protobuf.Timestamp`. */
function createdAt(chatModel: Uint8Array): number | undefined {
  const start = protoMessage(chatModel, 9)
  if (start === undefined) return undefined
  const stamp = protoMessage(start, 4)
  if (stamp === undefined) return undefined
  const seconds = protoVarint(stamp, 1)
  if (seconds === undefined) return undefined
  // A malformed varint can carry the whole uint64 range, and a date built from it would
  // overflow downstream arithmetic. Anything outside a plausible window is not a time.
  if (seconds < 1_000_000_000 || seconds > 4_102_444_800) return undefined
  const rawNanos = protoVarint(stamp, 2) ?? 0
  const nanos = rawNanos < 1_000_000_000 ? rawNanos : 0
  return seconds * 1000 + nanos / 1_000_000
}

export function parseGenerationMetadata(
  blob: Uint8Array,
  conversation: string,
  index: number,
): AntigravityRecord {
  const chatModel = protoMessage(blob, 1)
  if (chatModel === undefined) return { discardedCounters: 0 }
  const usage = protoMessage(chatModel, 4)
  if (usage === undefined) return { discardedCounters: 0 }
  const date = createdAt(chatModel)
  if (date === undefined) return { discardedCounters: 0 }

  // The turn's own id, not the file it happens to sit in: a copied conversation must not read
  // as fresh spend. `response_id` is populated on every recorded call.
  const responseID = protoString(usage, 11)
  const id =
    responseID === undefined ? `antigravity|${conversation}|${index}` : `antigravity|${responseID}`

  const counters = [
    tokenCount(usage, 2),
    tokenCount(usage, 3),
    tokenCount(usage, 4),
    tokenCount(usage, 5),
  ]
  const [input, output, cacheWrite, cacheRead] = counters
  const discardedCounters = counters.filter((c) => c === undefined).length

  const total = (input ?? 0) + (output ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0)
  if (total <= 0) return { discardedCounters }

  return {
    entry: {
      id,
      date,
      localDay: localDayKey(date),
      // The `antigravity/` prefix short-circuits the rate lookup: this is a subscription and
      // bills no per-token amount, so any estimate would be an invented bill.
      model: `antigravity/${protoString(chatModel, 19) ?? 'unknown'}`,
      input: input ?? 0,
      output: output ?? 0,
      cacheWrite: cacheWrite ?? 0,
      cacheRead: cacheRead ?? 0,
    },
    discardedCounters,
  }
}

// MARK: - Reading

/** One database per conversation. The directory is absent unless the CLI has run. */
export function defaultAntigravityRoot(home: string = AppPaths.home()): string {
  return join(home, '.gemini', 'antigravity-cli', 'conversations')
}

/**
 * Rows from one conversation store.
 *
 * `undefined` means the file could not be read as a conversation at all — missing, not a
 * database, or without the `gen_metadata` table. There is no partial-scan hazard: `sql.js`
 * reads a snapshot of the whole file, so a scan cannot end half-way because the CLI wrote to
 * it mid-read.
 */
export async function conversationEntries(
  database: string,
): Promise<{ entries: Entry[]; discardedCounters: number } | undefined> {
  const rows = await withDatabase(database, (db) =>
    queryRows(db, 'SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL'),
  )
  if (rows === undefined) return undefined

  const conversation = basename(database).replace(/\.db$/i, '')
  const entries: Entry[] = []
  let discardedCounters = 0

  for (const row of rows) {
    const data = row['data']
    if (!(data instanceof Uint8Array) || data.length === 0) continue
    const index = Number(row['idx'] ?? 0)
    const record = parseGenerationMetadata(data, conversation, index)
    discardedCounters += record.discardedCounters
    if (record.entry !== undefined) entries.push(record.entry)
  }
  return { entries, discardedCounters }
}

export interface AntigravityScan {
  entries: Entry[]
  /** Diagnostics worth logging: stores that could not be read, counters discarded. */
  notes: string[]
}

export async function antigravityScan(modifiedSince: number, root?: string): Promise<AntigravityScan> {
  const directory = root ?? defaultAntigravityRoot()
  let names: string[]
  try {
    names = (await fs.readdir(directory)).filter((n) => n.toLowerCase().endsWith('.db')).sort()
  } catch {
    return { entries: [], notes: [] } // the CLI has never run here
  }

  const entries: Entry[] = []
  const notes: string[] = []
  let unreadable = 0
  let discarded = 0

  for (const name of names) {
    const read = await conversationEntries(join(directory, name))
    if (read === undefined) {
      unreadable += 1
      continue
    }
    discarded += read.discardedCounters
    // The window is applied here rather than in the query: `created_at` lives inside the
    // protobuf, so it cannot be filtered in SQL.
    appendAll(
      entries,
      read.entries.filter((e) => e.date >= modifiedSince),
    )
  }

  if (unreadable > 0) notes.push(`antigravity: ${unreadable} conversation store(s) unreadable`)
  if (discarded > 0) notes.push(`antigravity: discarded ${discarded} out-of-range token counter(s)`)
  return { entries, notes }
}

export async function antigravityEntries(modifiedSince: number, root?: string): Promise<Entry[]> {
  return (await antigravityScan(modifiedSince, root)).entries
}
