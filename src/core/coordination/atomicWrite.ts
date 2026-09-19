/**
 * Atomic single-file writes, with one temp name per writer.
 *
 * Temp-then-rename makes a write atomic *against interruption*. It does nothing against a
 * second writer using the same temp name, and every open VS Code window runs its own
 * extension host over the same `ourData()` directory — so "two writers" is the steady state
 * here, not an edge case (`docs/multi-window.md` §3.1). Two concrete corruptions follow from
 * a shared temp path:
 *
 * - `writeFile` opens `O_TRUNC`. Window B truncating after window A finished writing but
 *   before A's `rename` publishes a truncated file: A renames B's partial bytes over the
 *   real save.
 * - A's `rename` retargets the inode B still holds an open descriptor on, so B's remaining
 *   writes land **in the live file** rather than in a temp.
 *
 * Giving every write its own `${path}.${pid}-${random}.tmp` removes both mechanisms: nobody
 * truncates anybody else's temp, and nobody renames a descriptor somebody else holds. What
 * survives is last-writer-wins — a write can still be *lost*, and that is the transaction
 * lock's job (`fileLock.ts`), not this one's. This module only guarantees that whatever is
 * at `path` is always one writer's complete payload.
 *
 * Core: no `vscode`, nothing outside `node:`.
 */

import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * The temp path a single write will use. Exported for tests that need to assert two writers
 * never collide; production code should call `atomicWriteFile`.
 *
 * The pid makes the name unique across processes and the random suffix makes it unique
 * within one — a worker gzipping two snapshots back to back is still two writers.
 */
export function tempPathFor(path: string): string {
  return `${path}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`
}

/**
 * Writes `data` to `path` via a private temp file and a `rename`, creating the parent
 * directory first.
 *
 * Throws what the underlying write threw, after removing the temp — a failed write must not
 * leave a stray file behind, because per-writer names mean nothing ever reuses it.
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = tempPathFor(path)
  try {
    await fs.writeFile(temp, data, encoding !== undefined ? { encoding } : undefined)
    await fs.rename(temp, path)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * How old an orphan has to be before it is collected. An hour is far longer than any write
 * here takes and far shorter than a session, so it can never race a live writer.
 */
export const ORPHAN_AGE_MS = 3_600_000

/**
 * Collects the debris a `kill -9` leaves behind in the state directory.
 *
 * Per-writer temp names (above) fixed §3.1 by trading one risk for another: the shared
 * `.tmp` name was reused for ever, so a crash mid-write left one file that the next write
 * overwrote, while a private name leaves **one orphan per crash** and nothing in the product
 * would ever collect them. Same story for `.stale-<token>`: `FileLock.breakStale` renames a
 * dead lock aside and then unlinks it, and a process that dies between those two steps leaves
 * the rename behind.
 *
 * Age, never ownership, is the test. A window cannot tell its own crashed predecessor's temp
 * file from another window's live one — the pid in the name may have been recycled, and on a
 * shared home directory it names a process on a different machine altogether. An hour of
 * quiet is evidence no live writer has; a name is not.
 *
 * Never throws and never reports a failure: this is housekeeping, and a state directory that
 * cannot be listed has already failed louder somewhere else. Returns how many files it
 * removed, which is what a test asserts on.
 */
export async function sweepOrphanTemporaries(
  directory: string,
  options: { olderThanMs?: number; now?: () => number } = {},
): Promise<number> {
  const cutoff = (options.now ?? Date.now)() - (options.olderThanMs ?? ORPHAN_AGE_MS)
  let names: string[]
  try {
    names = await fs.readdir(directory)
  } catch {
    return 0
  }

  let removed = 0
  for (const name of names) {
    if (!isOrphanCandidate(name)) continue
    const path = join(directory, name)
    try {
      const stat = await fs.stat(path)
      // Not a directory, and old enough that no live writer can still be holding it. `mtime`
      // rather than `birthtime`: the latter is unavailable on several filesystems and reads
      // back as the epoch there, which would make every candidate look ancient.
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue
      await fs.rm(path, { force: true })
      removed += 1
    } catch {
      // Vanished, or not ours to delete. Either way the next sweep will find out.
    }
  }
  return removed
}

/**
 * The two names this codebase creates and can leak: `atomicWriteFile`'s temp files and
 * `FileLock`'s renamed-aside stale locks. Deliberately narrow — a sweep that deleted anything
 * merely old would eventually eat a save.
 */
function isOrphanCandidate(name: string): boolean {
  return name.endsWith('.tmp') || name.includes('.stale-')
}
