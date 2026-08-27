import { describe, expect, it } from 'vitest'
import { type DispatchResponse, createDispatcher } from '../src/worker/dispatcher.js'

type Action = { action: string }
type Snap = { seq: number }
type Panel = { fromSeq: number; devMode: boolean }

/** A hand-rolled deferred, so tests decide exactly when a scan "finishes". */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness(extraFor?: (action: Action) => string | undefined) {
  const posted: DispatchResponse<Snap, Panel, string>[] = []
  const scans: ReturnType<typeof deferred<Snap>>[] = []
  const applied: string[] = []
  const dispatch = createDispatcher<Action, Snap, Panel, string>({
    scan: () => {
      const d = deferred<Snap>()
      scans.push(d)
      return d.promise
    },
    applyAction: async (a) => {
      applied.push(a.action)
      return extraFor?.(a)
    },
    buildPanel: (snapshot, _locale, devMode) => ({ fromSeq: snapshot.seq, devMode }),
    post: (r) => posted.push(r),
  })
  const settle = () => new Promise((r) => setImmediate(r))
  return { posted, scans, applied, dispatch, settle }
}

describe('dispatcher', () => {
  // [trigger branch] Before the queue, a panel request landing mid-scan started a second
  // scan() interleaved with the first over the same cache and save file.
  it('serializes requests: a second scan never starts while the first is running', async () => {
    const h = harness()
    h.dispatch({ id: 1, type: 'scan' })
    h.dispatch({ id: 2, type: 'panel' })
    await h.settle()
    expect(h.scans).toHaveLength(1) // the second request is queued, not interleaved

    h.scans[0]!.resolve({ seq: 1 })
    await h.settle()
    expect(h.scans).toHaveLength(2)
    h.scans[1]!.resolve({ seq: 2 })
    await h.settle()
    expect(h.posted.map((r) => r.id)).toEqual([1, 2]) // replies keep request order
  })

  it('render re-renders the last scan without scanning again', async () => {
    const h = harness()
    h.dispatch({ id: 1, type: 'scan' })
    await h.settle()
    h.scans[0]!.resolve({ seq: 7 })
    await h.settle()

    h.dispatch({ id: 2, type: 'render', devMode: true })
    await h.settle()
    expect(h.scans).toHaveLength(1) // no second scan
    expect(h.posted[1]).toEqual({ id: 2, ok: true, panel: { fromSeq: 7, devMode: true } })
  })

  it('render before any scan falls back to a full scan', async () => {
    const h = harness()
    h.dispatch({ id: 1, type: 'render' })
    await h.settle()
    expect(h.scans).toHaveLength(1)
    h.scans[0]!.resolve({ seq: 3 })
    await h.settle()
    expect(h.posted[0]).toEqual({ id: 1, ok: true, panel: { fromSeq: 3, devMode: false } })
  })

  it('applies an action before the scan that reports its outcome', async () => {
    const h = harness()
    h.dispatch({ id: 1, type: 'action', payload: { action: 'buyEgg' } })
    await h.settle()
    expect(h.applied).toEqual(['buyEgg'])
    expect(h.scans).toHaveLength(1) // the scan started only after the action landed
    h.scans[0]!.resolve({ seq: 1 })
    await h.settle()
    expect(h.posted[0]?.ok).toBe(true)
  })

  // A dropped reply would leave the host's pending map holding a promise that never
  // resolves; a jammed queue would silence every request after the first failure.
  it('answers a failed scan with ok:false and keeps serving the queue', async () => {
    const h = harness()
    h.dispatch({ id: 1, type: 'scan' })
    h.dispatch({ id: 2, type: 'scan' })
    await h.settle()
    h.scans[0]!.reject(new Error('disk on fire'))
    await h.settle()
    h.scans[1]!.resolve({ seq: 2 })
    await h.settle()
    expect(h.posted[0]).toEqual({ id: 1, ok: false, error: 'disk on fire' })
    expect(h.posted[1]).toEqual({ id: 2, ok: true, snapshot: { seq: 2 } })
  })

  it('a failed render fallback still answers', async () => {
    const h = harness()
    h.dispatch({ id: 1, type: 'render' })
    await h.settle()
    h.scans[0]!.reject(new Error('nope'))
    await h.settle()
    expect(h.posted[0]).toEqual({ id: 1, ok: false, error: 'nope' })
  })

  // [trigger branch] The whole point of `fromLastScan` is skipping the disk pass — but reusing
  // the scan *before* applying the action would answer with pre-throw state, and the animation
  // would land on a Pokémon the save no longer holds.
  it('fromLastScan skips the scan but still applies the action first', async () => {
    const h = harness()
    h.dispatch({ id: 1, type: 'scan' })
    await h.settle()
    h.scans[0]!.resolve({ seq: 9 })
    await h.settle()

    h.dispatch({ id: 2, type: 'action', payload: { action: 'throwBall' }, fromLastScan: true })
    await h.settle()
    expect(h.applied).toEqual(['throwBall']) // the action ran…
    expect(h.scans).toHaveLength(1) // …and no second disk pass did
    expect(h.posted[1]).toEqual({ id: 2, ok: true, panel: { fromSeq: 9, devMode: false } })
  })

  it('fromLastScan with nothing to reuse falls back to a full scan', async () => {
    const h = harness()
    h.dispatch({ id: 1, type: 'action', payload: { action: 'throwBall' }, fromLastScan: true })
    await h.settle()
    expect(h.scans).toHaveLength(1)
    h.scans[0]!.resolve({ seq: 4 })
    await h.settle()
    expect(h.posted[0]).toEqual({ id: 1, ok: true, panel: { fromSeq: 4, devMode: false } })
  })

  // The outcome must ride the same reply as the panel: two messages could interleave with a
  // timer scan's push and the webview would pair an outcome with the wrong state.
  it('attaches what applyAction returns to the action reply', async () => {
    const h = harness((a) => (a.action === 'throwBall' ? 'caught' : undefined))
    h.dispatch({ id: 1, type: 'action', payload: { action: 'throwBall' } })
    await h.settle()
    h.scans[0]!.resolve({ seq: 1 })
    await h.settle()
    expect(h.posted[0]).toEqual({
      id: 1,
      ok: true,
      panel: { fromSeq: 1, devMode: false },
      extra: 'caught',
    })

    // …and only to replies whose action produced one.
    h.dispatch({ id: 2, type: 'action', payload: { action: 'buyEgg' } })
    await h.settle()
    h.scans[1]!.resolve({ seq: 2 })
    await h.settle()
    expect(h.posted[1]).toEqual({ id: 2, ok: true, panel: { fromSeq: 2, devMode: false } })
  })
})
