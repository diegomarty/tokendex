/**
 * Codex rollout parsing.
 *
 * Source: `~/.codex/sessions/**\/rollout-*.jsonl`, `event_msg.payload.type:"token_count"`
 * records carrying `info.last_token_usage` (the per-turn delta).
 *
 * Token mapping: input (uncached) = input_tokens - cached_input_tokens,
 * cacheRead = cached_input_tokens, output = output_tokens (reasoning is already inside it),
 * cacheWrite = 0.
 *
 * The hard part is forks. A forked session replays its parent's turns into its own file, so
 * a rollout cannot determine its own usage in isolation — the replayed prefix has to be
 * matched against the resolved parent and trimmed.
 */

import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { parseISO8601 } from '../iso8601.js'
import type { Json } from '../models.js'
import { type Entry, appendAll, intOrNil, intValue, localDayKey } from './entry.js'
import { codexSessionsDir } from './roots.js'

/** Fork replay is written milliseconds apart; the first longer gap starts real child turns. */
const FORK_REPLAY_MAXIMUM_GAP_MS = 1000

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(line: string): Json | undefined {
  try {
    const v: unknown = JSON.parse(line)
    return isObject(v) ? v : undefined
  } catch {
    return undefined
  }
}

// MARK: - Usage vectors

export interface CodexUsageVector {
  input: number
  cachedInput: number
  cacheWriteInput: number
  output: number
  reasoningOutput: number
  total: number
}

/**
 * Cumulative usage is read with `intOrNil`: values like `1e30` turn up in these files, and
 * the offending file stays on disk, so an unguarded read would break every relaunch.
 */
export function usageVector(raw: Json): CodexUsageVector {
  return {
    input: intOrNil(raw['input_tokens']) ?? 0,
    cachedInput: intOrNil(raw['cached_input_tokens']) ?? 0,
    cacheWriteInput: intOrNil(raw['cache_write_input_tokens']) ?? 0,
    output: intOrNil(raw['output_tokens']) ?? 0,
    reasoningOutput: intOrNil(raw['reasoning_output_tokens']) ?? 0,
    total: intOrNil(raw['total_tokens']) ?? 0,
  }
}

export function vectorFingerprint(v: CodexUsageVector): string {
  return `${v.input},${v.cachedInput},${v.cacheWriteInput},${v.output},${v.reasoningOutput},${v.total}`
}

/** True when any component regressed — the signal that a new cumulative epoch started. */
export function isLower(v: CodexUsageVector, previous: CodexUsageVector): boolean {
  return (
    v.input < previous.input ||
    v.cachedInput < previous.cachedInput ||
    v.cacheWriteInput < previous.cacheWriteInput ||
    v.output < previous.output ||
    v.reasoningOutput < previous.reasoningOutput ||
    v.total < previous.total
  )
}

export interface CodexUsageState {
  cumulative: CodexUsageVector
  last: CodexUsageVector
}

/** The fingerprint is injective over the fields, so string equality is struct equality. */
export function stateFingerprint(s: CodexUsageState): string {
  return `${vectorFingerprint(s.cumulative)}|${vectorFingerprint(s.last)}`
}

function sameState(a: CodexUsageState | undefined, b: CodexUsageState | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return stateFingerprint(a) === stateFingerprint(b)
}

// MARK: - Rollout shapes

export interface CodexUsageEvent {
  entry: Entry
  usageState?: CodexUsageState
  sessionID?: string
}

export interface CodexParsedRollout {
  path: string
  sessionID?: string
  parentSessionID?: string
  forkedAt?: number
  isSubagent: boolean
  events: CodexUsageEvent[]
}

interface CodexResolvedEvent {
  entry: Entry
  usageState?: CodexUsageState
}

interface CodexResolvedRollout {
  history: CodexResolvedEvent[]
  ownedEntries: Entry[]
}

export interface CodexRolloutFile {
  path: string
  /** Epoch milliseconds. */
  mtime: number
  size: number
}

interface CodexSessionMeta {
  id?: string
  parentID?: string
  date?: number
  isSubagent: boolean
}

