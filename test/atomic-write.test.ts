import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  atomicWriteFile,
  sweepOrphanTemporaries,
  tempPathFor,
} from '../src/core/coordination/atomicWrite.js'
import { LocalUsageCache } from '../src/core/usage/cache.js'
import { sourceRoot } from './repoRoot.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ptb-atomic-'))
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * Holds the **first** `rename` open until the returned gate is released, so a second writer
 * can run start-to-finish in the window between one writer's `writeFile` and its `rename`.
 *
 * That window is the whole bug: `writeFile` opens `O_TRUNC`, so with one shared temp name the
 * second writer truncates the first's finished bytes and then renames the temp away under it.
 * Reproducing it by racing two real writers is a coin toss on a small payload; freezing the
 * interleaving here makes the assertion mean something on every run.
 */
function gateFirstRename(): {
  entered: Promise<void>
  open: () => void
  sources: string[]
  restore: () => void
} {
  const sources: string[] = []
  const entered = deferred()
  const gate = deferred()
  const real = fsp.rename.bind(fsp)
  const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    sources.push(String(from))
    if (sources.length === 1) {
      entered.resolve()
      await gate.promise
    }
    return real(from as string, to as string)
  })
  return {
    entered: entered.promise,
    open: () => gate.resolve(),
    sources,
    restore: () => spy.mockRestore(),
  }
}

describe('atomicWriteFile', () => {
  it('gives every write its own temp name', () => {
    const path = '/somewhere/companion-state.json'
    const first = tempPathFor(path)
    const second = tempPathFor(path)
    expect(first).not.toBe(second) // two writes inside one process are still two writers
    for (const temp of [first, second]) {
      expect(temp.startsWith(`${path}.${process.pid}-`)).toBe(true)
      expect(temp.endsWith('.tmp')).toBe(true)
    }
  })

  // [trigger branch] The second writer starts and finishes entirely inside the first's
  // write-then-rename window. With a shared `${path}.tmp` this publishes the wrong bytes and
  // leaves the first writer's `rename` pointing at a file that no longer exists.
  it('survives a second writer landing between its write and its rename', async () => {
    const dir = tempDir()
    const target = join(dir, 'companion-state.json')
    const slow = JSON.stringify({ who: 'A', dex: 'a'.repeat(8192) })
    const quick = JSON.stringify({ who: 'B' })

    const gate = gateFirstRename()
    try {
      const first = atomicWriteFile(target, slow, 'utf8')
      await gate.entered
      await atomicWriteFile(target, quick, 'utf8') // B writes and publishes, start to end
      gate.open()
      await expect(first).resolves.toBeUndefined() // shared temp: ENOENT, the temp is gone
    } finally {
      gate.restore()
    }

    expect(gate.sources[0]).not.toBe(gate.sources[1]) // no two writers on one temp
    expect(readFileSync(target, 'utf8')).toBe(slow) // A published last, and published whole
    expect(readdirSync(dir)).toEqual(['companion-state.json']) // nothing left behind
  })

  it('removes its temp when the publish fails, and reports the failure', async () => {
    const dir = tempDir()
    const target = join(dir, 'state.json')
    const spy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValue(Object.assign(new Error('rename refused'), { code: 'EXDEV' }))
    try {
      await expect(atomicWriteFile(target, 'payload', 'utf8')).rejects.toThrow('rename refused')
    } finally {
      spy.mockRestore()
    }
    // Per-writer names mean nothing ever reuses this one; an orphan would live for ever.
    expect(readdirSync(dir)).toEqual([])
  })

  it('creates the parent directory', async () => {
    const target = join(tempDir(), 'nested', 'deeper', 'state.json')
    await atomicWriteFile(target, 'hello', 'utf8')
    expect(readFileSync(target, 'utf8')).toBe('hello')
  })
})

describe('the usage cache under two windows', () => {
  // Every VS Code window runs its own worker over the same `usage-cache.json.gz`. The
  // single-flight inside `save()` is explicitly intra-worker, so it does nothing here.
  it('never lets two workers share one temp file', async () => {
    const cacheFile = join(tempDir(), 'usage-cache.json.gz')
    const rootA = tempDir()
    const rootB = tempDir()
    writeFileSync(join(rootA, 'a.jsonl'), claudeLine('A', 10), 'utf8')
    writeFileSync(join(rootB, 'b.jsonl'), claudeLine('B', 20), 'utf8')

    const windowA = new LocalUsageCache({ claudeRoots: [rootA], filePath: cacheFile })
    const windowB = new LocalUsageCache({ claudeRoots: [rootB], filePath: cacheFile })

    const gate = gateFirstRename()
    try {
      const first = windowA.claudeEntries(0)
      await gate.entered
      await windowB.claudeEntries(0)
      gate.open()
      await first
    } finally {
      gate.restore()
    }

    expect(gate.sources[0]).not.toBe(gate.sources[1])
    const snapshot = JSON.parse(gunzipSync(readFileSync(cacheFile)).toString('utf8')) as {
      claude: Record<string, unknown>
    }
    // A renamed last, so A's snapshot is what is published. Under a shared temp name A's
    // rename fails ENOENT, the cache swallows it, and B's snapshot is what the user gets.
    expect(Object.keys(snapshot.claude)).toEqual([join(rootA, 'a.jsonl')])
  })
})

