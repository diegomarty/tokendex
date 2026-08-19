import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseISO8601 } from '../src/core/iso8601.js'
import { claudeEntries, parseClaudeFile } from '../src/core/usage/claude.js'
import {
  DEFAULT_RELATIVE_PROJECTS_PATH,
  claudeProjectsDir,
  computeClaudeProjectRoots,
  embeddedClaudeProjectRoots,
  normalizedRoots,
} from '../src/core/usage/roots.js'
import {
  BLOCK_WINDOW_MS,
  activeBlock,
  daily,
  enrichmentScanStart,
  entryTotal,
  localDayKey,
  period,
  startOfMonth,
  startOfWeek,
} from '../src/core/usage/entry.js'

// Ported from Tests/PokeTokenBarTests/LocalUsageReaderTests.swift.

const roots: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ptb-local-'))
  roots.push(d)
  return d
}
afterAll(() => {
  // Left in place: the OS reaps tmpdir, and keeping them aids post-mortem on a failure.
})

function claudeLine(o: {
  id: string
  req: string
  model: string
  ts: string
  i: number
  o: number
  cw?: number
  cr?: number
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: o.ts,
    requestId: o.req,
    message: {
      id: o.id,
      model: o.model,
      usage: {
        input_tokens: o.i,
        output_tokens: o.o,
        cache_creation_input_tokens: o.cw ?? 0,
        cache_read_input_tokens: o.cr ?? 0,
      },
    },
  })
}

function write(lines: string[], dir: string, sub?: string, name = 's.jsonl'): void {
  const folder = sub === undefined ? dir : join(dir, sub)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, name), lines.join('\n'), 'utf8')
}

const TS = '2026-06-30T10:00:00.000Z'
const DAY = localDayKey(parseISO8601(TS)!)

describe('claude parsing', () => {
  it('de-duplicates the same (id, requestId) keeping the largest output', async () => {
    const dir = tempDir()
    // The same (id, req) is logged twice while streaming: output 5 then 200, cacheRead fixed.
    // Keeping the first occurrence would capture partial output and badly under-report cost.
    write(
      [
        claudeLine({ id: 'A', req: 'R1', model: 'claude-opus-4-8', ts: TS, i: 100, o: 5, cr: 1000 }),
        claudeLine({ id: 'A', req: 'R1', model: 'claude-opus-4-8', ts: TS, i: 100, o: 200, cr: 1000 }),
        claudeLine({ id: 'B', req: 'R2', model: 'claude-sonnet-4-6', ts: TS, i: 50, o: 10 }),
      ],
      dir,
      join('proj', 'sub'),
    )

    const entries = await claudeEntries(0, [dir])
    expect(entries).toHaveLength(2) // A de-duplicated, plus B
    const a = entries.find((e) => e.id.startsWith('A|'))
    expect(a?.output).toBe(200)
    expect(a?.cacheRead).toBe(1000)
  })

  it('aggregates a day and prices it', async () => {
    const dir = tempDir()
    write(
      [claudeLine({ id: 'A', req: 'R1', model: 'claude-opus-4-8', ts: TS, i: 1_000_000, o: 0 })],
      dir,
      'p',
    )
    const entries = await claudeEntries(0, [dir])
    const d = daily(entries, DAY)
    expect(d?.totalTokens).toBe(1_000_000)
    expect(d?.totalCost ?? 0).toBeCloseTo(5.0, 6) // opus input, $5/Mtok
    expect(daily(entries, '2000-01-01')).toBeUndefined()
  })

  it('sums across roots but shares the global de-duplication', async () => {
    const cli = tempDir()
    const desktop = tempDir()
    write([claudeLine({ id: 'A', req: 'R1', model: 'claude-opus-4-8', ts: TS, i: 100, o: 10 })], cli, 'p')
    write(
      [
        claudeLine({ id: 'A', req: 'R1', model: 'claude-opus-4-8', ts: TS, i: 100, o: 10 }),
        claudeLine({ id: 'B', req: 'R2', model: 'claude-opus-4-8', ts: TS, i: 7, o: 3 }),
      ],
      desktop,
      'p',
    )

    const entries = await claudeEntries(0, [cli, desktop])
    expect(entries).toHaveLength(2) // A counted once
    expect(entries.reduce((s, e) => s + entryTotal(e), 0)).toBe(110 + 10)

    // Control: dropping the desktop root loses B, proving this really exercises multi-root.
    expect(await claudeEntries(0, [cli])).toHaveLength(1)
  })

  it('ignores lines that are not assistant turns', async () => {
    const dir = tempDir()
    write(
      [
        JSON.stringify({ type: 'user', timestamp: TS, message: { usage: { input_tokens: 9 } } }),
        '{ not json',
        '',
        claudeLine({ id: 'A', req: 'R1', model: 'claude-opus-4-8', ts: TS, i: 1, o: 1 }),
      ],
      dir,
      'p',
    )
    expect(await claudeEntries(0, [dir])).toHaveLength(1)
  })

  it('clamps absurd token counts instead of trapping', async () => {
    const dir = tempDir()
    // Usage logs come from outside the app and stay on disk: a trap here crashed every
    // refresh and every relaunch until the user deleted the file by hand.
    writeFileSync(
      join(dir, 'huge.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: TS,
        requestId: 'R',
        message: { id: 'A', model: 'm', usage: { input_tokens: 1e30, output_tokens: -5 } },
      }),
      'utf8',
    )
    const entries = await parseClaudeFile(join(dir, 'huge.jsonl'))
    expect(entries[0]?.input).toBe(1_000_000_000_000_000)
    expect(entries[0]?.output).toBe(0) // negatives fold to zero
  })
})

