/**
 * The SQLite-backed providers: OpenCode, Hermes, Cursor, Copilot and Kiro.
 *
 * Two shapes live here. OpenCode, Hermes and Kiro are re-read in full on every scan, because
 * their stores are rewritten in place and have no append-only id to resume from. Cursor and
 * Copilot are **append-only**, so they share one incremental scanner keyed on a per-database
 * high-water mark (#157 unified the two copies, so a watermark fix cannot land in only one).
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseISO8601 } from '../iso8601.js'
import type { Json } from '../models.js'
import { type Entry, appendAll, dedupKeepMax, localDayKey } from './entry.js'
import * as AppPaths from '../appPaths.js'
import { copilotHome, hermesHome, opencodeDataDir } from '../usageEnvironment.js'
import { queryRows, queryScalar, withDatabase } from './sqlite.js'

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// MARK: - Shared coercion

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function intValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  // Same whole-string rule as `doubleValue`: `parseInt` would also accept a prefix.
  const parsed = doubleValue(value)
  return parsed === undefined ? 0 : Math.max(0, Math.trunc(parsed))
}

/**
 * The **whole** string must be numeric.
 *
 * `parseFloat` takes a leading prefix, so an ISO date parses as its year:
 * `parseFloat('2026-07-03T12:00:00Z')` is 2026, which then reads as a timestamp in 1970.
 * Requiring the entire string to be numeric is what keeps a date column from being silently
 * misread as a number.
 */
function doubleValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Seconds or milliseconds since the epoch, or an ISO string. Returns epoch milliseconds. */
function dateValue(value: unknown): number | undefined {
  const numeric = doubleValue(value)
  if (numeric !== undefined && numeric > 0) {
    return numeric >= 100_000_000_000 ? numeric : numeric * 1000
  }
  if (typeof value === 'string') {
    const parsed = parseISO8601(value)
    if (parsed !== null) return parsed
  }
  return undefined
}

/**
 * Builds an entry, clamping negatives and reconciling against a reported total.
 *
 * When the parts fall short of the total the source reports, the remainder is attributed to
 * output — the same rule every reader here follows, so a changed breakdown never makes the
 * displayed total disagree with the source. A turn totalling zero yields no entry.
 */
function makeEntry(o: {
  id: string
  date: number
  model: string
  input?: number
  output?: number
  cacheWrite?: number
  cacheRead?: number
  total?: number
  cost?: number | undefined
}): Entry | undefined {
  const input = Math.max(0, o.input ?? 0)
  const cacheWrite = Math.max(0, o.cacheWrite ?? 0)
  const cacheRead = Math.max(0, o.cacheRead ?? 0)
  let output = Math.max(0, o.output ?? 0)

  const parts = input + output + cacheWrite + cacheRead
  const total = o.total ?? 0
  if (total > parts) output += total - parts
  if (input + output + cacheWrite + cacheRead <= 0) return undefined

  const entry: Entry = {
    id: o.id,
    date: o.date,
    localDay: localDayKey(o.date),
    model: o.model,
    input,
    output,
    cacheWrite,
    cacheRead,
  }
  if (o.cost !== undefined && o.cost > 0) entry.explicitCost = o.cost
  return entry
}

/** A path ending in one of `extensions` is the database itself; otherwise append `fileName`. */
function databasePath(root: string, fileName: string, extensions: string[]): string {
  const lower = root.toLowerCase()
  return extensions.some((ext) => lower.endsWith(ext)) ? root : join(root, fileName)
}

function envRoots(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
  return parts.length === 0 ? undefined : parts
}

// MARK: - OpenCode

export async function defaultOpenCodeRoots(): Promise<string[]> {
  return envRoots(await opencodeDataDir()) ?? [join(AppPaths.home(), '.local', 'share', 'opencode')]
}

