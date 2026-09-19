import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type WatchFactory,
  carriesOtherWindowsProgress,
  watchDataDirectory,
} from '../src/core/coordination/dataWatcher.js'
import { atomicWriteFile } from '../src/core/coordination/atomicWrite.js'
import { sourceRoot } from './repoRoot.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ptb-watch-'))
}

/**
 * A watcher whose events the test fires by hand, and timers it runs by hand.
 *
 * Both injected rather than slept through: a debounce asserted by waiting is a test that
 * passes because twenty event-loop turns happened to be enough, which is the exact failure
 * `CLAUDE.md` names. Here "the window elapsed" is a function call.
 */
function harness(over: { debounceMs?: number } = {}) {
  let emit: ((file: string | undefined) => void) | undefined
  let closed = 0
  const factory: WatchFactory = (_dir, listener) => {
    emit = listener
    return { close: () => (closed += 1) }
  }

  const timers: { fn: () => void; ms: number; id: number; cancelled: boolean }[] = []
  let nextID = 0
  let changes = 0

  const handle = watchDataDirectory({
    directory: '/nowhere',
    onChange: () => (changes += 1),
    debounceMs: over.debounceMs ?? 750,
    watchFactory: factory,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, id: nextID++, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (h) => {
      ;(h as { cancelled: boolean }).cancelled = true
    },
  })

  return {
    handle,
    get changes(): number {
      return changes
    },
    get closes(): number {
      return closed
    },
    /** Every timer that is still armed — there must never be more than one. */
    get armed() {
      return timers.filter((t) => !t.cancelled)
    },
    emit: (file: string | undefined) => emit?.(file),
    /** What the debounce window elapsing looks like, with no clock involved. */
    elapse: () => {
      for (const timer of timers.filter((t) => !t.cancelled)) {
        timer.cancelled = true
        timer.fn()
      }
    },
  }
}

describe('the data watcher debounces', () => {
  /**
   * [trigger branch] One logical write is several events: platforms report `rename` *and*
   * `change`, and `atomicWriteFile`'s temp-then-rename produces its own on the temp name and
   * on the target. Without the debounce, one catch in the other window costs three refreshes.
   */
  it('coalesces a burst into exactly one change', () => {
    const h = harness()
    h.emit('companion-state.json')
    h.emit('companion-state.json')
    h.emit('usage-snapshot.json')
    h.emit('companion-state.json')

    expect(h.changes).toBe(0) // nothing fires inside the window
    expect(h.armed).toHaveLength(1) // and the burst never stacks up timers
    h.elapse()
    expect(h.changes).toBe(1)
  })

  it('reports a later burst as its own change', () => {
    const h = harness()
    h.emit('companion-state.json')
    h.elapse()
    h.emit('companion-state.json')
    h.elapse()
    expect(h.changes).toBe(2)
  })

  it('ignores the files that are not another window progressing', () => {
    const h = harness()
    for (const file of [
      'usage-cache.json.gz',
      'companion-state.json.4321-ab12cd.tmp',
      'companion-state.json.lock',
      'companion-state.json.lock.stale-abc',
      'dev-state.json',
      'base-index.json',
      'companion-state.pre-import-2026-09-19.json',
    ]) {
      expect(carriesOtherWindowsProgress(file)).toBe(false)
      h.emit(file)
    }
    expect(h.armed).toHaveLength(0)
    h.elapse()
    expect(h.changes).toBe(0)
  })

  /**
   * [trigger branch] Most network filesystems, and several platforms, report a change with no
   * file name at all. Refusing those would turn "imprecise here" into "does nothing here" —
   * and the handler is read-only, so an uninteresting event costs one cheap re-read.
   */
  it('accepts an event that carries no file name', () => {
    const h = harness()
    h.emit(undefined)
    h.elapse()
    expect(h.changes).toBe(1)
  })

  it('cancels a pending change when it is closed', () => {
    const h = harness()
    h.emit('companion-state.json')
    h.handle.close()
    h.elapse()
    expect(h.changes).toBe(0)
    expect(h.closes).toBe(1)
    // And events arriving after the close are dropped rather than re-arming the timer.
    h.emit('companion-state.json')
    expect(h.armed).toHaveLength(0)
  })

  // A filesystem with no watch support, or a directory that is not there yet: the refresh
  // timer is the floor, so losing the accelerator must cost nothing but latency.
  it('degrades to no watcher when watching is impossible', () => {
    let changes = 0
    const handle = watchDataDirectory({
      directory: '/nowhere',
      onChange: () => (changes += 1),
      watchFactory: () => {
        throw new Error('ENOSYS')
      },
    })
    expect(() => handle.close()).not.toThrow()
    expect(changes).toBe(0)
  })
})

