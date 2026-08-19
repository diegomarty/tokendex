/**
 * Per-file incremental cache.
 *
 * This is **not an optimisation, it is required**. If you code daily, virtually every session
 * file counts as "modified this month" (hundreds of megabytes), so an mtime filter alone
 * cannot avoid a full re-parse on every refresh. Measured on this machine's real logs
 * (970 MB Claude + 494 MB Codex): a cold scan takes 21.2s + 7.3s. At a 120-second refresh
 * that is untenable.
 *
 * A file whose `(path, mtime, size)` is unchanged is never re-parsed, and the snapshot is
 * persisted so the cold parse happens **once**, not once per launch.
 *
 * The snapshot tolerates missing per-provider sections, so adding a provider never
 * invalidates an existing cache.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import * as AppPaths from '../appPaths.js'
import {
  type CodexParsedRollout,
  type CodexRolloutFile,
  type SessionIDKnowledge,
  codexRolloutFiles,
  expandCodexParentClosure,
  parseCodexRollout,
  probeCodexRolloutSessionID,
  resolveCodexRollouts,
} from './codex.js'
import { type Entry, dedupKeepMax } from './entry.js'
import { parseClaudeFile } from './claude.js'
import { parseGeminiFile } from './gemini.js'
import { isGrokUsageFile, parseGrokFile } from './grok.js'
import {
  copilotEntries,
  cursorEntries,
  hermesEntries,
  kiroEntries,
  openCodeEntries,
} from './additional.js'
import { type AntigravityScan, antigravityScan } from './antigravity.js'
import { claudeProjectRoots, codexSessionsDir, geminiTmpDir, grokSessionsDir } from './roots.js'
import { jsonlFiles } from './scan.js'

/** Bump to re-parse only Codex blobs when fork replay or same-state handling changes. */
const CODEX_PARSER_VERSION = 4
/**
 * Bump only when the **session-id extraction rule** changes (how `session_meta` id/session_id
 * is read, or when the probe stops). Deliberately separate from `CODEX_PARSER_VERSION`:
 * bundling them would wipe the index every time the resolver is touched, resurrecting a full
 * probe sweep on the next orphan lookup.
 */
const CODEX_SESSION_INDEX_VERSION = 2

const PRUNE_AGE_MS = 40 * 86_400_000
const SAVE_THROTTLE_MS = 60_000

interface Blob {
  mtime: number
  size: number
  entries: Entry[]
}

interface CodexBlob {
  mtime: number
  size: number
  rollout: CodexParsedRollout
}

/**
 * Session id of a rollout, held without its blob so parent candidates can be filtered
 * without reopening the file. A stored `sessionID: null` ("this file has none") is a real
 * result: dropping it would reopen every rollout on every refresh because of one fork whose
 * parent is gone.
 */
interface CodexSessionProbe {
  mtime: number
  size: number
  sessionID: string | null
}

interface Snapshot {
  claude: Record<string, Blob>
  codex: Record<string, CodexBlob>
  codexSessionIDs: Record<string, CodexSessionProbe>
  gemini?: Record<string, Blob>
  grok?: Record<string, Blob>
  /**
   * Append-only stores keep entries plus a per-database high-water mark, rather than a blob
   * per file: their data lives in one database that is appended to, not in files that change.
   */
  incremental?: Record<string, IncrementalCache>
  codexParserVersion: number
  codexSessionIndexVersion: number
}

interface IncrementalCache {
  entries: Entry[]
  highWaterByPath: Record<string, number>
}

export interface CacheOptions {
  claudeRoots?: string[]
  codexRoot?: string
  geminiRoot?: string
  grokRoot?: string
  cursorRoots?: string[]
  copilotRoots?: string[]
  openCodeRoots?: string[]
  hermesRoots?: string[]
  kiroRoots?: string[]
  antigravityRoot?: string
  filePath?: string
  now?: () => number
  /**
   * Throwing probe on purpose: a read failure and "no metadata" differ in whether the result
   * may be indexed. Folding them would freeze a transient I/O error into the cache until the
   * file's mtime or size changes.
   */
  codexProbe?: (file: CodexRolloutFile) => Promise<string | undefined>
}

export class LocalUsageCache {
  private claude: Record<string, Blob> = {}
  private codex: Record<string, CodexBlob> = {}
  private codexSessionIDs: Record<string, CodexSessionProbe> = {}
  private gemini: Record<string, Blob> = {}
  private grok: Record<string, Blob> = {}
  private incremental: Record<string, IncrementalCache> = {}
  private loaded = false
  private dirty = false
  private lastSave: number | undefined

  private readonly options: CacheOptions