describe('embeddedClaudeProjectRoots', () => {
  // `.claude` is hidden, so a walk that skips hidden entries finds nothing — this is the
  // exact defect branch.
  it('finds hidden .claude/projects directories', async () => {
    const base = tempDir()
    const session = join(base, '2eb6d133', 'a3a236da', 'local_35a9f8a7')
    const projects = join(session, '.claude', 'projects')
    mkdirSync(projects, { recursive: true })
    // Audit logs and uploads from the same session are not usage logs, so not candidates.
    mkdirSync(join(session, 'uploads'), { recursive: true })

    expect((await embeddedClaudeProjectRoots(base)).roots).toEqual([projects])
  })

  it('ignores a missing base', async () => {
    expect((await embeddedClaudeProjectRoots('/nonexistent-ptb-xyz')).roots).toHaveLength(0)
  })

  // The real Desktop layout sits at depth 5. If the default hugged that boundary, one extra
  // nesting level would silently produce zero.
  it('pins the depth boundary and its headroom', async () => {
    const base = tempDir()
    mkdirSync(join(base, '2eb6d133', 'a3a236da', 'local_35a9f8a7', '.claude', 'projects'), {
      recursive: true,
    })

    expect((await embeddedClaudeProjectRoots(base, 4)).roots).toHaveLength(0)
    expect((await embeddedClaudeProjectRoots(base, 5)).roots).toHaveLength(1)
    expect((await embeddedClaudeProjectRoots(base)).roots).toHaveLength(1)

    // A repository cloned inside a session's working directory sits at depth 7 — this is
    // what sets the real lower bound on the default.
    mkdirSync(
      join(base, '2eb6d133', 'a3a236da', 'local_35a9f8a7', 'outputs', 'myrepo', '.claude', 'projects'),
      { recursive: true },
    )
    expect((await embeddedClaudeProjectRoots(base)).roots).toHaveLength(2)
    expect((await embeddedClaudeProjectRoots(base, 6)).roots).toHaveLength(1)
  })

  // Depth alone does not bound width: a workspace inside a session sandbox would drag in
  // tens of thousands of directories.
  it('does not descend into bulk directories', async () => {
    const base = tempDir()
    const session = join(base, 's1', 's2', 'local_x')
    mkdirSync(join(session, '.claude', 'projects'), { recursive: true })
    mkdirSync(join(session, 'node_modules', 'pkg', '.claude', 'projects'), { recursive: true })

    const found = (await embeddedClaudeProjectRoots(base)).roots
    expect(found).toHaveLength(1)
    expect(found[0]).not.toContain('node_modules')
  })

  // Name-based pruning cuts everything under one ancestor name. Listing `uploads`/`outputs`
  // (which really exist in session layouts) or common project names like `build`/`target`
  // would delete legitimate roots — reproducing the very silent-zero bug being prevented.
  // The positive-direction test above passes right through that regression.
  it('finds roots under working-directory names', async () => {
    const base = tempDir()
    const session = join(base, 'u1', 'u2', 'local_x')
    for (const work of [join('outputs', 'myrepo'), join('uploads', 'repo2'), 'build', 'target']) {
      mkdirSync(join(session, work, '.claude', 'projects'), { recursive: true })
    }
    const found = (await embeddedClaudeProjectRoots(base)).roots
    for (const work of ['outputs', 'uploads', 'build', 'target']) {
      expect(found.some((p) => p.includes(sep + work + sep))).toBe(true)
    }
  })
})

