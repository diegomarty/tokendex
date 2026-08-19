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
  ({ type: 'scan' } | { type: 'panel' } | { type: 'render' } | { type: 'action'; payload: Action })

export type DispatchResponse<Snapshot, Panel> =
  | { id: number; ok: true; snapshot: Snapshot }
  | { id: number; ok: true; panel: Panel }
  | { id: number; ok: false; error: string }

export interface DispatcherDeps<Action, Snapshot, Panel> {
  scan: (locale: string | undefined) => Promise<Snapshot>
  applyAction: (action: Action) => Promise<void>
  buildPanel: (snapshot: Snapshot, locale: string | undefined, devMode: boolean) => Panel
  post: (response: DispatchResponse<Snapshot, Panel>) => void
}

export function createDispatcher<Action, Snapshot, Panel>(
  deps: DispatcherDeps<Action, Snapshot, Panel>,
): (message: DispatchRequest<Action>) => void {
  let lastScan: Snapshot | undefined
  let queue: Promise<void> = Promise.resolve()

  async function handle(message: DispatchRequest<Action>): Promise<void> {
    try {
      let snapshot: Snapshot
      if (message.type === 'render' && lastScan !== undefined) {
        snapshot = lastScan
      } else {
        if (message.type === 'action') await deps.applyAction(message.payload)
        snapshot = await deps.scan(message.locale)
        lastScan = snapshot
      }
      deps.post(
        message.type === 'scan'
          ? { id: message.id, ok: true, snapshot }
          : {
              id: message.id,
              ok: true,
              panel: deps.buildPanel(snapshot, message.locale, message.devMode ?? false),
            },
      )
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
