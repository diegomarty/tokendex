/**
 * Ported from `Sources/PokeTokenBar/Core/UsageEnvironment.swift`.
 *
 * The single place that reads the environment variables users export to relocate their
 * usage logs. Providers must go through here rather than reading `process.env` directly —
 * `test/usage-environment.test.ts` enforces that mechanically.
 *
 * Not registered here: values the app itself uses (`SHELL`, `PATH`) and dev/QA-only
 * overrides (`PTB_STATE_DIR`). Those are not cases of a user exporting something the app
 * fails to see.
 */

import { shellEnvironmentValues } from './shellEnvironment.js'

/** The canonical list of provider location overrides. Adding a provider? Add its name here. */
export const USAGE_ENVIRONMENT_NAMES = [
  'CLAUDE_CONFIG_DIR', // Claude CLI config directory (comma-separated for multiple)
  'OPENCODE_DATA_DIR', // OpenCode data directory
  'HERMES_HOME', // Hermes home
  'COPILOT_HOME', // Copilot CLI home
  'GROK_HOME', // Grok CLI home
] as const

export type ShellLookup = (names: string[]) => Promise<Record<string, string>>

function isBlank(value: string): boolean {
  return value.trim() === ''
}

/**
 * The lookup policy, split out so tests can drive both branches:
 * everything present in the process environment means the shell is **not** spawned; if any
 * name is missing, the missing ones are batched into a **single** spawn.
 *
 * Without a test on that split, an implementation that "just always asks the shell" passes,
 * and the majority of users — who set no overrides — pay the spawn cost on every start.
 */
export async function resolve(
  names: readonly string[],
  processEnvironment: Record<string, string | undefined>,
  shellLookup: ShellLookup,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const missing: string[] = []

  for (const name of names) {
    const value = processEnvironment[name]
    // `export FOO=` is not "it is here". Accepting a blank value makes the app scan a
    // non-existent path and silently report zero.
    if (value !== undefined && !isBlank(value)) {
      out[name] = value
    } else {
      missing.push(name)
    }
  }

  // The common case — terminal launch, no overrides — ends here without a spawn.
  if (missing.length === 0) return out

  for (const [name, value] of Object.entries(await shellLookup(missing))) {
    if (!isBlank(value)) out[name] = value
  }
  return out
}

let cached: Promise<Record<string, string>> | undefined

/**
 * Resolved once per process. These variables do not change while the extension runs, so no
 * TTL is needed, and negative results are cached too — retrying would make the majority who
 * set nothing pay a spawn on every refresh.
 */
export function resolvedUsageEnvironment(): Promise<Record<string, string>> {
  cached ??= resolve(USAGE_ENVIRONMENT_NAMES, process.env, shellEnvironmentValues)
  return cached
}

export async function usageEnvironmentValue(name: string): Promise<string | undefined> {
  return (await resolvedUsageEnvironment())[name]
}

/** Test seam — drops the memoised result. */
export function resetUsageEnvironmentCache(): void {
  cached = undefined
}

// Named accessors. Providers call these instead of passing the variable name around, so the
// registered names live in exactly one module — `test/usage-environment.test.ts` enforces it.

/** Claude CLI config directory. May hold several comma-separated paths. */
export const claudeConfigDir = () => usageEnvironmentValue('CLAUDE_CONFIG_DIR')
export const opencodeDataDir = () => usageEnvironmentValue('OPENCODE_DATA_DIR')
export const hermesHome = () => usageEnvironmentValue('HERMES_HOME')
export const copilotHome = () => usageEnvironmentValue('COPILOT_HOME')
export const grokHome = () => usageEnvironmentValue('GROK_HOME')
