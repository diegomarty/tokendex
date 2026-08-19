/**
 * Login-shell environment lookup, ported from the relevant parts of
 * `Sources/PokeTokenBar/Core/BinaryLocator.swift`.
 *
 * A GUI-launched app does not inherit the login shell's environment, so a user who put
 * `export COPILOT_HOME=...` in `~/.zshrc` sees correct numbers in the CLI and silently
 * zero in the app. VS Code usually *does* inherit a terminal environment, which makes this
 * a fallback rather than the primary path — but it still matters when VS Code is launched
 * from the Dock or Start menu.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'

/**
 * Shell-injection guard: ASCII uppercase, digits and underscore only.
 *
 * Swift's `isUppercase`/`isNumber` are Unicode-aware, so `Σ`, Cyrillic `А` and Arabic-Indic
 * `٣` would pass. They are not shell metacharacters so no real injection follows, but the
 * guard's declared range and its actual range should agree — hence the explicit ASCII test.
 */
export function isShellSafeEnvironmentName(name: string): boolean {
  return /^[A-Z0-9_]+$/.test(name)
}

/**
 * Extracts the value for `name` from `<<<BIN:NAME:value:BIN>>>`, ignoring profile noise and
 * pairs belonging to other names.
 *
 * The name travels inside the marker precisely so pairs are matched *by name* rather than by
 * position — an interactive profile printing to stdout between pairs must not shift them.
 */
export function parseMarkedValue(raw: string, name: string): string | undefined {
  const opening = `<<<BIN:${name}:`
  const start = raw.indexOf(opening)
  if (start === -1) return undefined
  const valueStart = start + opening.length
  const end = raw.indexOf(':BIN>>>', valueStart)
  if (end === -1) return undefined
  const value = raw.slice(valueStart, end).trim()
  return value === '' ? undefined : value
}

/** Extracts the path from `<<<BIN:/path/to/tool:BIN>>>`, ignoring profile noise. */
export function parseMarkedPath(raw: string): string | undefined {
  const start = raw.indexOf('<<<BIN:')
  if (start === -1) return undefined
  const valueStart = start + '<<<BIN:'.length
  const end = raw.indexOf(':BIN>>>', valueStart)
  if (end === -1) return undefined
  const path = raw.slice(valueStart, end).trim()
  return path === '' ? undefined : path
}

const BATCH_SCRIPT =
  `for n in "$@"; do printf '<<<BIN:%s:%s:BIN>>>' "$n" "$(eval printf '%s' \\"\\$$n\\" 2>/dev/null)"; done`

const SPAWN_TIMEOUT_MS = 8_000

async function isExecutable(path: string): Promise<boolean> {
  try {
    await fs.access(path, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Reads several environment variables with a *single* shell spawn. Calling once per name
 * would make startup slower with every provider added (the Swift original measured ~0.44s
 * per lookup). Unset and blank values are omitted, so a missing key means "this user does
 * not use that variable".
 *
 * Names are passed as positional arguments and never interpolated into the script, which is
 * what keeps this injection-safe.
 */
export async function shellEnvironmentValues(names: string[]): Promise<Record<string, string>> {
  const safe = names.filter(isShellSafeEnvironmentName)
  if (safe.length === 0) return {}

  const shell = process.env['SHELL'] ?? '/bin/zsh'
  if (!(await isExecutable(shell))) return {}

  const raw = await new Promise<string | undefined>((resolve) => {
    execFile(
      shell,
      ['-ilc', BATCH_SCRIPT, 'sh', ...safe],
      { timeout: SPAWN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        // A non-zero exit still often carries usable stdout (noisy profiles), so only a
        // hard failure with no output is treated as "nothing".
        resolve(error && !stdout ? undefined : stdout)
      },
    )
  })
  if (raw === undefined) return {}

  const out: Record<string, string> = {}
  for (const name of safe) {
    const value = parseMarkedValue(raw, name)
    if (value !== undefined) out[name] = value
  }
  return out
}