// MARK: - Line parsing

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function codexSessionMeta(line: string): CodexSessionMeta | undefined {
  const obj = parseJsonObject(line)
  if (obj === undefined || obj['type'] !== 'session_meta') return undefined
  const payload = obj['payload']
  if (!isObject(payload)) return undefined

  const source = payload['source']
  const meta: CodexSessionMeta = {
    isSubagent:
      payload['thread_source'] === 'subagent' ||
      (isObject(source) && source['subagent'] !== undefined && source['subagent'] !== null),
  }
  // For a subagent, `id` is the child and `session_id` may be the parent, so `id` wins.
  const id = nonEmptyString(payload['id']) ?? nonEmptyString(payload['session_id'])
  if (id !== undefined) meta.id = id
  const parentID =
    nonEmptyString(payload['forked_from_id']) ?? nonEmptyString(payload['parent_thread_id'])
  if (parentID !== undefined) meta.parentID = parentID
  const ts = obj['timestamp']
  if (typeof ts === 'string') {
    const date = parseISO8601(ts)
    if (date !== null) meta.date = date
  }
  return meta
}

export function codexModel(line: string): string | undefined {
  const obj = parseJsonObject(line)
  if (obj === undefined) return undefined
  const payload = obj['payload']
  if (!isObject(payload)) return undefined
  if (typeof payload['model'] === 'string') return payload['model']
  const turnContext = payload['turn_context']
  if (isObject(turnContext) && typeof turnContext['model'] === 'string') return turnContext['model']
  return undefined
}

interface ParsedCodexToken {
  entry: Entry
  /** Older records may carry no cumulative usage; those skip same-state comparison. */
  usageState?: CodexUsageState
}

function parseCodexLine(
  line: string,
  file: string,
  turn: number,
  model: string,
): ParsedCodexToken | undefined {
  const obj = parseJsonObject(line)
  if (obj === undefined) return undefined
  const payload = obj['payload']
  if (!isObject(payload) || payload['type'] !== 'token_count') return undefined
  const info = payload['info']
  if (!isObject(info)) return undefined
  const last = info['last_token_usage']
  if (!isObject(last)) return undefined
  const ts = obj['timestamp']
  if (typeof ts !== 'string') return undefined
  const date = parseISO8601(ts)
  if (date === null) return undefined

  const inputTotal = intValue(last['input_tokens'])
  const cached = intValue(last['cached_input_tokens'])

  const parsed: ParsedCodexToken = {
    entry: {
      id: `codex|${file}|${turn}`,
      date,
      localDay: localDayKey(date),
      model,
      input: Math.max(0, inputTotal - cached),
      output: intValue(last['output_tokens']),
      cacheWrite: 0,
      cacheRead: cached,
    },
  }
  const totalUsage = info['total_token_usage']
  if (isObject(totalUsage)) {
    parsed.usageState = { cumulative: usageVector(totalUsage), last: usageVector(last) }
  }
  return parsed
}

// MARK: - Rollout parsing

/** Parses one file in isolation. Whether a prefix is fork replay needs other rollouts. */
export async function parseCodexRollout(path: string): Promise<CodexParsedRollout> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch {
    return { path, isSubagent: false, events: [] }
  }

  const rollout: CodexParsedRollout = { path, isSubagent: false, events: [] }
  const file = basename(path)
  let turn = 0
  let currentSessionID: string | undefined
  let previousUsage: { sessionID: string; state: CodexUsageState } | undefined
  // The real model is extracted dynamically below so new models need no change here. This
  // value is only the fallback for a session with no model line at all; Codex cost is always
  // 0, so it never affects a displayed number.
  let model = 'codex'
  let sawMeta = false

  for (const line of text.split('\n')) {
    if (line === '') continue

    // NOTE: adding a `line.includes('session_meta')` pre-filter here makes this *slower*.
    // Measured over 57 real rollouts (release build): 1.80s without vs 2.17s with. The
    // intuition that "parsing fewer lines is faster" is wrong at this spot.
    const meta = codexSessionMeta(line)
    if (meta !== undefined) {
      if (!sawMeta) {
        sawMeta = true
        if (meta.id !== undefined) rollout.sessionID = meta.id
        if (meta.parentID !== undefined) rollout.parentSessionID = meta.parentID
        if (meta.date !== undefined) rollout.forkedAt = meta.date
        rollout.isSubagent = meta.isSubagent
      }
      if (meta.id !== undefined && meta.id !== currentSessionID) {
        currentSessionID = meta.id
        previousUsage = undefined
      }
    }

    if (line.includes('"model"')) {
      const m = codexModel(line)
      if (m !== undefined) model = m
    }
    if (!line.includes('token_count')) continue

    const parsed = parseCodexLine(line, file, turn, model)
    if (parsed === undefined) continue
    turn += 1

    // Codex can re-record an identical cumulative/last state. Normalise inside the file
    // before replay trimming: consecutive same-session records whose full vectors match
    // contribute no new tokens, so only one is kept.
    if (parsed.usageState !== undefined && currentSessionID !== undefined) {
      if (
        previousUsage !== undefined &&
        previousUsage.sessionID === currentSessionID &&
        sameState(previousUsage.state, parsed.usageState)
      ) {
        continue
      }
      previousUsage = { sessionID: currentSessionID, state: parsed.usageState }
    } else {
      previousUsage = undefined
    }

    const event: CodexUsageEvent = { entry: parsed.entry }
    if (parsed.usageState !== undefined) event.usageState = parsed.usageState
    if (currentSessionID !== undefined) event.sessionID = currentSessionID
    rollout.events.push(event)
  }
  return rollout
}

