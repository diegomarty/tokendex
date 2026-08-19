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

function harness() {
  const posted: DispatchResponse<Snap, Panel>[] = []
  const scans: ReturnType<typeof deferred<Snap>>[] = []
  const applied: string[] = []
  const dispatch = createDispatcher<Action, Snap, Panel>({
    scan: () => {
      const d = deferred<Snap>()
      scans.push(d)
      return d.promise
    },
    applyAction: async (a) => {
      applied.push(a.action)
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
})
