/**
 * Binary resolution.
 *
 * Only the Codex limits provider needs this — nothing else here shells out. The
 * ordering matters more than the list: static absolute paths first (no subprocess), then the
 * inherited `PATH`, and only then a login shell, which costs hundreds of milliseconds.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as AppPaths from './appPaths.js'
import { searchPath, shellResolveBinary } from './shellEnvironment.js'

/** A miss is cached too, but only briefly: the tool may be installed while the host runs. */
const NOT_FOUND_TTL_MS = 10 * 60_000

interface Cached {
  path?: string
  at: number
}

const cache = new Map<string, Cached>()

export function resetBinaryCache(): void {
  cache.clear()
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await fs.access(path, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Version-manager and package-manager bin/shim directories.
 *
 * Single source shared by lookup and by the child's augmented `PATH` — adding a version
 * manager here reaches both. Per the extension contract in `CLAUDE.md`, this is one of the
 * three sanctioned edit points; a provider must never grow its own private list.
 */
export function commonToolDirectories(home: string = AppPaths.home()): string[] {
  if (process.platform === 'win32') {
    const local = AppPaths.localAppData()
    return [
      join(AppPaths.appSupport(), 'npm'),
      join(local, 'Programs', 'nodejs'),
      join(local, 'Volta', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.local', 'bin'),
    ]
  }
  return [
    '/opt/homebrew/bin', // Homebrew (Apple Silicon)
    '/usr/local/bin', // Homebrew (Intel) / npm prefix
    join(home, '.local/share/mise/shims'), // mise (shims mode)
    join(home, '.asdf/shims'), // asdf
    join(home, '.volta/bin'), // Volta
    join(home, '.bun/bin'), // Bun
    join(home, '.npm-global/bin'), // npm prefix=~/.npm-global
    join(home, '.local/bin'),
    '/usr/bin',
  ]
}

export function commonToolPaths(binary: string, home?: string): string[] {
  return commonToolDirectories(home).map((directory) => join(directory, binary))
}

/**
 * A child's `PATH`, widened with the version-manager directories.
 *
 * A mise or asdf shim re-executes the version manager itself, and with the host's bare `PATH`
 * it cannot find it and dies with exit 1 — this one came from a real bug report, not from
 * theory.
 */
export function augmentedPath(binaryPath: string, base: string | undefined): string {
  const separator = process.platform === 'win32' ? ';' : ':'
  const directory = binaryPath.slice(
    0,
    Math.max(binaryPath.lastIndexOf('/'), binaryPath.lastIndexOf('\\')),
  )
  const parts = [directory, ...commonToolDirectories(), ...(base ?? '/usr/bin:/bin').split(separator)]
  const seen = new Set<string>()
  return parts.filter((p) => p !== '' && !seen.has(p) && seen.add(p)).join(separator)
}

async function locate(binary: string, staticPaths: string[]): Promise<string | undefined> {
  for (const path of staticPaths) {
    if (await isExecutable(path)) return path
  }
  return (await searchPath(binary)) ?? (await shellResolveBinary(binary))
}

/**
 * A cached hit is re-checked on disk before it is returned: an app update or an uninstall
 * (Codex.app replacing itself) leaves a path that resolves to nothing, and a stale hit would
 * turn into a spawn failure on every refresh from then on.
 */
export async function resolveBinary(
  binary: string,
  staticPaths: string[],
  now: number = Date.now(),
): Promise<string | undefined> {
  const hit = cache.get(binary)
  if (hit !== undefined) {
    if (hit.path !== undefined) {
      if (await isExecutable(hit.path)) return hit.path
    } else if (now - hit.at < NOT_FOUND_TTL_MS) {
      return undefined
    }
  }
  const path = await locate(binary, staticPaths)
  cache.set(binary, { ...(path !== undefined ? { path } : {}), at: now })
  return path
}