  constructor(options: CacheOptions = {}) {
    this.options = options
  }

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  private get filePath(): string {
    // Compressed and suffixed so it is self-describing. The `.gz` also keeps the name from
    // colliding with any plain `usage-cache.json` sitting beside it — nothing else shares
    // this format, and silently reading a foreign one would be worse than a cold start.
    return this.options.filePath ?? join(AppPaths.ourData(), 'usage-cache.json.gz')
  }

  // MARK: - Public API

  async claudeEntries(modifiedSince: number): Promise<Entry[]> {
    await this.ensureLoaded()
    // Several roots exist (CLI default + CLAUDE_CONFIG_DIR + Claude Desktop embedded
    // sessions). Blob keys are absolute paths, so adding a root reuses the existing cache,
    // and the global de-duplication counts a turn once even when copied into several roots.
    const roots = this.options.claudeRoots ?? (await claudeProjectRoots())
    const all: Entry[] = []
    for (const root of roots) {
      all.push(...(await this.collect(root, modifiedSince, this.claude, parseClaudeFile)))
    }
    await this.saveIfNeeded()
    return dedupKeepMax(all)
  }

  async codexEntries(modifiedSince: number): Promise<Entry[]> {
    await this.ensureLoaded()
    const { rollouts, includedPaths } = await this.collectCodexRollouts(
      this.options.codexRoot ?? codexSessionsDir(),
      modifiedSince,
    )
    const entries = resolveCodexRollouts(rollouts, includedPaths)
    await this.saveIfNeeded()
    return entries
  }

  async geminiEntries(modifiedSince: number): Promise<Entry[]> {
    await this.ensureLoaded()
    // `.json` is collected only here: Gemini keeps legacy checkpoints in that extension,
    // while allowing it under the Claude roots would drag in their `.meta.json` sidecars.
    const entries = await this.collect(
      this.options.geminiRoot ?? geminiTmpDir(),
      modifiedSince,
      this.gemini,
      parseGeminiFile,
      { allowJSON: true },
    )
    await this.saveIfNeeded()
    return entries
  }

  async grokEntries(modifiedSince: number): Promise<Entry[]> {
    await this.ensureLoaded()
    const all = await this.collect(
      this.options.grokRoot ?? (await grokSessionsDir()),
      modifiedSince,
      this.grok,
      parseGrokFile,
      // The eligibility test runs **before** the blob lookup. A blob is invalidated by
      // updates.jsonl's own mtime and size, but the evidence here is a sibling summary.json;
      // deciding inside parsing would freeze a subagent session parsed before its summary was
      // written, making the double count permanent because the file never changes again.
      { include: isGrokUsageFile },
    )
    await this.saveIfNeeded()
    // A fork copying its parent's updates keeps the same turn ids, so this counts each once.
    return dedupKeepMax(all)
  }

  /**
   * Cursor and Copilot resume from a per-database watermark rather than re-reading.
   *
   * A reset means the store was rebuilt, so the previously held entries are **discarded**
   * rather than merged: keeping them would double count against the cold rescan that
   * `scanIncrementalStores` has already performed.
   */
  private async incrementalEntries(
    key: 'cursor' | 'copilot',
    scan: (marks: Record<string, number>) => Promise<{
      entries: Entry[]
      highWaterByPath: Record<string, number>
      didReset: boolean
    }>,
  ): Promise<Entry[]> {
    await this.ensureLoaded()
    const held = this.incremental[key] ?? { entries: [], highWaterByPath: {} }
    const result = await scan(held.highWaterByPath)
    const merged = result.didReset ? result.entries : dedupKeepMax([...held.entries, ...result.entries])

    this.incremental[key] = {
      entries: merged,
      highWaterByPath: result.highWaterByPath,
    }
    this.dirty = true
    await this.saveIfNeeded()
    return merged
  }

  async cursorEntries(modifiedSince: number): Promise<Entry[]> {
    return this.incrementalEntries('cursor', (afterRowIDByPath) =>
      cursorEntries(modifiedSince, {
        afterRowIDByPath,
        ...(this.options.cursorRoots !== undefined ? { roots: this.options.cursorRoots } : {}),
      }),
    )
  }

  async copilotEntries(modifiedSince: number): Promise<Entry[]> {
    return this.incrementalEntries('copilot', (afterRowIDByPath) =>
      copilotEntries(modifiedSince, {
        afterRowIDByPath,
        ...(this.options.copilotRoots !== undefined ? { roots: this.options.copilotRoots } : {}),
      }),
    )
  }

  /**
   * OpenCode, Hermes and Kiro rewrite their stores in place and expose no append-only id, so
   * there is nothing to resume from — they are re-read whole on every scan.
   */
  async openCodeEntries(modifiedSince: number): Promise<Entry[]> {
    return openCodeEntries(modifiedSince, this.options.openCodeRoots)
  }