export function parseOpenCodeMessage(object: Json, fallbackID: string): Entry | undefined {
  const tokens = object['tokens']
  if (!isObject(tokens)) return undefined
  const time = object['time']
  const date = dateValue(isObject(time) ? time['created'] : undefined)
  const model = stringValue(object['modelID'])
  // A message with no provider is not a billed turn.
  if (date === undefined || model === undefined || stringValue(object['providerID']) === undefined) {
    return undefined
  }
  const cache = tokens['cache']
  return makeEntry({
    id: `opencode|${stringValue(object['id']) ?? fallbackID}`,
    date,
    model,
    input: intValue(tokens['input']),
    output: intValue(tokens['output']),
    cacheWrite: intValue(isObject(cache) ? cache['write'] : undefined),
    cacheRead: intValue(isObject(cache) ? cache['read'] : undefined),
    total: intValue(tokens['total']),
    cost: doubleValue(object['cost']),
  })
}

/**
 * Picks the database inside an OpenCode root: the standard name, else a single
 * `opencode-<channel>.db`. The channel is validated so an arbitrary file cannot be opened
 * just because it happens to sit in the directory.
 */
async function preferredOpenCodeDatabase(root: string): Promise<string | undefined> {
  if (root.toLowerCase().endsWith('.db')) return root
  const standard = join(root, 'opencode.db')
  try {
    await fs.access(standard)
    return standard
  } catch {
    // fall through to the channel builds
  }
  try {
    const names = (await fs.readdir(root))
      .filter((name) => {
        if (!name.startsWith('opencode-') || !name.endsWith('.db')) return false
        const channel = name.slice('opencode-'.length, -'.db'.length)
        return channel !== '' && /^[A-Za-z0-9_-]+$/.test(channel)
      })
      .sort()
    return names[0] === undefined ? undefined : join(root, names[0])
  } catch {
    return undefined
  }
}

async function openCodeDatabaseEntries(database: string, modifiedSince: number): Promise<Entry[]> {
  const cutoff = Math.floor(modifiedSince)
  const rows = await withDatabase(database, (db) => {
    // Older OpenCode databases did not expose time_created as a column, so a failed query
    // (undefined, not []) falls back to the full table rather than reporting nothing.
    const recent = queryRows(db, 'SELECT id, session_id, data FROM message WHERE time_created >= ?', [
      cutoff,
    ])
    return recent ?? queryRows(db, 'SELECT id, session_id, data FROM message')
  })
  if (rows === undefined) return []

  const entries: Entry[] = []
  for (const row of rows) {
    const payload = row['data']
    const id = row['id']
    if (typeof payload !== 'string' || typeof id !== 'string') continue
    try {
      const object: unknown = JSON.parse(payload)
      if (!isObject(object)) continue
      const entry = parseOpenCodeMessage(object, id)
      if (entry !== undefined) entries.push(entry)
    } catch {
      continue
    }
  }
  return entries
}

export async function openCodeEntries(modifiedSince: number, roots?: string[]): Promise<Entry[]> {
  const sourceRoots = roots ?? (await defaultOpenCodeRoots())
  const entries: Entry[] = []
  for (const root of sourceRoots) {
    const database = await preferredOpenCodeDatabase(root)
    if (database !== undefined) appendAll(entries, await openCodeDatabaseEntries(database, modifiedSince))

    // Older installs kept one JSON file per message.
    const legacyRoot = join(root, 'storage', 'message')
    for (const file of await jsonFilesUnder(legacyRoot, modifiedSince)) {
      try {
        const object: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
        if (!isObject(object)) continue
        const fallback =
          file
            .split('/')
            .pop()
            ?.replace(/\.json$/, '') ?? file
        const entry = parseOpenCodeMessage(object, fallback)
        if (entry !== undefined) entries.push(entry)
      } catch {
        continue
      }
    }
  }
  return dedupKeepMax(entries.filter((e) => e.date >= modifiedSince))
}

async function jsonFilesUnder(root: string, modifiedSince: number): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        if ((await fs.stat(full)).mtimeMs >= modifiedSince) out.push(full)
      } catch {
        continue
      }
    }
  }
  await walk(root)
  return out
}

// MARK: - Hermes