// MARK: - Fork resolution

/**
 * Length of the comparable common prefix of full usage states. `undefined` does NOT mean
 * "prefix 0" — it means the structural comparison is impossible because cumulative state is
 * missing.
 */
function comparableUsagePrefixCount(
  child: CodexUsageEvent[],
  parent: CodexResolvedEvent[],
): number | undefined {
  if (child.length === 0) return 0
  if (parent.length === 0) return undefined
  let count = 0
  while (count < child.length && count < parent.length) {
    const childState = child[count]?.usageState
    const parentState = parent[count]?.usageState
    if (childState === undefined || parentState === undefined) return undefined
    if (!sameState(childState, parentState)) break
    count += 1
  }
  return count
}

/**
 * Timing heuristic used only when the parent cannot be found.
 *
 * Confirmed 0.142.5/0.145.0 subagents insert parent metadata but do NOT replay token_count,
 * so discarding their first real turn just because the parent file was deleted would be
 * wrong — hence the early return.
 */
function fallbackReplayCount(rollout: CodexParsedRollout): number {
  if (rollout.isSubagent) return 0
  const events = rollout.events
  if (events.length <= 1) return events.length === 0 ? 0 : 1
  let count = 1
  while (count < events.length) {
    const gap = events[count]!.entry.date - events[count - 1]!.entry.date
    if (!(gap < FORK_REPLAY_MAXIMUM_GAP_MS)) break
    count += 1
  }
  return count
}

function withID(entry: Entry, id: string): Entry {
  return { ...entry, id }
}

function resolveOwnedEvents(
  rollout: CodexParsedRollout,
  replayCount: number,
  inheritedHistory: CodexResolvedEvent[] = [],
): CodexResolvedRollout {
  const history = [...inheritedHistory]
  const ownedEntries: Entry[] = []
  let epoch = 0
  let previousCumulative: CodexUsageVector | undefined
  let previousOwner: string | undefined
  let ownerSeen = false

  for (const event of rollout.events.slice(replayCount)) {
    // An unmatched suffix in a fork file belongs to the child even when it sits after an
    // embedded parent meta. In a non-fork file, a genuine session switch follows the
    // event's own session id.
    const owner =
      rollout.parentSessionID === undefined ? (event.sessionID ?? rollout.sessionID) : rollout.sessionID

    if (!ownerSeen || owner !== previousOwner) {
      epoch = 0
      previousCumulative = undefined
      previousOwner = owner
      ownerSeen = true
    }

    const cumulative = event.usageState?.cumulative
    if (cumulative !== undefined) {
      if (previousCumulative !== undefined && isLower(cumulative, previousCumulative)) epoch += 1
      previousCumulative = cumulative
    } else {
      previousCumulative = undefined
    }

    // Records with no cumulative usage or no session id keep their positional id.
    const entry =
      owner !== undefined && event.usageState !== undefined
        ? withID(event.entry, `codex|${owner}|${epoch}|${stateFingerprint(event.usageState)}`)
        : event.entry

    ownedEntries.push(entry)
    const resolved: CodexResolvedEvent = { entry }
    if (event.usageState !== undefined) resolved.usageState = event.usageState
    history.push(resolved)
  }
  return { history, ownedEntries }
}

/**
 * Keeps the earliest record when the same canonical state survives in several files. The
 * token vector is part of the id, so keep-earliest — not keep-max — matches Codex's date
 * semantics.
 */
