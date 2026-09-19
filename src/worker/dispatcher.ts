/**
 * Serialized request dispatch for the scan worker.
 *
 * Two properties, both load-bearing:
 *
 * - **One request at a time.** Panel requests used to bypass the host's `scanInFlight` guard,
 *   so a tab switch during a timer scan ran a second `scan()` interleaved with the first over
 *   the same usage cache and the same save file. The chain makes the second request simply
 *   see the fresher result. Requests are never dropped: a dropped `action` reply would leave
 *   the host's pending map holding a promise that never resolves.
 *
 * - **`render` re-renders, it does not re-scan.** With the panel open, the host asks for a
 *   panel refresh after every scan; rebuilding it from the scan that just finished costs
 *   string formatting (microseconds), where re-scanning costs the whole disk pass a second
 *   time per tick (~100 ms idle, ~1 s while an active session file keeps changing). The one
 *   exception is the first request of the worker's life, which has nothing to re-render and
 *   falls back to a full scan.
 *
 * Generic and dependency-injected so tests can drive it with stubs — the real worker wires in
 * `scan`, `applyAction`, `buildPanel` and `parentPort.postMessage`.
 */

interface BaseRequest {
  id: number
  locale?: string
  devMode?: boolean
}

export type DispatchRequest<Action> = BaseRequest &
  (
    | { type: 'scan' }
    | { type: 'panel' }
    | { type: 'render' }
    /**
     * Another window changed something on disk. Re-read what it wrote and rebuild the
     * snapshot from the last scan — no disk pass over the logs, and **no write**: this is
     * driven by a filesystem watcher, and a handler that wrote would give the other window an
     * event to answer for ever.
     */
    | { type: 'sync' }
    /**
     * Persist whatever is still held in memory, now, and hand back the scan lease. Queued
     * like everything else, so it lands *after* the scan that may still be filling the cache
     * rather than racing it.
     */
    | { type: 'flush' }
    /**
     * `fromLastScan` re-renders from the last scan after applying the action, instead of
     * re-scanning. It exists for the latency-sensitive actions (a ball throw awaits this reply
     * to land its animation): the usage half genuinely did not change, and `buildPanel` reads
     * the companion store itself, so the game half is fresh anyway. Falls back to a full scan
     * when there is nothing to reuse.
     */
    | { type: 'action'; payload: Action; fromLastScan?: boolean }
  )

export type DispatchResponse<Snapshot, Panel, Extra = never> =
  | { id: number; ok: true; snapshot: Snapshot }
  | { id: number; ok: true; panel: Panel; extra?: Extra }
  | { id: number; ok: true; flushed: true }
  | { id: number; ok: false; error: string }

export interface DispatcherDeps<Action, Snapshot, Panel, Extra = never> {
  scan: (locale: string | undefined) => Promise<Snapshot>
  /** May return a result to ride the reply beside the panel (a throw's outcome). */
  applyAction: (action: Action) => Promise<Extra | undefined>
  buildPanel: (snapshot: Snapshot, locale: string | undefined, devMode: boolean) => Panel
  /**
   * Re-reads what other windows have written and recomposes the snapshot, without scanning
   * and without writing. Answers the `sync` request.
   */
  sync: (locale: string | undefined) => Promise<Snapshot>
  /** Writes through whatever is buffered in memory. Answers the `flush` request. */
  flush: () => Promise<void>
  post: (response: DispatchResponse<Snapshot, Panel, Extra>) => void
}

export function createDispatcher<Action, Snapshot, Panel, Extra = never>(
  deps: DispatcherDeps<Action, Snapshot, Panel, Extra>,
): (message: DispatchRequest<Action>) => void {
  let lastScan: Snapshot | undefined
  let queue: Promise<void> = Promise.resolve()

  async function handle(message: DispatchRequest<Action>): Promise<void> {
    try {
      if (message.type === 'flush') {
        await deps.flush()
        deps.post({ id: message.id, ok: true, flushed: true })
        return
      }

      // Recorded as the last scan, so the panel `render` the host sends straight afterwards
      // rebuilds from the synced numbers rather than from the pre-sync ones.
      if (message.type === 'sync') {
        const synced = await deps.sync(message.locale)
        lastScan = synced
        deps.post({ id: message.id, ok: true, snapshot: synced })
        return
      }

      // The action always applies first — reusing the last scan is about skipping the *disk
      // pass*, never about replying with pre-action state.
      let extra: Extra | undefined
      if (message.type === 'action') extra = await deps.applyAction(message.payload)

      let snapshot: Snapshot
      const reuse =
        (message.type === 'render' || (message.type === 'action' && message.fromLastScan === true)) &&
        lastScan !== undefined
      if (reuse) {
        snapshot = lastScan as Snapshot
      } else {
        snapshot = await deps.scan(message.locale)
        lastScan = snapshot
      }
      if (message.type === 'scan') {
        deps.post({ id: message.id, ok: true, snapshot })
      } else {
        const panel = deps.buildPanel(snapshot, message.locale, message.devMode ?? false)
        deps.post(
          extra === undefined
            ? { id: message.id, ok: true, panel }
            : { id: message.id, ok: true, panel, extra },
        )
      }
    } catch (e) {
      deps.post({ id: message.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (message) => {
    // `handle` never rejects (its body is fully wrapped), so the chain cannot jam: a failed
    // request answers `ok: false` and the next one still runs.
    queue = queue.then(() => handle(message))
  }
}
