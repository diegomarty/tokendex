/**
 * A cross-process advisory lock built out of `open(…, 'wx')` and `rename`.
 *
 * Every open VS Code window — and every profile, fork and Extension Development Host on the
 * machine — runs its own extension host over the same `ourData()` directory, so the save is
 * read once per worker and written unconditionally by all of them
 * (`docs/multi-window.md` §2). The fix is to make every mutation a read-modify-write under a
 * short exclusive lock; this module is that lock, and nothing more.
 *
 * Constraints it lives inside: `src/core/` never imports `vscode`, and the one-VSIX-per-
 * platform property forbids a native `flock`. So the primitive is `fs.open(path, 'wx')`,
 * which is atomic and fails `EEXIST` when the file exists, plus a record naming the holder.
 *
 * ## Surviving a holder that dies
 *
 * A `kill -9` must not wedge every other window for ever, so a lock can be broken. Two
 * **independent** staleness signals, because either alone is wrong:
 *
 * 1. `process.kill(pid, 0)` throwing `ESRCH` means the holder is definitively gone — break
 *    immediately, without waiting out any timer. Only trusted when the record was written on
 *    this host: a pid from another machine indexes a different process table.
 * 2. Otherwise the heartbeat has to age past a generous ceiling. This is what catches a
 *    holder we cannot probe — another host, a recycled pid, a torn record.
 *
 * Signal 1 alone cannot see a wedged-but-alive holder or a foreign host; signal 2 alone is
 * far too slow for the common case, a window that crashed a second ago.
 *
 * ## Breaking by rename, never by unlink
 *
 * Several waiters can decide "stale" at the same instant. `rename` is atomic, so exactly one
 * of them moves the file aside and earns the right to retry the acquire; the losers get
 * `ENOENT` and simply loop, finding the lock freshly held by the winner. `unlink` gives no
 * such arbitration — every waiter succeeds, and each later unlink deletes the file the
 * *winner* has since created.
 *
 * ## Confirming after acquiring
 *
 * Breaking and re-acquiring are two operations, not one. A waiter that judged the previous
 * holder stale can rename our brand-new lock file aside in the window between our `open` and
 * our first use of it. So every acquire re-reads the file and insists on its own token before
 * returning a handle. For the same reason the handle keeps its descriptor open and writes
 * heartbeats through it: if our file is renamed away, our writes follow the inode we opened
 * and can never land inside somebody else's lock.
 *
 * ## Deadlines
 *
 * Every acquisition takes one, and failure is `undefined` rather than a throw or a hang. The
 * caller decides what that means: an accrual that cannot get the lock is skipped (the delta
 * stays unclaimed in the file's ledger and is folded on the next tick), while a user action
 * must fail visibly — a purchase that could not be committed may never look like it worked.
 */