/**
 * The sweep the testing rule asks for: the same class of mistake existed at five sites, so
 * the prevention is a mechanism rather than a memory. A new writer that builds its own temp
 * path fails here, in the suite, rather than on somebody's Pokédex.
 */
/**
 * Per-writer temp names closed §3.1 by trading one risk for another: the shared `.tmp` name
 * was reused for ever, so a crash mid-write left one file the next write overwrote, while a
 * private name leaves **one orphan per crash**. Nothing else in the product would ever collect
 * them, and a state directory quietly accumulating files for years is its own bug.
 */
describe('sweeping the orphans a crash leaves behind', () => {
  const HOUR = 3_600_000

  /** Plants a file and backdates it, so "old" is a fact about the file and not about waiting. */
  function plant(dir: string, name: string, ageMs: number): string {
    const path = join(dir, name)
    writeFileSync(path, 'x', 'utf8')
    const when = new Date(Date.now() - ageMs)
    utimesSync(path, when, when)
    return path
  }

  it('removes only the temp files older than an hour', async () => {
    const dir = tempDir()
    const stale = plant(dir, 'companion-state.json.4321-abcdef.tmp', 2 * HOUR)
    const fresh = plant(dir, 'companion-state.json.4322-abcdef.tmp', 60_000)
    const save = plant(dir, 'companion-state.json', 5 * HOUR)

    expect(await sweepOrphanTemporaries(dir)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    // A live writer's temp is minutes old at most; an hour of quiet is the only evidence
    // there is that nobody is holding one, and a name can never provide it.
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(save)).toBe(true)
  })

  // The other orphan this codebase can leak: `FileLock.breakStale` renames a dead lock aside
  // and then unlinks it, so a process that dies between the two steps leaves the rename.
  it('removes a stale-lock rename left behind by a crash', async () => {
    const dir = tempDir()
    const aside = plant(dir, 'companion-state.json.lock.stale-9f2c', 3 * HOUR)
    const live = plant(dir, 'companion-state.json.lock', 3 * HOUR)

    expect(await sweepOrphanTemporaries(dir)).toBe(1)
    expect(existsSync(aside)).toBe(false)
    // Never the lock itself, however old: staleness there is the lock's own judgement, and it
    // has two signals this sweep cannot see.
    expect(existsSync(live)).toBe(true)
  })

  it('takes the age from an injected clock rather than the wall clock', async () => {
    const dir = tempDir()
    plant(dir, 'a.tmp', 0)
    const now = Date.now()
    expect(await sweepOrphanTemporaries(dir, { now: () => now })).toBe(0)
    expect(await sweepOrphanTemporaries(dir, { now: () => now + 2 * HOUR })).toBe(1)
  })

  it('says nothing and does nothing when the directory is not there', async () => {
    await expect(sweepOrphanTemporaries(join(tempDir(), 'missing'))).resolves.toBe(0)
  })

  // Housekeeping runs once per worker, detached. A throw there would reach nothing that could
  // report it, and an unhandled rejection in the worker takes the scan down with it.
  it('is wired into the worker as a detached, unconditional sweep', () => {
    const worker = readFileSync(join(sourceRoot(), 'worker', 'scanWorker.ts'), 'utf8')
    expect(worker).toMatch(/void sweepOrphanTemporaries\(ourData\(\)\)/)
  })
})

describe('temp files, mechanically', () => {
  const root = sourceRoot()
  const allowed = join(root, 'core', 'coordination', 'atomicWrite.ts')

  function sources(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) sources(path, found)
      else if (entry.name.endsWith('.ts')) found.push(path)
    }
    return found
  }

  it('are only ever named by atomicWrite.ts', () => {
    const offenders = sources(root)
      .filter((path) => path !== allowed && /\$\{[^}]*\}\.tmp/.test(readFileSync(path, 'utf8')))
      .map((p) => p.slice(dirname(root).length + 1))
    expect(offenders).toEqual([])
  })

  it('cover the worker’s dev files too', () => {
    const worker = readFileSync(join(root, 'worker', 'scanWorker.ts'), 'utf8')
    expect(worker).not.toMatch(/devFS\.writeFile\(/) // dev-state.json, dev-snapshot.json
  })
})

function claudeLine(id: string, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-30T10:00:00.000Z',
    requestId: `R-${id}`,
    message: {
      id,
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 100,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
}
