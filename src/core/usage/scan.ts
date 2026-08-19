/**
 * Directory scanning with an mtime window, ported from `LocalUsageReader.jsonlFiles`.
 *
 * The window is what keeps refreshes cheap: in an append-only log, a file modified before
 * the range start cannot contain entries inside the range.
 */

import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'

export interface ScannedFile {
  path: string
  /** Epoch milliseconds. */
  mtime: number
  size: number
}

/**
 * Recursively lists `.jsonl` files under `root` modified at or after `modifiedSince`.
 *
 * `allowJSON` is Gemini-only. Enabling it everywhere would drag Claude's `.meta.json`
 * sidecars into the scan.
 */
export async function jsonlFiles(
  root: string,
  modifiedSince: number,
  options: { allowJSON?: boolean; skipHidden?: boolean } = {},
): Promise<ScannedFile[]> {
  const { allowJSON = false, skipHidden = true } = options
  const out: ScannedFile[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip rather than fail the whole scan
    }
    for (const entry of entries) {
      if (skipHidden && entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name)
      if (ext !== '.jsonl' && !(allowJSON && ext === '.json')) continue
      try {
        const stat = await fs.stat(full)
        if (stat.mtimeMs >= modifiedSince) {
          out.push({ path: full, mtime: stat.mtimeMs, size: stat.size })
        }
      } catch {
        // vanished between readdir and stat
      }
    }
  }

  await walk(root)
  return out
}
