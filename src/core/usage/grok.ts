/**
 * Grok CLI session parsing.
 *
 * Source: `~/.grok/sessions/<id>/updates.jsonl`, reading only the `sessionUpdate:
 * "turn_completed"` lines that are appended durably at the end of each turn.
 *
 * The other token fields in the same file (`_meta.totalTokens`, auto-compact and subagent
 * progress events) are *context window sizes*, not usage — mixing them in inflates the totals
 * badly. Only `turn_completed.usage` counts.
 *
 * Turns discarded by a rewind still count: rewinding does not un-bill the tokens.
 */

import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseISO8601 } from '../iso8601.js'
import type { Json } from '../models.js'
import {
  type Entry,
  appendAll,
  boolValue,
  dedupKeepMax,
  doubleOrNil,
  intOrNil,
  localDayKey,
  nonEmpty,
} from './entry.js'
import { grokSessionsDir } from './roots.js'
import { jsonlFiles } from './scan.js'

/** The only file in a session directory that carries usage. */
export const GROK_UPDATES_FILE = 'updates.jsonl'

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Timestamps below this are seconds, above are milliseconds. Shared threshold with the other
 * local readers.
 */
const MILLIS_THRESHOLD = 100_000_000_000

/**
 * Turn time prefers `_meta.agentTimestampMs`, the moment the agent stamped that turn.
 *
 * The envelope `timestamp` is the moment it was *written*, and a fork re-stamps it while
 * copying the parent's updates — using it alone piles a forked session's entire history onto
 * the fork date, distorting today, this week and this month. `_meta` survives the copy with
 * only `sessionId` swapped, so it keeps the original time.
 */
function grokDate(envelope: Json, meta: Json | undefined): number | undefined {
  const ms = doubleOrNil(meta?.['agentTimestampMs']) ?? 0
  if (ms > 0) return ms

  const raw = doubleOrNil(envelope['timestamp']) ?? 0
  if (raw > 0) return raw >= MILLIS_THRESHOLD ? raw : raw * 1000

  const asString = envelope['timestamp']
  if (typeof asString === 'string') {
    const parsed = parseISO8601(asString)
    if (parsed !== null) return parsed
  }
  return undefined
}

/**
 * Display model name, chosen from the per-model breakdown: the row with the most tokens wins,
 * ties broken by name. The numbers themselves always come from the totals, so a row sum that
 * disagrees with the totals can never leak into what is displayed.
 */
function grokModel(usage: Json): string | undefined {
  const byModel = usage['modelUsage'] ?? usage['model_usage']
  if (!isObject(byModel)) return undefined

  let best: { model: string; total: number } | undefined
  for (const model of Object.keys(byModel).sort()) {
    const fields = byModel[model]
    const row = isObject(fields) ? fields : {}
    const total = intOrNil(row['totalTokens']) ?? intOrNil(row['total_tokens']) ?? 0
    if (best === undefined || total > best.total) best = { model, total }
  }
  return best === undefined ? undefined : nonEmpty(best.model)
}

/**
 * Only the server's own figure is used (1e10 ticks = $1). Partial or incomplete flags discard
 * it: there is no Grok rate table, so the alternative to a trusted number is 0, not a guess.
 */
function grokCost(usage: Json): number | undefined {
  if (boolValue(usage['usageIsIncomplete']) || boolValue(usage['usage_is_incomplete'])) return undefined
  if (boolValue(usage['costIsPartial']) || boolValue(usage['cost_is_partial'])) return undefined
  const ticks = doubleOrNil(usage['costUsdTicks']) ?? doubleOrNil(usage['cost_usd_ticks']) ?? 0
  return ticks > 0 ? ticks / 1e10 : undefined
}

function grokEntry(o: {
  turnID: string
  date: number
  usage: Json
  input: number
  output: number
  cacheRead: number
}): Entry | undefined {
  // A cancelled turn reports zero across the board; recording it would add a row that says
  // nothing.
  if (o.input + o.output + o.cacheRead <= 0) return undefined
  const entry: Entry = {
    id: `grok|${o.turnID}`,
    date: o.date,
    localDay: localDayKey(o.date),
    model: grokModel(o.usage) ?? 'grok',
    input: o.input,
    output: o.output,
    cacheWrite: 0,
    cacheRead: o.cacheRead,
  }
  const cost = grokCost(o.usage)
  if (cost !== undefined) entry.explicitCost = cost
  return entry
}

/**
 * Token mapping, arranged so `entryTotal === usage.totalTokens`:
 *
 * - `inputTokens` (camelCase) is the **whole prompt including cache reads**, so the cached
 *   part is subtracted out.
 * - `input_tokens` (snake_case) **already excludes** the cache. The two spellings mean
 *   different things, and treating them alike subtracts the cache twice.
 * - `output = outputTokens` (reasoning is already inside it) and `cacheWrite = 0`, because
 *   Grok folds cache writes into the prompt tokens.
 */