function dedupCodexCanonicalEntries(entries: Entry[]): Entry[] {
  const byID = new Map<string, Entry>()
  const order: string[] = []
  for (const entry of entries) {
    const existing = byID.get(entry.id)
    if (existing === undefined) {
      byID.set(entry.id, entry)
      order.push(entry.id)
    } else if (entry.date < existing.date) {
      byID.set(entry.id, entry)
    }
  }
  return order.map((id) => byID.get(id)!).filter((e): e is Entry => e !== undefined)
}

export function resolveCodexRollouts(
  rollouts: CodexParsedRollout[],
  includedPaths: Set<string>,
): Entry[] {
  const bySession = new Map<string, CodexParsedRollout[]>()
  for (const rollout of rollouts) {
    if (rollout.sessionID === undefined) continue
    const list = bySession.get(rollout.sessionID) ?? []
    list.push(rollout)
    bySession.set(rollout.sessionID, list)
  }
  for (const list of bySession.values()) list.sort((a, b) => (a.path < b.path ? -1 : 1))

  const byPath = new Map(rollouts.map((r) => [r.path, r]))
  const memo = new Map<string, CodexResolvedRollout>()

  function resolve(rollout: CodexParsedRollout, visiting: Set<string>): CodexResolvedRollout {
    const cached = memo.get(rollout.path)
    if (cached !== undefined) return cached
    if (visiting.has(rollout.path)) {
      return resolveOwnedEvents(rollout, fallbackReplayCount(rollout))
    }
    visiting.add(rollout.path)
    try {
      let best: { replayCount: number; history: CodexResolvedEvent[] } | undefined
      if (rollout.parentSessionID !== undefined) {
        for (const candidate of bySession.get(rollout.parentSessionID) ?? []) {
          if (candidate.path === rollout.path) continue
          const resolvedParent = resolve(candidate, visiting)
          // A zero-length overlap means there is no evidence to compare against. Counting it
          // as a match would trim nothing AND skip the timing fallback, leaving the result
          // worse than having found no parent at all (a fork whose very first vector differs
          // because the CLI changed). Filtering here keeps `best` to parents that genuinely
          // share a prefix.
          const replayCount = comparableUsagePrefixCount(rollout.events, resolvedParent.history)
          if (replayCount === undefined || replayCount <= 0) continue
          if (best === undefined || replayCount > best.replayCount) {
            best = { replayCount, history: resolvedParent.history }
          }
        }
      }

      let resolved: CodexResolvedRollout
      if (best !== undefined) {
        resolved = resolveOwnedEvents(rollout, best.replayCount, best.history.slice(0, best.replayCount))
      } else if (rollout.parentSessionID !== undefined) {
        // Parent missing, or an older record has no cumulative state so structural
        // comparison is impossible. Real subagents are preserved by fallbackReplayCount;
        // only manual forks fall back to the timing heuristic.
        resolved = resolveOwnedEvents(rollout, fallbackReplayCount(rollout))
      } else {
        resolved = resolveOwnedEvents(rollout, 0)
      }
      memo.set(rollout.path, resolved)
      return resolved
    } finally {
      visiting.delete(rollout.path)
    }
  }

  const result: Entry[] = []
  for (const path of [...includedPaths].sort()) {
    const rollout = byPath.get(path)
    if (rollout === undefined) continue
    appendAll(result, resolve(rollout, new Set()).ownedEntries)
  }
  return dedupCodexCanonicalEntries(result)
}

// MARK: - Parent closure

export type SessionIDKnowledge = { known: true; id?: string } | { known: false }

/**
 * Can this id narrow parent candidates by filename substring?
 *
 * Degenerate values (empty, or separators like `"-"`) match almost every rollout filename,
 * so the filter stops filtering and every rollout gets fully parsed — measured at 300 files:
 * 0.009s -> 18.2s. This is only a cheap pre-filter; passing it still requires a content check.
 */
export function isUsableFilenameHint(id: string): boolean {
  return id.length >= 4 && /[\p{L}\p{N}]/u.test(id)
}

/**
 * Starting from rollouts inside the lookup window, pulls in the parents (and their parents)
 * needed for replay comparison, because a Codex fork cannot determine its own usage alone.
 *
 * The reader (direct parsing) and the cache (blob reuse) share this single expansion rule and
 * inject only the three things that differ — parsing, already-known session ids, and content
 * probing. Duplicating the rule would let one side be fixed while the other's tests stay green.
 */
