/**
 * The scan lease: one window per machine pays for the disk pass, the rest read what it publishes.
 *
 * `docs/multi-window.md` §3.6 is the cost this closes. Every open window runs its own worker
 * over the *same* logs, so four windows mean four times the I/O every two minutes, four copies
 * of the blob cache resident, and — on a fresh install or after a cache version bump — four
 * independent ~30 s cold parses of the same 1.4 GB, racing each other to publish a snapshot
 * only one of which survives. The scan is read-only with respect to the user's logs and every
 * window computes the identical answer, so this is pure duplication.
 *
 * ## The two halves
 *
 * **The lease** is a long-lived `FileLock` hold. It is taken *opportunistically* — never
 * waited for, because failing to get it costs nothing but CPU — and the holder publishes the
 * result of each scan beside it.
 *
 * **The publication** is the aggregated `ProviderReport[]`, which is all a follower needs: a
 * few hundred bytes per provider, and the exact argument `buildSnapshot` takes as
 * `options.providers`. Publishing the *entries* instead would be republishing the usage cache,
 * megabytes of it, to save a follower an aggregation it never performs anyway.
 *
 * ## The degraded mode is today's product
 *
 * A follower that cannot read a publication **scans**. Stale lease, unheld lease, a holder
 * that has not finished its first scan yet: every one of those falls back to the full disk
 * pass, which is exactly what every window does today. A window showing nothing because a
 * publication was missing would be a worse product than one that duplicates work.
 *
 * ## Two properties of `FileLock` this leans on
 *
 * - **`heartbeat()` returning `false` means the hold was broken.** Break-by-rename has a
 *   residual window that cannot be closed atomically, so a long-lived lease *must* check the
 *   return value and stop acting as owner. A millisecond-long transaction hold never notices;
 *   a lease that runs for days notices eventually. `touch()` below is that check.
 * - **The heartbeat is not self-driving.** There is no timer inside core — a `setInterval` in
 *   here would be a timer the tests cannot see and the worker cannot stop — so the owner
 *   schedules its own touch. The worker does, on a cadence of its own that is deliberately
 *   independent of the refresh interval: a window backed off while unfocused can go three
 *   refresh intervals without scanning, which at a ten-minute interval is half an hour.
 *
 * Core: no `vscode`, nothing outside `node:` and the sibling modules.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { FileLock, type LockHandle, type LockRecord } from './fileLock.js'
import { atomicWriteFile } from './atomicWrite.js'
import type { ProviderReport } from '../snapshot.js'

/** The lease file, beside the save's own lock in `ourData()`. */
export const SCAN_LEASE_FILE = 'scan-lease.lock'
/** Where the holder publishes the result of each scan. */
export const PUBLISHED_SCAN_FILE = 'usage-snapshot.json'
/** Bumped when the payload below changes shape; a mismatch degrades a follower to scanning. */
export const PUBLISHED_SCAN_SCHEMA = 1

/**
 * How long a lease may go untouched before another window may break it.
 *
 * Judged against the owner's own heartbeat cadence rather than the refresh interval, which is
 * user-configurable between 30 s and 10 minutes and is further stretched by the unfocused
 * backoff. Four missed touches at the worker's 20 s cadence.
 */
export const LEASE_STALE_AFTER_MS = 90_000

/**
 * What the lease holder publishes after each scan: enough for a follower to build the exact
 * snapshot the holder built, and nothing more.
 */
export interface PublishedScan {
  schema: number
  /**
   * When the scan that produced `providers` ran. Followers date their snapshot from this, not
   * from their own clock: the tooltip's "updated" line would otherwise claim a freshness the
   * numbers do not have, and — the part that actually costs progress — the ledger's day
   * rollover would credit a whole day twice if a follower folded yesterday's cumulative
   * totals against today's date across midnight.
   */
  scannedAt: number
  providers: ProviderReport[]
  /** The holder's per-provider failures, so a follower reports the same warnings. */
  errors: string[]
}

export interface ScanLeaseOptions {
  /** `ourData()` in production; a temp directory in tests. */
  directory: string
  now?: () => number
  pidAlive?: (pid: number) => boolean
  staleAfterMs?: number
  host?: string
  mintToken?: () => string
}

/**
 * A lease over the machine's scan, held for as long as the window lives.
 *
 * Every method is safe to call in any order and none of them ever waits on another window:
 * the whole point is that not having the lease is a cheap, ordinary outcome.
 */
export class ScanLease {
  private readonly lock: FileLock
  private handle: LockHandle | undefined

