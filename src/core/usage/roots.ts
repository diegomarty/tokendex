/**
 * Discovery of every directory that may hold Claude usage logs.
 *
 * New location to support? Add it here only — the scan, the cache and the tests all share
 * this single source.
 */

import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import * as AppPaths from '../appPaths.js'
import { claudeConfigDir, grokHome } from '../usageEnvironment.js'

/**
 * Home-relative default locations. `claudeProjectsDir` and the root list share these
 * strings deliberately: separate literals drift, and a test cannot catch that.
 */
export const DEFAULT_RELATIVE_PROJECTS_PATH = join('.claude', 'projects')
export const CONFIG_RELATIVE_PROJECTS_PATH = join('.config', 'claude', 'projects')

export function claudeProjectsDir(home: string = AppPaths.home()): string {
  return join(home, DEFAULT_RELATIVE_PROJECTS_PATH)
}

/**
 * Directories never descended into during root discovery.
 *
 * Name-based pruning cuts everything under a single *ancestor* name, so listing a legitimate
 * working-directory name reproduces exactly the silent-zero bug this is meant to prevent.
 * Measured: session layouts really do contain `uploads` and `outputs`
 * (`local_<uuid>/uploads`), and Claude sessions run under them are legitimate roots.
 * `build` and `target` are common project names too, so they are out. Depth is the primary
 * width control; this list is secondary.
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'venv', '.venv'])

/**
 * Depth 7 is measured, not guessed: the default session root sits at depth 5
 * (`<uuid>/<uuid>/local_<uuid>/.claude/projects`) and a repository inside a session's working
 * directory (`outputs/myrepo/.claude/projects`) at depth 7. Six misses the latter; 8 and 9
 * visited exactly as many directories (100) because width is bounded by the `node_modules`
 * pruning, not by depth. So 7 is the smallest value that misses nothing at no extra cost.
 */
export const DEFAULT_MAX_ROOT_DEPTH = 7

export interface EmbeddedRootsResult {
  roots: string[]
  /** True when the depth limit stopped the walk — deeper roots may have been missed. */
  prunedByDepth: boolean
}

/**
 * Finds `.claude/projects` directories inside Claude Desktop's embedded session stores.
 * Session paths interleave several UUID levels (`<store>/<uuid>/<uuid>/local_<uuid>/…`), so
 * a fixed path cannot reach them. `.claude` is hidden, so hidden entries must NOT be skipped.
 */
export async function embeddedClaudeProjectRoots(
  base: string,
  maxDepth: number = DEFAULT_MAX_ROOT_DEPTH,
): Promise<EmbeddedRootsResult> {
  const roots: string[] = []
  let prunedByDepth = false

  async function walk(dir: string, level: number): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)

      if (entry.name === 'projects' && basename(dir) === '.claude') {
        roots.push(full)
        continue // below this are project logs, not roots
      }
      // The entry is inspected before pruning. Cutting at `> maxDepth` would descend one
      // level further than intended.
      if (level + 1 >= maxDepth) {
        prunedByDepth = true
        continue
      }
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      await walk(full, level + 1)
    }
  }

  try {
    if (!(await fs.stat(base)).isDirectory()) return { roots, prunedByDepth }
  } catch {
    return { roots, prunedByDepth }
  }
  await walk(base, 0)
  return { roots, prunedByDepth }
}

/**
 * Removes duplicate and nested roots. Pointing `CLAUDE_CONFIG_DIR` at `~/.claude` overlaps
 * the default root, and while the global de-duplication fixes the totals, the scan still
 * costs twice as much.
 */