export async function expandCodexParentClosure(args: {
  windowFiles: CodexRolloutFile[]
  allFiles: CodexRolloutFile[]
  load: (file: CodexRolloutFile) => Promise<CodexParsedRollout>
  sessionIDKnowledge: (file: CodexRolloutFile) => SessionIDKnowledge
  probeSessionID: (file: CodexRolloutFile) => Promise<string | undefined>
}): Promise<{ rollouts: CodexParsedRollout[]; includedPaths: Set<string> }> {
  const { windowFiles, allFiles, load, sessionIDKnowledge, probeSessionID } = args

  const rolloutsByPath = new Map<string, CodexParsedRollout>()
  for (const file of windowFiles) {
    const rollout = await load(file)
    rolloutsByPath.set(rollout.path, rollout)
  }
  const includedPaths = new Set(windowFiles.map((f) => f.path))

  const pending = new Set<string>()
  for (const r of rolloutsByPath.values()) {
    if (r.parentSessionID !== undefined) pending.add(r.parentSessionID)
  }
  const searched = new Set<string>()

  const nextPending = () => [...pending].find((id) => !searched.has(id))

  for (let parentID = nextPending(); parentID !== undefined; parentID = nextPending()) {
    searched.add(parentID)
    if ([...rolloutsByPath.values()].some((r) => r.sessionID === parentID)) continue

    // Hints only choose candidates; adoption is decided by the payload's session id alone.
    const adopt = async (candidates: CodexRolloutFile[]): Promise<boolean> => {
      let resolved = false
      for (const candidate of candidates) {
        const parent = await load(candidate)
        if (parent.sessionID !== parentID) continue
        rolloutsByPath.set(parent.path, parent)
        resolved = true
        if (parent.parentSessionID !== undefined) pending.add(parent.parentSessionID)
      }
      return resolved
    }

    const unresolved = allFiles.filter((f) => !rolloutsByPath.has(f.path))
    // Narrow by known session id and filename first — without opening anything.
    const hinted = unresolved.filter((f) => {
      const knowledge = sessionIDKnowledge(f)
      if (knowledge.known) {
        // A file whose session id is known is judged by that value only. Also looking at the
        // filename would re-select files with a different id, re-parsing them fully on every
        // refresh even with a warm index.
        return knowledge.id === parentID
      }
      return isUsableFilenameHint(parentID) && basename(f.path).includes(parentID)
    })
    if (await adopt(hinted)) continue

    // No hints, or all of them failed verification: open only the files whose content we
    // still need. Files with a known session id are skipped — it is not parentID.
    const hintedPaths = new Set(hinted.map((f) => f.path))
    const probeTargets: CodexRolloutFile[] = []
    for (const f of unresolved) {
      if (hintedPaths.has(f.path)) continue
      if (sessionIDKnowledge(f).known) continue
      if ((await probeSessionID(f)) === parentID) probeTargets.push(f)
    }
    await adopt(probeTargets)
  }

  return { rollouts: [...rolloutsByPath.values()], includedPaths }
}

// MARK: - Session-id probe

const PROBE_CHUNK_SIZE = 64 * 1024

/**
 * Byte ceiling for the probe. Reaching it mid-line still stops here, so an abnormally long
 * single line is bounded by the same budget. Metadata beyond it yields undefined, demoting
 * the rollout to the timing fallback. Measured: the first `session_meta` line is ~22KB median
 * and ~46KB max (mostly `dynamic_tools` / `base_instructions`), so 1MiB is ~22x headroom.
 */
export const CODEX_PROBE_BYTE_LIMIT = 1 << 20

type ProbeOutcome =
  | { kind: 'sessionID'; id?: string }
  | { kind: 'stop' } // reached token_count with no metadata before it
  | { kind: 'invalid' } // a non-empty line is not UTF-8
  | { kind: 'keepScanning' }

function probeOutcome(line: Buffer): ProbeOutcome {
  if (line.length === 0) return { kind: 'keepScanning' }
  let text: string
  try {
    // Strict decoding on purpose: Node would otherwise substitute U+FFFD and hide the
    // corruption. Skipping a corrupted line risks mistaking a later re-inserted parent meta
    // for this file's own id, so we stop instead.
    text = new TextDecoder('utf-8', { fatal: true }).decode(line)
  } catch {
    return { kind: 'invalid' }
  }
  const meta = codexSessionMeta(text)
  if (meta !== undefined)
    return meta.id === undefined ? { kind: 'sessionID' } : { kind: 'sessionID', id: meta.id }
  if (text.includes('token_count')) return { kind: 'stop' }
  return { kind: 'keepScanning' }
}