export async function hermesEntries(modifiedSince: number, roots?: string[]): Promise<Entry[]> {
  const sourceRoots = roots ?? envRoots(await hermesHome()) ?? [join(AppPaths.home(), '.hermes')]
  const seen = new Set<string>()
  const entries: Entry[] = []

  for (const root of sourceRoots) {
    const database = databasePath(root, 'state.db', ['.db'])
    const rows = await withDatabase(database, (db) =>
      queryRows(
        db,
        `SELECT id, model, billing_provider, started_at, message_count,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                reasoning_tokens, estimated_cost_usd, actual_cost_usd
         FROM sessions
         WHERE model IS NOT NULL AND TRIM(model) != '' AND started_at >= ?`,
        [Math.floor(modifiedSince / 1000)],
      ),
    )
    for (const row of rows ?? []) {
      const id = stringValue(row['id'])
      const model = stringValue(row['model'])
      const date = dateValue(row['started_at'])
      if (id === undefined || model === undefined || date === undefined) continue
      if (date < modifiedSince) continue

      const actual = doubleValue(row['actual_cost_usd']) ?? 0
      const estimated = doubleValue(row['estimated_cost_usd']) ?? 0
      const entry = makeEntry({
        id: `hermes|${id}`,
        date,
        model,
        input: intValue(row['input_tokens']),
        // reasoning_tokens is billed on top of output here, unlike Copilot where it is a
        // breakdown of it.
        output: intValue(row['output_tokens']) + intValue(row['reasoning_tokens']),
        cacheWrite: intValue(row['cache_write_tokens']),
        cacheRead: intValue(row['cache_read_tokens']),
        cost: actual > 0 ? actual : estimated,
      })
      if (entry !== undefined && !seen.has(entry.id)) {
        seen.add(entry.id)
        entries.push(entry)
      }
    }
  }
  return entries
}

// MARK: - Incremental append-only stores (Cursor, Copilot)

export interface IncrementalResult {
  entries: Entry[]
  highWaterByPath: Record<string, number>
  /** True when any database was rescanned cold, so the caller must discard its cache. */
  didReset: boolean
}

interface RowQuery {
  sql: string
  params: unknown[]
}

interface IncrementalSpec {
  roots: string[]
  modifiedSince: number
  afterRowIDByPath: Record<string, number>
  databaseFor: (root: string) => string
  maxRowIDSQL: string
  rowQuery: (effectiveAfter: number, since: number) => RowQuery
  parse: (row: Record<string, unknown>, database: string) => Entry | undefined
}

async function loadIncrementalDatabase(
  database: string,
  spec: IncrementalSpec,
  afterRowID: number,
): Promise<{ entries: Entry[]; highWaterRowID: number; didReset: boolean }> {
  const loaded = await withDatabase(database, (db) => {
    // A failed MAX is **not** a shrink: opening or preparing can fail while the writer holds
    // the file. Collapsing that into 0 would wipe the cache for up to one refresh interval.
    const maxRowID = queryScalar(db, spec.maxRowIDSQL)
    if (maxRowID === undefined) return undefined

    const didReset = afterRowID > 0 && maxRowID < afterRowID
    const effectiveAfter = didReset ? 0 : afterRowID
    const query = spec.rowQuery(effectiveAfter, spec.modifiedSince)
    // An incomplete scan (BUSY, interrupt) also returns undefined — keep the prior watermark.
    const rows = queryRows(db, query.sql, query.params)
    if (rows === undefined) return undefined
    return { rows, didReset, effectiveAfter }
  })

  if (loaded === undefined) {
    return { entries: [], highWaterRowID: afterRowID, didReset: false }
  }

  let highWater = 0
  const entries: Entry[] = []
  for (const row of loaded.rows) {
    const rowID = Number(Object.values(row)[0] ?? 0)
    if (Number.isFinite(rowID)) highWater = Math.max(highWater, rowID)
    const entry = spec.parse(row, database)
    if (entry !== undefined) entries.push(entry)
  }
  // An incremental read that matched nothing must keep the watermark, or the next scan
  // replays the whole month.
  if (highWater === 0) highWater = loaded.effectiveAfter
  return { entries, highWaterRowID: highWater, didReset: loaded.didReset }
}

async function scanIncrementalRoots(
  spec: IncrementalSpec,
  marks: Record<string, number>,
): Promise<IncrementalResult> {
  const entries: Entry[] = []
  const highWaterByPath: Record<string, number> = {}
  let didReset = false

  for (const root of spec.roots) {
    const database = spec.databaseFor(root)
    const loaded = await loadIncrementalDatabase(database, spec, marks[database] ?? 0)
    appendAll(entries, loaded.entries)
    highWaterByPath[database] = loaded.highWaterRowID
    if (loaded.didReset) didReset = true
  }

  return {
    entries: dedupKeepMax(entries.filter((e) => e.date >= spec.modifiedSince)),
    highWaterByPath,
    didReset,
  }
}