  constructor(options: ScanLeaseOptions) {
    this.lock = new FileLock({
      path: join(options.directory, SCAN_LEASE_FILE),
      staleAfterMs: options.staleAfterMs ?? LEASE_STALE_AFTER_MS,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.pidAlive !== undefined ? { pidAlive: options.pidAlive } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.mintToken !== undefined ? { mintToken: options.mintToken } : {}),
    })
  }

  /** Whether this window currently believes it owns the scan. */
  get owned(): boolean {
    return this.handle !== undefined
  }

  /**
   * "Am I the one who scans?" — asked at the start of every scan.
   *
   * Opportunistic by construction: the acquire deadline is zero, so this never sleeps and
   * never waits on another window. One honest attempt is still made, and a lease whose holder
   * is definitively gone (`ESRCH`) or whose heartbeat has aged past the ceiling is broken and
   * taken over inside that attempt — which is what makes a `kill -9`'d holder cost one refresh
   * interval rather than wedging every other window for ever.
   *
   * Asking on every scan, rather than only at activation, is what makes takeover happen at
   * all: activation is the one moment a window is *least* likely to win the lease, because
   * some other window has usually held it for hours by then.
   */
  async ensure(): Promise<boolean> {
    if (this.handle !== undefined) return true
    this.handle = await this.lock.acquire(0)
    return this.handle !== undefined
  }

  /**
   * Says we are still alive, and reports whether we still own the lease.
   *
   * `false` is not an error, it is a demotion: another window judged us stale and took over
   * while we were busy. The handle is dropped so `owned` tells the truth immediately, and the
   * next `ensure()` will compete for the lease again like any other follower.
   */
  async touch(): Promise<boolean> {
    const handle = this.handle
    if (handle === undefined) return false
    if (await handle.heartbeat()) return true
    this.handle = undefined
    // Releases our descriptor, not the file: `release` verifies ownership first, so it cannot
    // delete the lock the window that broke us is now holding.
    await handle.release()
    return false
  }

  /** Hands the lease back, so the next window takes it immediately rather than at the ceiling. */
  async release(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    await handle?.release()
  }

  /** Who holds the lease right now, if the record is readable. Diagnostics and tests. */
  read(): Promise<LockRecord | undefined> {
    return this.lock.read()
  }
}

/** One refresh's worth of observation, however it was obtained. */
export type ScanObservation = Omit<PublishedScan, 'schema'>

export interface LeaseObservation {
  observation: ScanObservation
  /** Whether this window owns the scan. */
  owned: boolean
  /** Whether the corpus was actually read. `false` is the whole point of the lease. */
  scanned: boolean
}

/**
 * The lease policy, in one place and out of the worker so it can be driven by a test: scan if
 * we own the lease, otherwise read what the owner published, and scan anyway when there is
 * nothing to read.
 *
 * That last clause is the safety of the whole design. A stale lease, an unheld lease, a
 * holder still inside its first ~30 s cold parse — each one lands there, and each one scans,
 * which is exactly what every window does today. A follower showing nothing because a
 * publication was missing would be a worse product than one that duplicates work.
 *
 * `onOwned` fires whenever we hold the lease, before the scan: the caller starts its
 * heartbeat there. It is a callback rather than a timer in here because core owns no timers —
 * one hidden in this module would be invisible to the tests and unstoppable by the worker.
 */
export async function observeThroughLease(deps: {
  directory: string
  lease: ScanLease
  scanCorpus: () => Promise<ScanObservation>
  onOwned?: () => void
}): Promise<LeaseObservation> {
  if (await deps.lease.ensure()) {
    deps.onOwned?.()
    const observation = await deps.scanCorpus()
    await publishScan(deps.directory, observation)
    // After the scan, not only on the caller's timer: a cold parse runs for ~30 s, and a
    // lease touched only between scans could be judged stale while it is being used.
    await deps.lease.touch()
    return { observation, owned: true, scanned: true }
  }

  const published = await readPublishedScan(deps.directory)
  if (published !== undefined) return { observation: published, owned: false, scanned: false }
  return { observation: await deps.scanCorpus(), owned: false, scanned: true }
}

/**
 * Publishes the scan the holder just finished.
 *
 * Best effort on purpose: a publication that fails costs followers one refresh interval of
 * freshness and nothing else, while throwing here would fail the scan that produced it. The
 * write goes through `atomicWriteFile` like every other shared file, so a follower reading
 * concurrently sees one writer's complete payload or the previous one, never a torn mixture.
 */
export async function publishScan(directory: string, scan: Omit<PublishedScan, 'schema'>): Promise<void> {
  const payload: PublishedScan = { schema: PUBLISHED_SCAN_SCHEMA, ...scan }
  try {
    await atomicWriteFile(join(directory, PUBLISHED_SCAN_FILE), JSON.stringify(payload), 'utf8')
  } catch {
    // See above: freshness, not correctness.
  }
}

/**
 * Reads the holder's last publication, or `undefined` when there is nothing usable.
 *
 * Every failure answers `undefined` — missing file, unparseable bytes, a schema from a newer
 * build, a payload whose shape does not match — because the caller's response to all of them
 * is the same and it is the safe one: scan. This is the degraded mode, and the degraded mode
 * is today's product.
 */
export async function readPublishedScan(directory: string): Promise<PublishedScan | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(join(directory, PUBLISHED_SCAN_FILE), 'utf8')
  } catch {
    return undefined
  }
  let parsed: Partial<PublishedScan>
  try {
    parsed = JSON.parse(raw) as Partial<PublishedScan>
  } catch {
    return undefined
  }
  if (parsed.schema !== PUBLISHED_SCAN_SCHEMA) return undefined
  if (!Array.isArray(parsed.providers) || typeof parsed.scannedAt !== 'number') return undefined
  return {
    schema: PUBLISHED_SCAN_SCHEMA,
    scannedAt: parsed.scannedAt,
    providers: parsed.providers,
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
  }
}