export function parseGrokLine(line: string): Entry | undefined {
  let envelope: unknown
  try {
    envelope = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(envelope)) return undefined

  // Three layers on disk: envelope -> notification -> update. Older lines have no `method`
  // and are the notification itself, with no envelope around it.
  const params = envelope['params']
  const notification = isObject(params) ? params : envelope

  const update = notification['update']
  if (!isObject(update) || update['sessionUpdate'] !== 'turn_completed') return undefined
  const usage = update['usage']
  if (!isObject(usage)) return undefined

  const metaRaw = notification['_meta']
  const meta = isObject(metaRaw) ? metaRaw : undefined
  // Replay markers usually exist only on the transport, not on disk, so this is a secondary
  // guard; the turn-id de-duplication below is the real defence.
  if (boolValue(meta?.['isReplay'])) return undefined

  // `prompt_id` is the only turn identifier. It is globally unique and carries no session
  // path, so a fork that copies its parent's updates folds onto the same turn. Alternatives
  // such as `_meta.eventId` are not globally unique and would merge turns across sessions.
  const turnID = nonEmpty(typeof update['prompt_id'] === 'string' ? update['prompt_id'] : undefined)
  if (turnID === undefined) return undefined
  const date = grokDate(envelope, meta)
  if (date === undefined) return undefined

  // `intOrNil` rather than a presence check: an explicit `null` read as "present" would
  // subtract the wrong cache figure or zero the tokens.
  const output = intOrNil(usage['outputTokens']) ?? intOrNil(usage['output_tokens']) ?? 0
  const reportedCacheRead =
    intOrNil(usage['cachedReadTokens']) ?? intOrNil(usage['cached_read_tokens']) ?? 0

  let input: number
  let cacheRead: number
  const full = intOrNil(usage['inputTokens'])
  if (full !== undefined) {
    // Cache reads are a subset of the prompt and cannot exceed it. Clamping preserves the
    // identity; folding with max(0, ...) instead let input + cacheRead exceed inputTokens and
    // silently inflated the total.
    const clamped = Math.min(reportedCacheRead, full)
    input = full - clamped
    cacheRead = clamped
  } else {
    input = intOrNil(usage['input_tokens']) ?? 0
    cacheRead = reportedCacheRead
  }

  // When the parts disagree with the total the source reports, the remainder is attributed to
  // output so the total still matches the source — the same rule the other readers follow.
  const reportedTotal = intOrNil(usage['totalTokens']) ?? intOrNil(usage['total_tokens'])
  if (reportedTotal !== undefined) {
    const parts = input + output + cacheRead
    if (reportedTotal > parts) {
      return grokEntry({
        turnID,
        date,
        usage,
        input,
        output: output + (reportedTotal - parts),
        cacheRead,
      })
    }
  }
  return grokEntry({ turnID, date, usage, input, output, cacheRead })
}

export async function parseGrokFile(path: string): Promise<Entry[]> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch {
    return []
  }
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    // updates.jsonl records every streaming chunk too — tens of thousands of lines per
    // session — so lines are filtered as strings before any JSON parsing.
    if (!line.includes('turn_completed')) continue
    const entry = parseGrokLine(line)
    if (entry !== undefined) out.push(entry)
  }
  return dedupKeepMax(out)
}

/**
 * Is this session a subagent?
 *
 * Subagent tokens are already folded into the parent turn's usage, so counting them again is
 * double counting. The signal is `session_kind` in the sibling `summary.json`, the same test
 * the CLI uses to hide them from its session list.
 *
 * A missing or unreadable file means a user session: the CLI writes the summary when it
 * creates a session, so absence means "new session with no turns yet" — nothing to count.
 *
 * `hidden` is deliberately not used: a user who hid a normal session would drop out of the
 * totals. A subagent always has `session_kind` set at creation, so this signal alone suffices.
 */
async function sessionIsSubagent(sessionDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(join(sessionDir, 'summary.json'), 'utf8')
    const obj: unknown = JSON.parse(raw)
    if (!isObject(obj)) return false
    const kind = obj['session_kind']
    return typeof kind === 'string' && kind.startsWith('subagent')
  } catch {
    return false
  }
}

/**
 * Eligible for aggregation: the `updates.jsonl` of a non-subagent session.
 *
 * **This is decided at file-selection time, never inside parsing.** The blob cache is
 * invalidated by `updates.jsonl`'s own mtime and size, but the evidence for this decision is a
 * *sibling* file. Filtering during parsing would freeze a subagent session parsed before its
 * summary had `session_kind` into the cache, making the double count permanent because the
 * file never changes again. Selection is re-evaluated on every refresh, so it self-heals.
 *
 * Known limitation: a subagent that finishes after its parent turn folds into the session
 * ledger rather than the parent prompt ledger, so that much is under-counted. That is smaller
 * than double counting every turn, and in that case the CLI also flags the parent bill with
 * `usageIsIncomplete`, which drops the cost from the trusted set anyway.
 */
export async function isGrokUsageFile(path: string): Promise<boolean> {
  if (basename(path) !== GROK_UPDATES_FILE) return false
  return !(await sessionIsSubagent(dirname(path)))
}

export async function grokEntries(modifiedSince: number, root?: string): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const file of await jsonlFiles(root ?? (await grokSessionsDir()), modifiedSince)) {
    if (!(await isGrokUsageFile(file.path))) continue
    appendAll(entries, await parseGrokFile(file.path))
  }
  // A fork copying its parent's updates keeps the same turn ids, so the global pass counts
  // each turn once.
  return dedupKeepMax(entries)
}