/**
 * Metadata-only probe for locating an older parent dependency without reading a large
 * rollout in full.
 *
 * **A fixed-size prefix must not be decoded whole.** If the cut lands mid-character, strict
 * decoding fails for the entire buffer (measured: 14 of 109 local rollouts failed at the 64KB
 * boundary), which would be reported as "no session id". So chunks are read but only
 * newline-terminated lines are decoded.
 *
 * `undefined` means the file was read fine but carries no usable metadata — a deterministic
 * property of its content, so retrying changes nothing. Failing to open or read **throws**:
 * merging those would let a transient I/O error freeze into the cache as "no session id"
 * until the file's mtime or size changes.
 */
export async function probeCodexRolloutSessionID(
  path: string,
  byteLimit: number = CODEX_PROBE_BYTE_LIMIT,
): Promise<string | undefined> {
  const handle = await fs.open(path, 'r')
  try {
    let buffer = Buffer.alloc(0)
    let read = 0
    while (read < byteLimit) {
      // Read only up to the remaining budget so the ceiling is exact (and never request 0
      // bytes, which would look like EOF).
      const want = Math.min(PROBE_CHUNK_SIZE, byteLimit - read)
      const chunk = Buffer.alloc(want)
      const { bytesRead } = await handle.read(chunk, 0, want, null)
      if (bytesRead === 0) {
        // EOF — a final line without a trailing newline still counts as complete.
        const outcome = probeOutcome(buffer)
        return outcome.kind === 'sessionID' ? outcome.id : undefined
      }
      read += bytesRead
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)])

      let lineStart = 0
      for (;;) {
        const newline = buffer.indexOf(0x0a, lineStart)
        if (newline === -1) break
        const outcome = probeOutcome(buffer.subarray(lineStart, newline))
        if (outcome.kind === 'sessionID') return outcome.id
        if (outcome.kind === 'stop' || outcome.kind === 'invalid') return undefined
        lineStart = newline + 1
      }
      if (lineStart > 0) buffer = buffer.subarray(lineStart)
    }
    // A file ending exactly at byteLimit with no newline still counts if the line is complete.
    const outcome = probeOutcome(buffer)
    return outcome.kind === 'sessionID' ? outcome.id : undefined
  } finally {
    await handle.close()
  }
}

/**
 * Convenience wrapper folding read failures into the same `undefined` as "no metadata".
 * **Callers that persist the result must use `probeCodexRolloutSessionID`** — storing this
 * `undefined` would freeze a transient I/O failure into the cache.
 */
export async function codexRolloutSessionID(
  path: string,
  byteLimit: number = CODEX_PROBE_BYTE_LIMIT,
): Promise<string | undefined> {
  try {
    return await probeCodexRolloutSessionID(path, byteLimit)
  } catch {
    return undefined
  }
}

// MARK: - Entry point

/**
 * Every rollout file under `root`, with mtime and size. Files outside the lookup window are
 * NOT filtered out here — they are parent candidates.
 */
export async function codexRolloutFiles(root: string): Promise<CodexRolloutFile[]> {
  const out: CodexRolloutFile[] = []
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
      if (!entry.isFile() || extname(entry.name) !== '.jsonl') continue
      try {
        const stat = await fs.stat(full)
        out.push({ path: full, mtime: stat.mtimeMs, size: stat.size })
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  await walk(root)
  return out
}

export async function codexEntries(modifiedSince: number, root?: string): Promise<Entry[]> {
  const allFiles = await codexRolloutFiles(root ?? codexSessionsDir())
  // Direct path (no cache): no session ids are known, so parents are found by filename hint
  // and probing only.
  const { rollouts, includedPaths } = await expandCodexParentClosure({
    windowFiles: allFiles.filter((f) => f.mtime >= modifiedSince),
    allFiles,
    load: (f) => parseCodexRollout(f.path),
    sessionIDKnowledge: () => ({ known: false }),
    probeSessionID: (f) => codexRolloutSessionID(f.path),
  })
  return resolveCodexRollouts(rollouts, includedPaths)
}

/** Parses a single Codex file in isolation — used by the per-file cache. */
export async function parseCodexFile(path: string): Promise<Entry[]> {
  const rollout = await parseCodexRollout(path)
  return resolveCodexRollouts([rollout], new Set([rollout.path]))
}