export async function scanIncrementalStores(spec: IncrementalSpec): Promise<IncrementalResult> {
  const result = await scanIncrementalRoots(spec, spec.afterRowIDByPath)
  if (!result.didReset) return result
  // A partial incremental payload must not replace the cache, so every root is rescanned
  // cold. `didReset` stays true so the caller discards what it held rather than merging.
  const recovered = await scanIncrementalRoots(spec, {})
  return { ...recovered, didReset: true }
}

// MARK: - Cursor

/**
 * Cursor is a VS Code fork, so it stores under the editor config location rather than the
 * data one — the two differ on Linux.
 */
export function defaultCursorRoots(configHome: string = AppPaths.configHome()): string[] {
  return [
    join(configHome, 'Cursor', 'User', 'globalStorage'),
    join(configHome, 'Cursor Nightly', 'User', 'globalStorage'),
  ]
}

/**
 * `cursorDiskKV` is `key TEXT UNIQUE, value BLOB` with no time column, so the window is
 * applied to `createdAt` inside the JSON.
 *
 * A cold start uses the key index over `bubbleId:*`. An incremental pass needs `NOT INDEXED`:
 * without it SQLite prefers the key index and walks every bubble instead of only the rows
 * appended since the watermark.
 */
export function cursorRowQuery(effectiveAfter: number): RowQuery {
  if (effectiveAfter === 0) {
    return {
      sql: "SELECT rowid, key, value FROM cursorDiskKV WHERE key GLOB 'bubbleId:*'",
      params: [],
    }
  }
  return {
    sql: `SELECT rowid, key, value FROM cursorDiskKV NOT INDEXED
          WHERE rowid > ? AND key GLOB 'bubbleId:*'`,
    params: [effectiveAfter],
  }
}

/** Bubble schema: `tokenCount.{inputTokens, outputTokens}`, `createdAt`, nullable `modelType`. */
export function parseCursorBubble(object: Json, key: string, modifiedSince: number): Entry | undefined {
  const tokenCount = object['tokenCount']
  if (!isObject(tokenCount)) return undefined
  const input = intValue(tokenCount['inputTokens'])
  const output = intValue(tokenCount['outputTokens'])
  if (input + output <= 0) return undefined

  const date = dateValue(object['createdAt'])
  if (date === undefined || date < modifiedSince) return undefined

  return makeEntry({
    id: `cursor|${key}`,
    date,
    model: stringValue(object['modelType']) ?? 'unknown',
    input,
    output,
  })
}

export async function cursorEntries(
  modifiedSince: number,
  options: { roots?: string[]; afterRowIDByPath?: Record<string, number> } = {},
): Promise<IncrementalResult> {
  return scanIncrementalStores({
    roots: options.roots ?? defaultCursorRoots(),
    modifiedSince,
    afterRowIDByPath: options.afterRowIDByPath ?? {},
    databaseFor: (root) => databasePath(root, 'state.vscdb', ['.vscdb']),
    maxRowIDSQL: 'SELECT MAX(rowid) FROM cursorDiskKV',
    rowQuery: (effectiveAfter) => cursorRowQuery(effectiveAfter),
    parse: (row) => {
      const key = row['key']
      const payload = row['value']
      if (typeof key !== 'string') return undefined
      const text = typeof payload === 'string' ? payload : bufferToText(payload)
      if (text === undefined) return undefined
      try {
        const object: unknown = JSON.parse(text)
        return isObject(object) ? parseCursorBubble(object, key, modifiedSince) : undefined
      } catch {
        return undefined
      }
    },
  })
}

/** `value` is declared BLOB, so sql.js hands back a byte array rather than a string. */
function bufferToText(value: unknown): string | undefined {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return undefined
}

// MARK: - Copilot

export async function defaultCopilotRoots(): Promise<string[]> {
  return envRoots(await copilotHome()) ?? [join(AppPaths.home(), '.copilot')]
}