export async function normalizedRoots(roots: string[]): Promise<string[]> {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const root of roots) {
    // Symlinks are resolved before comparing: `~/.config/claude` -> `~/.claude` is a common
    // XDG setup, and merely normalising `.`/`..` would leave both and walk the tree twice.
    // Comparison is lowercased — macOS APFS and Windows are case-insensitive by default.
    let path: string
    try {
      path = await fs.realpath(root)
    } catch {
      path = resolve(root) // not created yet; keep it, the scan tolerates absence
    }
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(path)
  }

  // Shortest paths win, then anything nested under an already-kept root is dropped. The
  // nesting comparison must be lowercased too: if only one of the two checks ignores case,
  // a spelling like `CLAUDE_CONFIG_DIR=~/.Claude` slips a duplicate root through.
  const kept: string[] = []
  for (const path of [...unique].sort((a, b) => a.length - b.length)) {
    const p = path.toLowerCase()
    const nested = kept.some((k) => {
      const kk = k.toLowerCase()
      return p === kk || p.startsWith(kk + sep)
    })
    if (!nested) kept.push(path)
  }

  // Returned in the original order, which is the priority order.
  return unique.filter((p) => kept.includes(p))
}

export interface ComputeRootsOptions {
  /**
   * The `CLAUDE_CONFIG_DIR` value, or undefined for "not configured".
   *
   * Deliberately NOT a lookup trigger: `undefined` means "no value", never "go and find
   * one". The other reading turns every caller — tests included — into a login-shell spawn.
   * `claudeProjectRoots` does the lookup and passes the result in.
   */
  configDirValue?: string | undefined
  home?: string
  appSupport?: string
}

/**
 * Every projects root, in priority order:
 *  - `CLAUDE_CONFIG_DIR` (comma-separated), each as `<value>/projects`
 *  - `~/.config/claude/projects` and `~/.claude/projects`, the CLI defaults
 *  - Claude Desktop embedded sessions — work done in Desktop lives only there, so omitting
 *    it silently loses that usage.
 */
export async function computeClaudeProjectRoots(options: ComputeRootsOptions = {}): Promise<string[]> {
  const home = options.home ?? AppPaths.home()
  const appSupport = options.appSupport ?? AppPaths.appSupport()
  const configDirValue = options.configDirValue

  const roots: string[] = []
  if (configDirValue) {
    for (const part of configDirValue.split(',')) {
      const path = part.trim()
      if (path === '') continue
      roots.push(join(expandTilde(path, home), 'projects'))
    }
  }
  roots.push(join(home, CONFIG_RELATIVE_PROJECTS_PATH))
  roots.push(join(home, DEFAULT_RELATIVE_PROJECTS_PATH))

  const desktop = join(appSupport, 'Claude')
  for (const store of ['local-agent-mode-sessions', 'claude-code-sessions']) {
    const found = await embeddedClaudeProjectRoots(join(desktop, store))
    roots.push(...found.roots)
  }
  return normalizedRoots(roots)
}

function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

// TTL cache. Computing roots costs a filesystem walk plus, in the worst case, a login-shell
// lookup, while refreshes run every couple of minutes. The set only changes when a new
// Desktop session appears, so 300s folds the recomputation away.
const ROOTS_TTL_MS = 300_000
let cachedRoots: string[] | undefined
let computedAt = 0

export async function claudeProjectRoots(): Promise<string[]> {
  if (cachedRoots !== undefined && Date.now() - computedAt < ROOTS_TTL_MS) return cachedRoots
  const fresh = await computeClaudeProjectRoots({ configDirValue: await claudeConfigDir() })
  cachedRoots = fresh
  computedAt = Date.now()
  return fresh
}

export function resetRootsCache(): void {
  cachedRoots = undefined
  computedAt = 0
}

export function codexSessionsDir(home: string = AppPaths.home()): string {
  return join(home, '.codex', 'sessions')
}

export function geminiTmpDir(home: string = AppPaths.home()): string {
  return join(home, '.gemini', 'tmp')
}

/**
 * Grok CLI session root, honouring `$GROK_HOME` the same way the CLI does.
 *
 * Read through `usageEnvironment` rather than `process.env`: a GUI-launched host does not
 * inherit the login shell, so a user who exported it in `~/.zshrc` would silently see zero.
 */
export async function grokSessionsDir(home: string = AppPaths.home()): Promise<string> {
  const configured = (await grokHome())?.trim()
  if (configured !== undefined && configured !== '') return join(configured, 'sessions')
  return join(home, '.grok', 'sessions')
}

export { dirname }