  async hermesEntries(modifiedSince: number): Promise<Entry[]> {
    return hermesEntries(modifiedSince, this.options.hermesRoots)
  }

  async kiroEntries(modifiedSince: number): Promise<Entry[]> {
    return kiroEntries(modifiedSince, this.options.kiroRoots)
  }

  /**
   * Antigravity keeps its token ledger inside a protobuf blob, so the scan window cannot be
   * pushed into SQL and every conversation store is re-read whole.
   *
   * Returns the notes alongside the entries rather than swallowing them: an unreadable store
   * makes the totals silently low, and that is worth saying out loud.
   */
  async antigravityScan(modifiedSince: number): Promise<AntigravityScan> {
    return antigravityScan(modifiedSince, this.options.antigravityRoot)
  }

  /** Test observation point: confirms deleted rollouts do not accumulate in the index. */
  async codexSessionIndexCount(): Promise<number> {
    await this.ensureLoaded()
    return Object.keys(this.codexSessionIDs).length
  }

  // MARK: - Collection

  private async collect(
    root: string,
    since: number,
    cache: Record<string, Blob>,
    parse: (path: string) => Promise<Entry[]>,
    options: {
      allowJSON?: boolean
      include?: (path: string) => Promise<boolean>
    } = {},
  ): Promise<Entry[]> {
    const result: Entry[] = []
    for (const file of await jsonlFiles(root, since, options)) {
      if (options.include !== undefined && !(await options.include(file.path))) continue
      const blob = cache[file.path]
      if (blob !== undefined && blob.mtime === file.mtime && blob.size === file.size) {
        result.push(...blob.entries) // unchanged -> not re-parsed
        continue
      }
      const entries = await parse(file.path)
      cache[file.path] = { mtime: file.mtime, size: file.size, entries }
      this.dirty = true
      result.push(...entries)
    }
    return result
  }

  /**
   * Codex caches *parsed rollouts* rather than final entries, because a fork file cannot be
   * settled on its own. Parents outside the lookup window are still needed for replay
   * comparison, so they are pulled in by session id as dependencies.
   */
  private async collectCodexRollouts(
    root: string,
    since: number,
  ): Promise<{ rollouts: CodexParsedRollout[]; includedPaths: Set<string> }> {
    const files = await codexRolloutFiles(root)

    const rememberSessionID = (id: string | undefined, file: CodexRolloutFile): void => {
      this.codexSessionIDs[file.path] = {
        mtime: file.mtime,
        size: file.size,
        sessionID: id ?? null,
      }
      this.dirty = true
    }

    // Only parsing reuses the blob. The expansion rule itself is shared with the reader.
    const load = async (file: CodexRolloutFile): Promise<CodexParsedRollout> => {
      const blob = this.codex[file.path]
      if (blob !== undefined && blob.mtime === file.mtime && blob.size === file.size) {
        const probe = this.codexSessionIDs[file.path]
        if (probe?.mtime !== file.mtime || probe.size !== file.size) {
          rememberSessionID(blob.rollout.sessionID, file)
        }
        return blob.rollout
      }
      const rollout = await parseCodexRollout(file.path)
      this.codex[file.path] = { mtime: file.mtime, size: file.size, rollout }
      this.dirty = true
      // Blobs are pruned at 40 days, so old parents disappear. Keeping just the session id in
      // the index still lets candidates be filtered later without reopening the file.
      rememberSessionID(rollout.sessionID, file)
      return rollout
    }

    /** Session id known without opening the file — valid blob first, then the index. */
    const sessionIDKnowledge = (file: CodexRolloutFile): SessionIDKnowledge => {
      const blob = this.codex[file.path]
      if (blob !== undefined && blob.mtime === file.mtime && blob.size === file.size) {
        const id = blob.rollout.sessionID
        return id === undefined ? { known: true } : { known: true, id }
      }
      const probe = this.codexSessionIDs[file.path]
      if (probe !== undefined && probe.mtime === file.mtime && probe.size === file.size) {
        return probe.sessionID === null ? { known: true } : { known: true, id: probe.sessionID }
      }
      return { known: false }
    }

    // Files that failed to read in this pass. They are NOT indexed (so the next refresh
    // retries); this set only avoids reopening the same file once per orphaned parent id.
    const temporarilyFailed = new Set<string>()
    const probe = this.options.codexProbe ?? ((f) => probeCodexRolloutSessionID(f.path))

    const result = await expandCodexParentClosure({
      windowFiles: files.filter((f) => f.mtime >= since),
      allFiles: files,
      load,
      sessionIDKnowledge,
      probeSessionID: async (file) => {
        if (temporarilyFailed.has(file.path)) return undefined
        try {
          const id = await probe(file)
          rememberSessionID(id, file) // undefined = "this file has no session id", settled
          return id
        } catch {
          temporarilyFailed.add(file.path)
          return undefined
        }
      },
    })

    // Drop index entries for rollouts that no longer exist. The criterion is **file
    // existence**, not age: the index exists precisely to find parents older than the 40-day
    // prune. A wholly failed enumeration (missing root, transient permission error) is
    // skipped so zero files is never mistaken for "everything was deleted".
    if (files.length > 0) {
      const existing = new Set(files.map((f) => f.path))
      const survivors = Object.fromEntries(
        Object.entries(this.codexSessionIDs).filter(([path]) => existing.has(path)),
      )
      if (Object.keys(survivors).length !== Object.keys(this.codexSessionIDs).length) {
        this.codexSessionIDs = survivors
        this.dirty = true
      }
    }
    return result
  }

