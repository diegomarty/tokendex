import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isShellSafeEnvironmentName,
  parseMarkedValue,
  shellEnvironmentValues,
} from '../src/core/shellEnvironment.js'
import { USAGE_ENVIRONMENT_NAMES, resolve } from '../src/core/usageEnvironment.js'

// Ported from Tests/PokeTokenBarTests/UsageEnvironmentTests.swift.
// A GUI-launched app does not inherit the login shell's environment. Reading the override
// variables only from the process environment makes a user who exported them in ~/.zshrc
// silently report zero in the app while the CLI is fine — irreproducible in tests unless
// this exact branch is pinned.

describe('resolve — lookup policy', () => {
  it('skips the shell entirely when every name is in the process environment', async () => {
    const calls: string[][] = []
    const out = await resolve(['A_HOME', 'B_HOME'], { A_HOME: '/a', B_HOME: '/b' }, async (n) => {
      calls.push(n)
      return {}
    })
    expect(out).toEqual({ A_HOME: '/a', B_HOME: '/b' })
    expect(calls).toEqual([]) // spawning here costs every override-free user ~0.44s per start
  })

  it('batches the missing names into a single lookup', async () => {
    const calls: string[][] = []
    const out = await resolve(['A_HOME', 'B_HOME', 'C_HOME'], { B_HOME: '/b' }, async (n) => {
      calls.push(n)
      return { A_HOME: '/shell/a', C_HOME: '/shell/c' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['A_HOME', 'C_HOME']) // only the missing ones
    expect(out).toEqual({ A_HOME: '/shell/a', B_HOME: '/b', C_HOME: '/shell/c' })
  })

  // [trigger branch] the value exists ONLY in the login shell. A regression that reads just
  // the process environment shows up here and nowhere else — a test where the value is in
  // both places passes regardless.
  it('picks up a value visible only to the login shell', async () => {
    const out = await resolve(['COPILOT_HOME'], {}, async () => ({
      COPILOT_HOME: '/Users/someone/relocated',
    }))
    expect(out['COPILOT_HOME']).toBe('/Users/someone/relocated')
  })

  it('treats a blank process value as unset and falls back to the shell', async () => {
    const out = await resolve(['HERMES_HOME'], { HERMES_HOME: '   ' }, async () => ({
      HERMES_HOME: '/real',
    }))
    expect(out['HERMES_HOME']).toBe('/real')
  })

  it('discards a blank shell value too', async () => {
    const out = await resolve(['HERMES_HOME'], {}, async () => ({ HERMES_HOME: '  \n ' }))
    expect(out['HERMES_HOME']).toBeUndefined()
  })
})

describe('parseMarkedValue', () => {
  it('pairs by name across profile noise, not by position', () => {
    const raw = [
      'neofetch banner line',
      '<<<BIN:A_HOME:/first:BIN>>>oh-my-zsh noise<<<BIN:B_HOME:/second:BIN>>>',
      'trailing noise',
    ].join('\n')
    expect(parseMarkedValue(raw, 'A_HOME')).toBe('/first')
    expect(parseMarkedValue(raw, 'B_HOME')).toBe('/second')
    expect(parseMarkedValue(raw, 'C_HOME')).toBeUndefined()
  })

  it('treats an empty pair as absent rather than promoting the empty string', () => {
    expect(parseMarkedValue('<<<BIN:A_HOME::BIN>>>', 'A_HOME')).toBeUndefined()
  })

  it('does not confuse a name that prefixes another', () => {
    const raw = '<<<BIN:A_HOME_EXTRA:/extra:BIN>>><<<BIN:A_HOME:/plain:BIN>>>'
    expect(parseMarkedValue(raw, 'A_HOME_EXTRA')).toBe('/extra')
    expect(parseMarkedValue(raw, 'A_HOME')).toBe('/plain')
  })
})

describe('isShellSafeEnvironmentName', () => {
  it.each(['GROK_HOME', 'A1_B2', 'X'])('accepts %s', (name) => {
    expect(isShellSafeEnvironmentName(name)).toBe(true)
  })

  // Lowercase, Unicode "uppercase", metacharacters and the empty string are all rejected.
  it.each(['', 'grok_home', 'A-B', 'A B', 'A;rm -rf /', 'Σ', 'А', '٣', 'A$B'])(
    'rejects %s',
    (name) => {
      expect(isShellSafeEnvironmentName(name)).toBe(false)
    },
  )
})

describe('shellEnvironmentValues', () => {
  it('returns empty without spawning when every name is rejected', async () => {
    expect(await shellEnvironmentValues([])).toEqual({})
    expect(await shellEnvironmentValues(['bad name', 'x'])).toEqual({})
  })
})

describe('registry integrity', () => {
  it('covers every provider override', () => {
    for (const name of [
      'CLAUDE_CONFIG_DIR',
      'OPENCODE_DATA_DIR',
      'HERMES_HOME',
      'COPILOT_HOME',
      'GROK_HOME',
    ]) {
      expect(USAGE_ENVIRONMENT_NAMES).toContain(name)
    }
  })

  it('has no duplicates and every name survives the shell guard', () => {
    expect(new Set(USAGE_ENVIRONMENT_NAMES).size).toBe(USAGE_ENVIRONMENT_NAMES.length)
    for (const name of USAGE_ENVIRONMENT_NAMES) {
      expect(isShellSafeEnvironmentName(name)).toBe(true)
    }
  })
})

/**
 * Mechanical guard against the whole class of defect, ported from
 * `testNoProviderReadsUsageLocationEnvDirectly`. Reading a usage-location variable straight
 * from `process.env` bypasses the login-shell fallback and reintroduces the silent-zero bug.
 *
 * The allowlist holds only files whose env access is NOT a user-exported override:
 *  - usageEnvironment.ts — the one legitimate reader of the process environment
 *  - shellEnvironment.ts — reads `SHELL` to spawn; an app value, not a user override
 *  - appPaths.ts — reads APPDATA/LOCALAPPDATA/XDG_DATA_HOME, OS-provided locations
 *
 * The allowlist is the weak part of this guard: widening it reflexively is how the whole
 * check rots. The second test below is the sharper one — it needs no allowlist because a
 * registered override *name* has no business appearing anywhere but its own module.
 */
describe('no provider reads the environment directly', () => {
  const ALLOWED = new Set(['usageEnvironment.ts', 'shellEnvironment.ts', 'appPaths.ts'])
  // Resolved by walking up rather than trusting `process.cwd()`: running vitest from the
  // repository root instead of `extension/` silently pointed this at a directory that does
  // not exist, and a guard that quietly inspects nothing is worse than no guard.
  const coreDir = (() => {
    let dir = process.cwd()
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'src', 'core')
      if (existsSync(candidate)) return candidate
      const parent = join(dir, '..')
      const nested = join(dir, 'extension', 'src', 'core')
      if (existsSync(nested)) return nested
      dir = parent
    }
    throw new Error('no se encontró src/core — la guarda no puede verificar nada')
  })()

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return entry.name.endsWith('.ts') ? [full] : []
    })
  }

  it('routes every usage-location variable through usageEnvironment', () => {
    const offenders: string[] = []
    for (const file of walk(coreDir)) {
      const name = file.split('/').pop() ?? ''
      if (ALLOWED.has(name)) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('process.env')) offenders.push(`${name}:${index + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })

  // Comments are stripped first: prose explaining the rule must not trip it.
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('keeps every registered override name inside usageEnvironment', () => {
    const offenders: string[] = []
    for (const file of walk(coreDir)) {
      const name = file.split('/').pop() ?? ''
      if (name === 'usageEnvironment.ts') continue
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const variable of USAGE_ENVIRONMENT_NAMES) {
        if (code.includes(variable)) offenders.push(`${name} mentions ${variable}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