describe('computeClaudeProjectRoots', () => {
  it('splits on commas, trims, drops empties and expands ~', async () => {
    const home = '/Users/testhome'
    const paths = await computeClaudeProjectRoots({ configDirValue: ' /a/one , ,~/two ', home })

    expect(paths).toContain('/a/one/projects')
    expect(paths).toContain(join(home, 'two', 'projects'))
    expect(paths).not.toContain('/projects') // an empty fragment must not leak in as a root
    expect(paths).toContain(join(home, '.claude', 'projects'))
    expect(paths).toContain(join(home, '.config', 'claude', 'projects'))
  })

  it('keeps only the CLI defaults when nothing is configured', async () => {
    const paths = await computeClaudeProjectRoots({ configDirValue: undefined, home: '/Users/testhome' })
    expect(paths.some((p) => p.startsWith('/a/one'))).toBe(false)
    expect(paths).toContain(join('/Users/testhome', DEFAULT_RELATIVE_PROJECTS_PATH))
    expect(new Set(paths).size).toBe(paths.length) // no duplicates
  })

  it('shares one constant with claudeProjectsDir', () => {
    expect(claudeProjectsDir('/Users/testhome')).toBe(
      join('/Users/testhome', DEFAULT_RELATIVE_PROJECTS_PATH),
    )
  })
})

describe('normalizedRoots', () => {
  it('folds symlinked duplicates so the tree is scanned once', async () => {
    const base = tempDir()
    const real = join(base, 'real', 'projects')
    mkdirSync(real, { recursive: true })
    symlinkSync(join(base, 'real'), join(base, 'linked'))

    const folded = await normalizedRoots([real, join(base, 'linked', 'projects')])
    expect(folded).toHaveLength(1)
  })

  it('drops exact duplicates and nested roots while keeping order', async () => {
    const folded = await normalizedRoots([
      '/Users/x/.claude/projects',
      '/Users/x/.config/claude/projects',
      '/Users/x/.claude/projects', // exact duplicate
      '/Users/x/.claude/projects/sub', // nested
      '/Users/x/.claude/projects-other', // shares a prefix only — must survive
    ])
    expect(folded).toEqual([
      '/Users/x/.claude/projects',
      '/Users/x/.config/claude/projects',
      '/Users/x/.claude/projects-other',
    ])
  })
})

describe('aggregation windows', () => {
  const entry = (date: number, tokens: number) => ({
    id: `e${date}`,
    date,
    localDay: localDayKey(date),
    model: 'claude-opus-4-8',
    input: tokens,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  })

  it('sums an inclusive local-day range', () => {
    const now = parseISO8601('2026-06-15T12:00:00Z')!
    const entries = [entry(now, 10), entry(now - 40 * 86_400_000, 99)]
    const p = period(entries, '2026-06', localDayKey(now), localDayKey(now))
    expect(p.totalTokens).toBe(10)
  })

  it('builds an active block from the trailing 5h window', () => {
    const now = Date.now()
    const entries = [entry(now - 60 * 60_000, 600), entry(now - BLOCK_WINDOW_MS - 1000, 999)]
    const block = activeBlock(entries, now)
    expect(block?.totalTokens).toBe(600) // the older entry is outside the window
    expect(block?.isActive).toBe(true)
    expect(block?.tokensPerMinute).toBeCloseTo(10, 5) // 600 tokens over 60 minutes
    expect(block?.startTime).not.toContain('.') // no fractional seconds, like Swift
  })

  it('returns no block when nothing is recent', () => {
    expect(activeBlock([], Date.now())).toBeUndefined()
  })

  // Using monthStart alone means that at the start of a month the current week begins in the
  // previous month (11 of 2026's 12 months), and just after midnight the 5h block reaches
  // into yesterday — under-reporting weekly totals and burn rate for days.
  it('covers every display window, not just the month', () => {
    const firstOfMonth = new Date(2026, 6, 1, 0, 30).getTime() // 1 July, 00:30 local
    const start = enrichmentScanStart(firstOfMonth)
    expect(start).toBeLessThanOrEqual(startOfMonth(firstOfMonth))
    expect(start).toBeLessThanOrEqual(startOfWeek(firstOfMonth))
    expect(start).toBeLessThanOrEqual(firstOfMonth - BLOCK_WINDOW_MS)
  })

  it('anchors startOfMonth and startOfWeek to local midnight', () => {
    const d = new Date(2026, 6, 2, 15).getTime()
    const som = new Date(startOfMonth(d))
    expect(som.getDate()).toBe(1)
    expect(som.getMonth()).toBe(6)
    expect(startOfWeek(d)).toBeLessThanOrEqual(d)
    expect(new Date(startOfWeek(d)).getHours()).toBe(0)
  })
})
