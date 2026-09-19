/**
 * A debounced watch over `ourData()`, so one window's catch reaches the other in about a
 * second rather than in up to two minutes.
 *
 * ## The timer stays, as the floor
 *
 * This is an accelerator and never a replacement. `fs.watch` is backed by FSEvents, inotify or
 * ReadDirectoryChangesW, and on a network home directory (NFS, SMB — the §7.6 case) none of
 * those see a write made on the machine that owns the filesystem. A design that trusted the
 * watcher would simply stop updating there, silently, for the users least able to diagnose it.
 * So the refresh timer keeps ticking and this only closes the gap between ticks.
 *
 * ## Debouncing is not optional
 *
 * A single logical write produces several events: platforms report `rename` *and* `change`,
 * and `atomicWriteFile`'s temp-then-rename produces its own on the temp name and on the
 * target. Without a debounce one save costs three refreshes. The debounce is trailing —
 * everything that arrives inside the window collapses into one call afterwards — because the
 * interesting state is whatever the burst *ends* at, never what it passed through.
 *
 * ## What a change is allowed to do
 *
 * The handler this drives must not write to the watched directory. Two windows whose watch
 * handlers write would ping-pong for ever at the debounce interval, and the debounce cannot
 * save them: each refresh genuinely is a new event. That is why the host answers a change with
 * a read-only re-read of the save (`sync`) rather than with a scan — a scan ends in
 * `CompanionStore.transact`, which writes on every tick whether anything changed or not.
 *
 * Core: no `vscode`. The timer functions and the watcher factory are injected so the debounce
 * is testable without sleeping — event-loop turns are not time.
 */

import { watch } from 'node:fs'

/** The only thing this module needs back from a watcher. */
export interface WatchHandle {
  close(): void
}

export type WatchFactory = (
  directory: string,
  listener: (file: string | undefined) => void,
) => WatchHandle

export interface DataWatchOptions {
  /** The directory to watch — `ourData()` in production. */
  directory: string
  /** Called once per burst, after `debounceMs` of quiet. Must not write into `directory`. */
  onChange: () => void
  debounceMs?: number
  /** Which file names are worth a refresh. Defaults to `carriesOtherWindowsProgress`. */
  interesting?: (file: string) => boolean
  watchFactory?: WatchFactory
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** About a second: fast enough to feel immediate, slow enough to swallow a rename burst. */
const DEFAULT_DEBOUNCE_MS = 750

/**
 * The files whose change means *another window made progress*, as an allowlist.
 *
 * An allowlist rather than a denylist of temp suffixes: a denylist fails open, so the day a
 * new `.partial` or `.stale-…` name appears it becomes a refresh storm instead of a missed
 * event. Everything else in the directory is either this window's own bookkeeping (the usage
 * cache, the dev state, the sprite index) or a file no window reads back (backups).
 */
export function carriesOtherWindowsProgress(file: string): boolean {
  return file === 'companion-state.json' || file === 'usage-snapshot.json'
}

/**
 * Starts watching, and returns the way to stop.
 *
 * Never throws: a directory that does not exist yet, a filesystem with no watch support and a
 * platform that rejects the call all degrade to "no watcher", which is the timer-only
 * behaviour this exists to improve on rather than to replace.
 */
export function watchDataDirectory(options: DataWatchOptions): WatchHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const interesting = options.interesting ?? carriesOtherWindowsProgress
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  const factory = options.watchFactory ?? defaultWatchFactory

  let pending: unknown
  let closed = false

  const fire = (): void => {
    pending = undefined
    if (closed) return
    options.onChange()
  }

  let watcher: WatchHandle | undefined
  try {
    watcher = factory(options.directory, (file) => {
      if (closed) return
      // Some platforms and most network filesystems report no name at all. Refusing those
      // would turn "the watcher is imprecise here" into "the watcher does nothing here"; the
      // handler is read-only, so the worst an uninteresting event costs is one cheap re-read.
      if (file !== undefined && file !== '' && !interesting(file)) return
      if (pending !== undefined) clearTimer(pending)
      pending = setTimer(fire, debounceMs)
    })
  } catch {
    watcher = undefined
  }

  return {
    close(): void {
      closed = true
      if (pending !== undefined) clearTimer(pending)
      pending = undefined
      watcher?.close()
    },
  }
}

/**
 * The real `fs.watch`, with its error channel handled.
 *
 * An `FSWatcher` is an `EventEmitter`, so an unhandled `error` — a watched directory deleted
 * out from under it, an inotify watch limit — would be thrown at the extension host rather
 * than merely losing us the accelerator. Closing on error leaves the timer as the floor,
 * which is exactly the contract above.
 */
const defaultWatchFactory: WatchFactory = (directory, listener) => {
  const watcher = watch(directory, (_event, file) => {
    listener(typeof file === 'string' ? file : undefined)
  })
  watcher.on('error', () => watcher.close())
  return watcher
}