describe('against the real filesystem', () => {
  /** Waits for a condition on the wall clock. Event-loop turns are not time. */
  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('the watcher never reported the change')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('reports one change for one atomic write of the save', async () => {
    const dir = tempDir()
    let changes = 0
    const handle = watchDataDirectory({
      directory: dir,
      onChange: () => (changes += 1),
      debounceMs: 120,
    })
    try {
      // Through the real helper, so the temp file and the rename are both in the burst.
      await atomicWriteFile(join(dir, 'companion-state.json'), '{"dex":[]}', 'utf8')
      await waitFor(() => changes > 0)
      // A real grace period rather than a few turns of the loop: what is being asserted is
      // that nothing *else* arrives, and that is a claim about elapsed time.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(changes).toBe(1)
      expect(readFileSync(join(dir, 'companion-state.json'), 'utf8')).toBe('{"dex":[]}')
    } finally {
      handle.close()
    }
  })

  it('stays quiet for a file no other window reads back', async () => {
    const dir = tempDir()
    let changes = 0
    const handle = watchDataDirectory({
      directory: dir,
      onChange: () => (changes += 1),
      debounceMs: 60,
    })
    try {
      writeFileSync(join(dir, 'usage-cache.json.gz'), 'x', 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(changes).toBe(0)
    } finally {
      handle.close()
    }
  })
})

/**
 * The watcher is an accelerator, never a replacement.
 *
 * `fs.watch` sees nothing when the home directory lives on NFS or SMB and the write happens
 * on the machine that owns the filesystem, so a design that let the watcher take over the
 * refresh cadence would stop updating entirely there — silently, for the users least able to
 * diagnose it. That property lives in `extension.ts`, which cannot be imported here (it
 * imports `vscode`), so it is guarded by reading the source, the way
 * `test/usage-environment.test.ts` guards its own invariant.
 */
describe('the refresh timer stays the floor', () => {
  const source = readFileSync(join(sourceRoot(), 'extension.ts'), 'utf8')

  /**
   * Comments removed before anything is asserted. A guard that reads prose is a guard that
   * fails when the prose is improved and passes when a comment happens to mention the right
   * word — it has to look at the code.
   */
  const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('schedules the timer unconditionally, beside the watcher and not through it', () => {
    const activate = code(
      source.slice(source.indexOf('export function activate('), source.indexOf('\n}\n')),
    )
    expect(activate).toContain('scheduleTimer()')
    expect(activate).toContain('startDataWatcher()')
    // Nothing about starting a watcher may be a condition on scheduling the timer.
    expect(activate).not.toMatch(/if\s*\([^)]*[Ww]atch[^)]*\)[^\n]*\n?\s*scheduleTimer\(\)/)
  })

  it('never lets a watch event touch the timer', () => {
    // The whole watcher section: the starter, the stopper and the handler a change runs.
    const section = code(
      source.slice(
        source.indexOf('// MARK: - Cross-window watcher'),
        source.indexOf('// MARK: - Development bundle watcher'),
      ),
    )
    expect(section).toContain('function startDataWatcher(')
    expect(section).toContain('async function syncFromDisk(')
    expect(section).not.toContain('scheduleTimer')
    expect(section).not.toContain('stopTimer')
    // Three mentions in the whole file and no more: the declaration, the restart inside
    // `scheduleTimer`, and `deactivate`. A fourth would be something else deciding the
    // cadence, which is the failure this guard exists for.
    expect(code(source).match(/\bstopTimer\(\)/g) ?? []).toHaveLength(3)
  })
})