import { promises as fs, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** What a lock file contains. The on-disk contract, so keep it JSON and keep it small. */
export interface LockRecord {
  /** The holder's process id, meaningful only together with `host`. */
  pid: number
  /** `os.hostname()` of the writer, so a pid is never probed against the wrong machine. */
  host: string
  /** Unique per acquisition — this, not the pid, is what identifies a hold. */
  token: string
  /** When the hold began. Diagnostics only; staleness is judged on `heartbeatAt`. */
  startedAt: number
  /** Last time the holder said it was alive. */
  heartbeatAt: number
}

export interface FileLockOptions {
  /** The lock file itself. Its parent directory is created on demand. */
  path: string
  /** Injected clock; `Date.now` by default. */
  now?: () => number
  /** Injected liveness probe; a real `process.kill(pid, 0)` by default. */
  pidAlive?: (pid: number) => boolean
  /**
   * How long a heartbeat may age before the lock is breakable. Generous on purpose: this is
   * the signal for holders we cannot probe, and breaking a live lock is worse than waiting.
   * A long-lived lease should pass several of its own refresh intervals.
   */
  staleAfterMs?: number
  /** Gap between attempts while waiting for a held lock. */
  retryIntervalMs?: number
  /** Injected sleep, so a test can drive the retry loop without real time. */
  sleep?: (ms: number) => Promise<void>
  /** Injected token factory, for deterministic tests. */
  mintToken?: () => string
  /** Injected hostname, for tests that need a record to look foreign. */
  host?: string
}

/** A held lock. Every method is safe to call after `release()`; they just report `false`. */
export interface LockHandle {
  /** Identifies this hold. Present in the file for as long as the hold is ours. */
  readonly token: string
  /** The record as written at acquisition. */
  readonly record: Readonly<LockRecord>
  /**
   * Touches the heartbeat. Returns `false` when the lock is no longer ours — a lease holder
   * that sees `false` has been broken and must stop acting as the owner.
   */
  heartbeat(): Promise<boolean>
  /** Releases the lock, unless it is no longer ours. Never throws. */
  release(): Promise<void>
}

export type LockResult<T> = { acquired: true; value: T } | { acquired: false }

const DEFAULT_STALE_AFTER_MS = 30_000
const DEFAULT_RETRY_INTERVAL_MS = 25
const DEFAULT_TIMEOUT_MS = 5_000

/**
 * How many stale locks one acquire may break before giving up. Breaking does not consult the
 * deadline (the break earns an immediate extra attempt), so without a budget a directory
 * full of contending crashers could keep an acquire looping past its deadline.
 */
const MAX_BREAKS_PER_ACQUIRE = 5

/** `${target}.lock` — so a caller wiring a lock to a state file has one obvious choice. */
export function lockPathFor(targetPath: string): string {
  return `${targetPath}.lock`
}

export class FileLock {
  private readonly path: string
  private readonly now: () => number
  private readonly pidAlive: (pid: number) => boolean
  private readonly staleAfterMs: number
  private readonly retryIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly mintToken: () => string
  private readonly host: string

  constructor(options: FileLockOptions) {
    this.path = options.path
    this.now = options.now ?? Date.now
    this.pidAlive = options.pidAlive ?? livePID
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
    this.sleep = options.sleep ?? ((ms) => delay(ms))
    this.mintToken = options.mintToken ?? (() => randomBytes(9).toString('hex'))
    this.host = options.host ?? hostname()
  }

  /** Who holds the lock right now, if anyone and if the record is readable. */
  async read(): Promise<LockRecord | undefined> {
    const holder = await this.readHolder()
    return holder?.parsed === true ? holder.record : undefined
  }

  /**
   * Takes the lock, waiting up to `timeoutMs`.
   *
   * Resolves with a handle, or `undefined` when the deadline passed — contention is an
   * expected outcome, not an exception. A genuine I/O failure (an unwritable directory, say)
   * still throws: that is not contention and silently pretending it is would lose data.
   */
  async acquire(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<LockHandle | undefined> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    const deadline = this.now() + Math.max(0, timeoutMs)
    let breaks = 0
    for (;;) {
      const handle = await this.tryAcquire()
      if (handle !== undefined) return handle

      const holder = await this.readHolder()
      if (holder !== undefined && this.isStale(holder) && breaks < MAX_BREAKS_PER_ACQUIRE) {
        // Exactly one of several simultaneous waiters wins this rename. Winning it earns an
        // immediate retry rather than a sleep; losing it means somebody else already has.
        if (await this.breakStale()) {
          breaks += 1
          continue
        }
      }
      if (this.now() >= deadline) return undefined
      await this.sleep(this.retryIntervalMs)
    }
  }

  /**
   * Runs `fn` under the lock and releases it afterwards, including when `fn` throws.
   *
   * The result is tagged rather than `T | undefined` so a caller can tell "the lock was busy"
   * from "the work returned nothing" — the difference between skipping an accrual and
   * telling a user their purchase went through.
   */
  async withLock<T>(
    fn: (handle: LockHandle) => Promise<T>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<LockResult<T>> {
    const handle = await this.acquire(timeoutMs)
    if (handle === undefined) return { acquired: false }
    try {
      return { acquired: true, value: await fn(handle) }
    } finally {
      await handle.release()
    }
  }

  // MARK: - Internals

  /** One attempt: create, stamp, and confirm the file still carries our token. */
  private async tryAcquire(): Promise<LockHandle | undefined> {
    let file: FileHandle
    try {
      file = await fs.open(this.path, 'wx')
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return undefined
      throw error
    }

    const token = this.mintToken()
    const at = this.now()
    const record: LockRecord = {
      pid: process.pid,
      host: this.host,
      token,
      startedAt: at,
      heartbeatAt: at,
    }
    try {
      await writeRecord(file, record)
    } catch (error) {
      await file.close().catch(() => {})
      await fs.rm(this.path, { force: true }).catch(() => {})
      throw error
    }

    // Breaking a stale lock is a rename followed by an acquire, and those are not one
    // operation: a waiter that judged the *previous* holder stale can have renamed this
    // brand-new file aside already. Without this check two windows both believe they hold it.
    const back = await this.readHolder()
    if (back?.parsed !== true || back.record.token !== token) {
      await file.close().catch(() => {})
      return undefined
    }
    return this.makeHandle(file, record)
  }

  private makeHandle(file: FileHandle, record: LockRecord): LockHandle {
    const live = { ...record }
    let closed = false
    const stillOurs = async (): Promise<boolean> => {
      if (closed) return false
      return this.sameFile(file, record.token)
    }
    return {
      token: record.token,
      record: live,
      heartbeat: async (): Promise<boolean> => {
        if (!(await stillOurs())) return false
        live.heartbeatAt = this.now()
        // Through our own descriptor, never by path: if the file was renamed aside between
        // the check and the write, the bytes follow the inode we opened instead of landing
        // inside the next holder's lock.
        try {
          await writeRecord(file, live)
        } catch {
          return false
        }
        return true
      },
      release: async (): Promise<void> => {
        if (closed) return
        closed = true
        const ours = await this.sameFile(file, record.token).catch(() => false)
        await file.close().catch(() => {})
        // Unlinking a lock that is no longer ours would delete the *next* holder's file.
        if (ours) await fs.rm(this.path, { force: true }).catch(() => {})
      },
    }
  }

  /**
   * Is the file at `path` still the one we opened?
   *
   * Inode identity is the real answer and it survives a rename, which the token alone does
   * not distinguish from a fresh acquire by a process that happened to read our bytes.
   * Windows reports `ino: 0`, so fall back to the token there.
   */
  private async sameFile(file: FileHandle, token: string): Promise<boolean> {
    let mine: Stats
    let atPath: Stats
    try {
      ;[mine, atPath] = await Promise.all([file.stat(), fs.stat(this.path)])
    } catch {
      return false
    }
    if (mine.ino !== 0 && atPath.ino !== 0) return mine.ino === atPath.ino && mine.dev === atPath.dev
    const holder = await this.readHolder()
    return holder?.parsed === true && holder.record.token === token
  }

  private async readHolder(): Promise<Holder | undefined> {
    let raw: string
    try {
      raw = await fs.readFile(this.path, 'utf8')
    } catch {
      return undefined // vanished between the EEXIST and here; the caller just retries
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LockRecord>
      if (typeof parsed.token === 'string' && typeof parsed.heartbeatAt === 'number') {
        return { parsed: true, record: { ...emptyRecord(), ...parsed } as LockRecord }
      }
    } catch {
      // fall through to the age-only judgement below
    }
    // Empty or half-written: we cannot ask who owns it, and inventing a pid would be worse
    // than useless. Judge it on the file's own age instead — never on a pid we did not read.
    try {
      const stat = await fs.stat(this.path)
      return { parsed: false, record: { ...emptyRecord(), heartbeatAt: stat.mtimeMs } }
    } catch {
      return undefined
    }
  }

  private isStale(holder: Holder): boolean {
    const record = holder.record
    // Signal 1 — definitive, and immediate. Restricted to records written here: a pid from
    // another host names a process in a table we cannot see.
    if (holder.parsed && record.host === this.host && record.pid > 0 && !this.pidAlive(record.pid)) {
      return true
    }
    // Signal 2 — the ceiling. Covers a foreign host, a recycled pid and a torn record.
    return this.now() - record.heartbeatAt > this.staleAfterMs
  }

  /**
   * Moves a stale lock aside. `true` only for the waiter that actually won the rename; every
   * other waiter loses with `ENOENT` and retries against the winner's fresh lock.
   *
   * Deliberately not `unlink`: unlink succeeds for all of them, and the second one deletes
   * the file the first has already re-created.
   */
  private async breakStale(): Promise<boolean> {
    const aside = `${this.path}.stale-${this.mintToken()}`
    try {
      await fs.rename(this.path, aside)
    } catch {
      return false
    }
    await fs.rm(aside, { force: true }).catch(() => {})
    return true
  }
}

interface Holder {
  /** `false` for a record we could not parse — its pid must not be trusted. */
  parsed: boolean
  record: LockRecord
}

function emptyRecord(): LockRecord {
  return { pid: 0, host: '', token: '', startedAt: 0, heartbeatAt: 0 }
}

/**
 * Overwrites the record in place, from offset zero, then trims.
 *
 * Writing before truncating keeps the window in which a reader sees a short file as small as
 * possible; a reader that lands inside it falls back to the file's age, which is fresh, so it
 * will not break a live lock on the strength of a torn read.
 */
async function writeRecord(file: FileHandle, record: LockRecord): Promise<void> {
  const json = JSON.stringify(record)
  await file.write(json, 0, 'utf8')
  await file.truncate(Buffer.byteLength(json, 'utf8'))
}

/**
 * `process.kill(pid, 0)` sends no signal; it only asks whether the pid could be signalled.
 * `ESRCH` is the definitive "no such process". `EPERM` means it exists and belongs to another
 * user — very much alive — so only `ESRCH` may break a lock.
 */
function livePID(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}