  // MARK: - Persistence

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    let raw: Buffer
    try {
      raw = await fs.readFile(this.filePath)
    } catch {
      return // no cache yet: a cold parse follows, which is the point of persisting it
    }

    let snapshot: Partial<Snapshot>
    try {
      // gzip first, falling back to plain JSON so a cache written before compression loads.
      let text: string
      try {
        text = gunzipSync(raw).toString('utf8')
      } catch {
        text = raw.toString('utf8')
      }
      snapshot = JSON.parse(text) as Partial<Snapshot>
    } catch {
      return // corrupt cache degrades to a cold parse rather than an error
    }

    this.claude = snapshot.claude ?? {}
    this.codex = snapshot.codex ?? {}
    this.codexSessionIDs = snapshot.codexSessionIDs ?? {}
    this.gemini = snapshot.gemini ?? {}
    this.grok = snapshot.grok ?? {}
    this.incremental = snapshot.incremental ?? {}

    if (snapshot.codexParserVersion !== CODEX_PARSER_VERSION) {
      this.codex = {}
      this.dirty = true
    }
    if (snapshot.codexSessionIndexVersion !== CODEX_SESSION_INDEX_VERSION) {
      this.codexSessionIDs = {}
      this.dirty = true
    }
  }

  /**
   * Drops blobs for files too old to fall inside any display window (today / week / month),
   * so the cache cannot grow without bound. The widest window starts at the month or week
   * boundary, so 40 days is comfortable headroom; blobs of deleted files go too.
   *
   * `codexSessionIDs` is deliberately untouched — finding parents older than 40 days is
   * exactly what that index is for.
   */
  private prune(): void {
    const cutoff = this.now - PRUNE_AGE_MS
    const keepRecent = <T extends { mtime: number }>(map: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(map).filter(([, v]) => v.mtime >= cutoff))
    this.claude = keepRecent(this.claude)
    this.codex = keepRecent(this.codex)
    this.gemini = keepRecent(this.gemini)
    this.grok = keepRecent(this.grok)
    // Incremental caches hold entries, not file blobs, so they prune by entry date.
    const cutoffDate = this.now - PRUNE_AGE_MS
    for (const [key, held] of Object.entries(this.incremental)) {
      this.incremental[key] = {
        entries: held.entries.filter((e) => e.date >= cutoffDate),
        highWaterByPath: held.highWaterByPath,
      }
    }
  }

  /** Writes when dirty, throttled to at most once a minute. */
  private async saveIfNeeded(): Promise<void> {
    if (!this.dirty) return
    if (this.lastSave !== undefined && this.now - this.lastSave < SAVE_THROTTLE_MS) return
    await this.save()
  }

  /** Unconditional write — call before shutdown so a cold parse is not repeated. */
  async save(): Promise<void> {
    this.prune()
    const snapshot: Snapshot = {
      claude: this.claude,
      codex: this.codex,
      codexSessionIDs: this.codexSessionIDs,
      gemini: this.gemini,
      grok: this.grok,
      incremental: this.incremental,
      codexParserVersion: CODEX_PARSER_VERSION,
      codexSessionIndexVersion: CODEX_SESSION_INDEX_VERSION,
    }
    try {
      const path = this.filePath
      await fs.mkdir(join(path, '..'), { recursive: true })
      // Compresses hard (megabytes of JSON down to hundreds of kilobytes). Written to a
      // temporary file and renamed so an interrupted write cannot leave a torn cache.
      const payload = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'))
      const temp = `${path}.tmp`
      await fs.writeFile(temp, payload)
      await fs.rename(temp, path)
      this.dirty = false
      this.lastSave = this.now
    } catch {
      // A cache write failure must never break a refresh; the next pass retries.
    }
  }
}