/**
 * Copilot writes ISO-8601 with a `Z`, while the column default (`datetime('now')`) writes
 * `YYYY-MM-DD HH:MM:SS` in UTC. Both are normalised to the same shape.
 */
export function copilotDate(raw: string): number | undefined {
  let text = raw.trim()
  if (text.length < 19) return undefined
  const space = text.indexOf(' ')
  if (space !== -1) text = `${text.slice(0, space)}T${text.slice(space + 1)}`
  const time = text.slice(11)
  if (!time.includes('Z') && !time.includes('+') && !time.includes('-')) text += 'Z'
  const parsed = parseISO8601(text)
  return parsed === null ? undefined : parsed
}

/**
 * Start of the UTC day *before* `date`, in SQLite's default text shape.
 *
 * `created_at` is text, so the cutoff is a lexicographic compare, not a time compare. It is
 * only a coarse prefilter — the scanner re-filters on parsed dates — but it must never drop a
 * row belonging in the window, because once a later id advances the watermark that row is
 * lost for good. A row carrying a UTC offset can render an earlier calendar day than the
 * instant it represents, so backing off a full day covers every offset SQLite accepts (±14h)
 * at the cost of one extra day of rows.
 */
export function copilotDayCutoff(millis: number): string {
  const d = new Date(millis - 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} 00:00:00`
}

export async function copilotEntries(
  modifiedSince: number,
  options: { roots?: string[]; afterRowIDByPath?: Record<string, number> } = {},
): Promise<IncrementalResult> {
  return scanIncrementalStores({
    roots: options.roots ?? (await defaultCopilotRoots()),
    modifiedSince,
    afterRowIDByPath: options.afterRowIDByPath ?? {},
    databaseFor: (root) => databasePath(root, 'session-store.db', ['.db']),
    maxRowIDSQL: 'SELECT MAX(id) FROM assistant_usage_events',
    rowQuery: (effectiveAfter, since) => ({
      sql: `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at
            FROM assistant_usage_events
            WHERE id > ? AND created_at >= ?`,
      params: [effectiveAfter, copilotDayCutoff(since)],
    }),
    parse: (row, database) => {
      const raw = row['created_at']
      if (typeof raw !== 'string') return undefined
      const date = copilotDate(raw)
      if (date === undefined) return undefined

      const cacheRead = intValue(row['cache_read_tokens'])
      const cacheWrite = intValue(row['cache_write_tokens'])
      return makeEntry({
        // The row id is unique only *within* one store, and `$COPILOT_HOME` may name several.
        // Without the database in the key, id 1 of each store would collapse during dedup and
        // that usage would silently vanish.
        id: `copilot|${database}|${Number(row['id'] ?? 0)}`,
        date,
        model: stringValue(row['model']) ?? 'unknown',
        // `input_tokens` is the whole prompt; cached reads and writes are a subset of it.
        // Subtracting keeps the same prompt tokens from being counted three times.
        input: Math.max(0, intValue(row['input_tokens']) - cacheRead - cacheWrite),
        // `reasoning_tokens` is a breakdown of `output_tokens`, not an extra charge.
        output: intValue(row['output_tokens']),
        cacheWrite,
        cacheRead,
      })
    },
  })
}

// MARK: - Kiro

export function defaultKiroRoots(appSupport: string = AppPaths.appSupport()): string[] {
  return [join(appSupport, 'kiro-cli')]
}

/** Bytes per token, used to turn estimated byte counts into an approximate count. */
const KIRO_BYTES_PER_TOKEN = 4

/**
 * Byte length of a turn's `user`/`assistant` field.
 *
 * `images` is excluded: a base64 blob would dwarf the actual text and is not separately
 * modelled here.
 */
function kiroFieldByteLength(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (!isObject(value)) return 0
  return Object.entries(value).reduce(
    (total, [key, v]) => (key === 'images' ? total : total + kiroJSONByteLength(v)),
    0,
  )
}

function kiroJSONByteLength(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length
  if (Array.isArray(value)) return value.reduce<number>((s, v) => s + kiroJSONByteLength(v), 0)
  if (isObject(value)) return Object.values(value).reduce<number>((s, v) => s + kiroJSONByteLength(v), 0)
  return 0
}

/**
 * Kiro has no server-side session: every turn resends the **whole** conversation, so a turn's
 * real prompt is the accumulated history plus its own new message.
 *
 * `request_metadata.user_prompt_length` is deliberately not used. In kiro-cli's upstream it is
 * assigned from `user_input_message.content.len()` — only the bytes just typed, excluding the
 * resent history entirely — so it undercounts a prompt by orders of magnitude once a
 * conversation has any length. `response_size` accumulates the actual streamed bytes and has
 * no such gap, so it is used as-is.
 */
export function kiroTurnEntries(conversationID: string, object: Json, modifiedSince: number): Entry[] {
  const turns = object['history']
  if (!Array.isArray(turns)) return []

  const entries: Entry[] = []
  // `latest_summary` stands in for turns compaction removed from `history`. They are still
  // resent on every later request, so they seed the running total.
  let cumulativeHistoryBytes = kiroJSONByteLength(object['latest_summary'] ?? 0)

  for (const turn of turns) {
    if (!isObject(turn)) continue
    const userBytes = kiroFieldByteLength(turn['user'])
    // Bytes accumulate even for turns skipped below: later turns still resend them.
    const advance = () => {
      cumulativeHistoryBytes += userBytes + kiroFieldByteLength(turn['assistant'])
    }

    const meta = turn['request_metadata']
    if (!isObject(meta)) {
      advance()
      continue
    }
    const rawTimestamp = doubleValue(meta['request_start_timestamp_ms'])
    const date = dateValue(meta['request_start_timestamp_ms'])
    // A turn with no timestamp has nothing stable to key an id on, so it is skipped rather
    // than given an invented one.
    if (rawTimestamp === undefined || rawTimestamp <= 0 || date === undefined || date < modifiedSince) {
      advance()
      continue
    }

    const entry = makeEntry({
      id: `kiro|${conversationID}|${Math.trunc(rawTimestamp)}`,
      date,
      model: stringValue(meta['model_id']) ?? 'unknown',
      input: Math.trunc((cumulativeHistoryBytes + userBytes) / KIRO_BYTES_PER_TOKEN),
      output: Math.trunc(intValue(meta['response_size']) / KIRO_BYTES_PER_TOKEN),
    })
    if (entry !== undefined) entries.push(entry)
    advance()
  }
  return entries
}

/**
 * Kiro stores a conversation as one row whose `value` holds the entire history as JSON,
 * rewritten in place every turn. There is no per-row token count and no append-only id to
 * watermark, so every stored conversation is re-parsed on each call.
 *
 * Two schema generations coexist: `conversations_v2` (kiro-cli < 2.0.1, with dedicated id
 * columns) and `conversations` (2.0.1+, keyed by working directory, with the id inside the
 * JSON). Both wrap the same turn shape, so they share a parser.
 */
export async function kiroEntries(modifiedSince: number, roots?: string[]): Promise<Entry[]> {
  const sourceRoots = roots ?? defaultKiroRoots()
  const entries: Entry[] = []

  for (const root of sourceRoots) {
    const database = databasePath(root, 'data.sqlite3', ['.sqlite3'])
    const loaded = await withDatabase(database, (db) => ({
      v2: queryRows(db, 'SELECT conversation_id, value FROM conversations_v2'),
      v1: queryRows(db, 'SELECT value FROM conversations'),
    }))
    if (loaded === undefined) continue

    for (const row of loaded.v2 ?? []) {
      const value = row['value']
      if (typeof value !== 'string') continue
      try {
        const object: unknown = JSON.parse(value)
        if (!isObject(object)) continue
        const id =
          stringValue(row['conversation_id']) ?? stringValue(object['conversation_id']) ?? database
        appendAll(entries, kiroTurnEntries(id, object, modifiedSince))
      } catch {
        continue
      }
    }

    for (const row of loaded.v1 ?? []) {
      const value = row['value']
      if (typeof value !== 'string') continue
      try {
        const object: unknown = JSON.parse(value)
        if (!isObject(object)) continue
        const id = stringValue(object['conversation_id'])
        if (id === undefined) continue
        appendAll(entries, kiroTurnEntries(id, object, modifiedSince))
      } catch {
        continue
      }
    }
  }
  return dedupKeepMax(entries)
}
