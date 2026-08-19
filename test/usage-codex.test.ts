import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  codexEntries,
  isUsableFilenameHint,
  parseCodexRollout,
  probeCodexRolloutSessionID,
  resolveCodexRollouts,
} from '../src/core/usage/codex.js'
import { entryTotal } from '../src/core/usage/entry.js'

// Ported from the Codex sections of Tests/PokeTokenBarTests/LocalUsageReaderTests.swift.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ptb-codex-'))
}

function write(lines: string[], dir: string, name = 's.jsonl', sub?: string): string {
  const folder = sub === undefined ? dir : join(dir, sub)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, name)
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

/** A token_count record with only `last_token_usage` — the pre-cumulative CLI shape. */
function codexLine(o: {
  ts: string
  input?: number
  cached?: number
  output?: number
  reasoning?: number
  cacheWrite?: number
}): string {
  const input = o.input ?? 1000
  const output = o.output ?? 50
  return JSON.stringify({
    type: 'event_msg',
    timestamp: o.ts,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: o.cached ?? 200,
          cache_write_input_tokens: o.cacheWrite ?? 0,
          output_tokens: output,
          reasoning_output_tokens: o.reasoning ?? 10,
          total_tokens: input + output,
        },
      },
    },
  })
}

function sessionMeta(id: string, ts: string): string {
  return JSON.stringify({ type: 'session_meta', timestamp: ts, payload: { id, session_id: id } })
}

function forkedMeta(ts: string): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: ts,
    payload: {
      id: 'child',
      forked_from_id: 'parent',
      parent_thread_id: 'parent',
      thread_source: 'user',
    },
  })
}

/** A token_count record carrying both cumulative and per-turn usage. */
function stateLine(o: {
  ts: string
  cumulativeInput: number
  cumulativeCached?: number
  cumulativeOutput: number
  lastInput: number
  lastCached?: number
  lastOutput: number
  lastTotal?: number
  /** Omitted entirely when undefined — older CLIs never wrote this key. */
  cacheWrite?: number
}): string {
  const cw = o.cacheWrite === undefined ? {} : { cache_write_input_tokens: o.cacheWrite }
  return JSON.stringify({
    type: 'event_msg',
    timestamp: o.ts,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: o.cumulativeInput,
          cached_input_tokens: o.cumulativeCached ?? 0,
          ...cw,
          output_tokens: o.cumulativeOutput,
          reasoning_output_tokens: 0,
          total_tokens: o.cumulativeInput + o.cumulativeOutput,
        },
        last_token_usage: {
          input_tokens: o.lastInput,
          cached_input_tokens: o.lastCached ?? 0,
          ...cw,
          output_tokens: o.lastOutput,
          reasoning_output_tokens: 0,
          total_tokens: o.lastTotal ?? o.lastInput + o.lastOutput,
        },
      },
    },
  })
}

describe('codex token mapping', () => {
  it('splits cached input out of the total', async () => {
    const dir = tempDir()
    write([codexLine({ ts: '2026-06-30T11:00:00.000Z' })], dir, 'rollout-x.jsonl', '2026/06/30')
    const entries = await codexEntries(0, dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ input: 800, cacheRead: 200, output: 50, cacheWrite: 0 })
  })
})

describe('canonical ids', () => {
  it('rewrites only the id, preserving every parsed field', async () => {
    const dir = tempDir()
    const path = write(
      [
        sessionMeta('session-a', '2026-07-29T01:00:00.000Z'),
        stateLine({ ts: '2026-07-29T01:00:01.000Z', cumulativeInput: 100, cumulativeCached: 20, cumulativeOutput: 10, lastInput: 100, lastCached: 20, lastOutput: 10 }),
        stateLine({ ts: '2026-07-29T01:00:02.000Z', cumulativeInput: 300, cumulativeCached: 120, cumulativeOutput: 30, lastInput: 200, lastCached: 100, lastOutput: 20 }),
        stateLine({ ts: '2026-07-29T01:00:03.000Z', cumulativeInput: 450, cumulativeCached: 170, cumulativeOutput: 45, lastInput: 150, lastCached: 50, lastOutput: 15 }),
      ],
      dir,
      'rollout.jsonl',
    )
    const rollout = await parseCodexRollout(path)
    const parsed = rollout.events.map((e) => e.entry)
    expect(parsed).toHaveLength(3)

    const resolved = resolveCodexRollouts([rollout], new Set([rollout.path]))
    expect(resolved).toHaveLength(parsed.length)
    resolved.forEach((after, i) => {
      const before = parsed[i]!
      expect(after.id).not.toBe(before.id)
      expect(after.id.startsWith('codex|session-a|0|')).toBe(true)
      expect({ ...after, id: before.id }).toEqual(before)
    })
  })
})

describe('same-state re-records', () => {
  it('drops a consecutive identical snapshot and matches the cumulative total', async () => {
    const dir = tempDir()
    write(
      [
        sessionMeta('session-a', '2026-07-29T01:00:00.000Z'),
        stateLine({ ts: '2026-07-29T01:00:01.000Z', cumulativeInput: 100, cumulativeCached: 20, cumulativeOutput: 10, lastInput: 100, lastCached: 20, lastOutput: 10 }),
        // A plain re-record of the same snapshot.
        stateLine({ ts: '2026-07-29T01:00:02.000Z', cumulativeInput: 100, cumulativeCached: 20, cumulativeOutput: 10, lastInput: 100, lastCached: 20, lastOutput: 10 }),
        stateLine({ ts: '2026-07-29T01:00:03.000Z', cumulativeInput: 300, cumulativeCached: 120, cumulativeOutput: 30, lastInput: 200, lastCached: 100, lastOutput: 20 }),
        // A repeated session_meta must not break token_count state continuity.
        sessionMeta('session-a', '2026-07-29T01:00:04.000Z'),
        stateLine({ ts: '2026-07-29T01:00:05.000Z', cumulativeInput: 300, cumulativeCached: 120, cumulativeOutput: 30, lastInput: 200, lastCached: 100, lastOutput: 20 }),
      ],
      dir,
    )
    const entries = await codexEntries(0, dir)
    expect(entries.map(entryTotal)).toEqual([110, 220])
    expect(entries.reduce((s, e) => s + entryTotal(e), 0)).toBe(330)
  })

  it('preserves records whose scalar totals match but whose full vectors differ', async () => {
    const dir = tempDir()
    write(
      [
        sessionMeta('session-a', '2026-07-29T01:00:00.000Z'),
        stateLine({ ts: '2026-07-29T01:00:01.000Z', cumulativeInput: 100, cumulativeCached: 20, cumulativeOutput: 10, lastInput: 100, lastCached: 20, lastOutput: 10 }),
        // Both cumulative and last total 110, but the input/cache/output split differs.
        stateLine({ ts: '2026-07-29T01:00:02.000Z', cumulativeInput: 90, cumulativeCached: 10, cumulativeOutput: 20, lastInput: 90, lastCached: 10, lastOutput: 20 }),
      ],
      dir,
    )
    const entries = await codexEntries(0, dir)
    expect(entries.map(entryTotal)).toEqual([110, 110])
  })

  it('preserves an unchanged cumulative whose last vector differs', async () => {
    const dir = tempDir()
    write(
      [
        sessionMeta('session-a', '2026-07-29T01:00:00.000Z'),
        stateLine({ ts: '2026-07-29T01:00:01.000Z', cumulativeInput: 100, cumulativeOutput: 10, lastInput: 100, lastOutput: 10 }),
        // The shape real fork fixtures produce post-replay: cumulative unchanged, but
        // last.total_tokens non-zero while the accounted fields are all zero.
        stateLine({ ts: '2026-07-29T01:00:02.000Z', cumulativeInput: 100, cumulativeOutput: 10, lastInput: 0, lastOutput: 0, lastTotal: 6742 }),
      ],
      dir,
    )
    expect((await codexEntries(0, dir)).map(entryTotal)).toEqual([110, 0])
  })

  it('resets the comparison when the session changes', async () => {
    const dir = tempDir()
    write(
      [
        sessionMeta('session-a', '2026-07-29T01:00:00.000Z'),
        stateLine({ ts: '2026-07-29T01:00:01.000Z', cumulativeInput: 100, cumulativeOutput: 10, lastInput: 100, lastOutput: 10 }),
        sessionMeta('session-b', '2026-07-29T01:00:02.000Z'),
        stateLine({ ts: '2026-07-29T01:00:03.000Z', cumulativeInput: 100, cumulativeOutput: 10, lastInput: 100, lastOutput: 10 }),
      ],
      dir,
    )
    expect((await codexEntries(0, dir)).map(entryTotal)).toEqual([110, 110])
  })

  it('keeps repeated records when cumulative usage is missing entirely', async () => {
    const dir = tempDir()
    write(
      [
        sessionMeta('session-a', '2026-07-29T01:00:00.000Z'),
        codexLine({ ts: '2026-07-29T01:00:01.000Z' }),
        codexLine({ ts: '2026-07-29T01:00:02.000Z' }),
      ],
      dir,
    )
    expect(await codexEntries(0, dir)).toHaveLength(2)
  })
})

describe('fork replay trimming', () => {
  it('drops the leading replay burst', async () => {
    const dir = tempDir()
    write(
      [
        forkedMeta('2026-07-29T01:00:00.000Z'),
        codexLine({ ts: '2026-07-29T01:00:00.010Z', output: 50 }),
        codexLine({ ts: '2026-07-29T01:00:00.020Z', output: 51 }),
        codexLine({ ts: '2026-07-29T01:00:03.000Z', output: 52 }),
      ],
      dir,
      'rollout-child.jsonl',
      'child',
    )
    const entries = await codexEntries(0, dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.output).toBe(52)
  })

  it('drops a replay burst that starts after a metadata delay', async () => {
    const dir = tempDir()
    write(
      [
        forkedMeta('2026-07-29T01:00:00.000Z'),
        codexLine({ ts: '2026-07-29T01:00:03.000Z', output: 1 }),
        codexLine({ ts: '2026-07-29T01:00:03.010Z', output: 2 }),
        codexLine({ ts: '2026-07-29T01:00:03.020Z', output: 3 }),
        codexLine({ ts: '2026-07-29T01:00:43.000Z', output: 99 }),
      ],
      dir,
      'rollout-child.jsonl',
      'child',
    )
    expect((await codexEntries(0, dir)).map((e) => e.output)).toEqual([99])
  })

  it('keeps real turns after the burst even when under two seconds apart', async () => {
    const dir = tempDir()
    write(
      [
        forkedMeta('2026-07-29T01:00:00.000Z'),
        codexLine({ ts: '2026-07-29T01:00:00.010Z', output: 1 }),
        codexLine({ ts: '2026-07-29T01:00:00.020Z', output: 2 }),
        codexLine({ ts: '2026-07-29T01:00:00.030Z', output: 3 }),
        codexLine({ ts: '2026-07-29T01:00:01.530Z', output: 11 }),
        codexLine({ ts: '2026-07-29T01:00:03.030Z', output: 22 }),
        codexLine({ ts: '2026-07-29T01:00:04.530Z', output: 33 }),
        codexLine({ ts: '2026-07-29T01:01:00.000Z', output: 44 }),
      ],
      dir,
      'rollout-child.jsonl',
      'child',
    )
    expect((await codexEntries(0, dir)).map((e) => e.output)).toEqual([11, 22, 33, 44])
  })

  it('falls back to timing when the parent has no cumulative state', async () => {
    const dir = tempDir()
    write(
      [
        sessionMeta('parent', '2026-07-29T01:00:00.000Z'),
        codexLine({ ts: '2026-07-29T01:00:00.010Z', output: 50 }),
        codexLine({ ts: '2026-07-29T01:00:00.020Z', output: 51 }),
      ],
      dir,
      'parent.jsonl',
    )
    write(
      [
        forkedMeta('2026-07-30T01:00:00.000Z'),
        sessionMeta('parent', '2026-07-30T01:00:00.001Z'),
        // Old-style replay without total_token_usage cannot be compared structurally.
        codexLine({ ts: '2026-07-30T01:00:03.000Z', output: 50 }),
        codexLine({ ts: '2026-07-30T01:00:03.010Z', output: 51 }),
        codexLine({ ts: '2026-07-30T01:00:06.000Z', output: 99 }),
      ],
      dir,
      'child.jsonl',
    )
    expect((await codexEntries(0, dir)).map((e) => e.output).sort((a, b) => a - b)).toEqual([50, 51, 99])
  })

  // [trigger branch] The parent is found but the very first vector differs (e.g. a newer CLI
  // started filling cache_write_input_tokens), so the overlap is 0. Treating that as "parent
  // found" would trim nothing AND skip the timing fallback — strictly worse than not finding
  // the parent at all.
  it('falls back when the located parent shares no prefix', async () => {
    const dir = tempDir()
    write(
      [
        sessionMeta('parent', '2026-07-29T01:00:00.000Z'),
        stateLine({ ts: '2026-07-29T01:00:01.000Z', cumulativeInput: 100, cumulativeOutput: 10, lastInput: 100, lastOutput: 10 }),
        stateLine({ ts: '2026-07-29T01:00:02.000Z', cumulativeInput: 300, cumulativeOutput: 30, lastInput: 200, lastOutput: 20 }),
      ],
      dir,
      'parent.jsonl',
    )
    write(
      [
        forkedMeta('2026-07-30T01:00:00.000Z'),
        sessionMeta('parent', '2026-07-30T01:00:00.001Z'),
        // Replays the parent's two turns, but the new CLI records cache_write so the
        // vectors differ.
        stateLine({ ts: '2026-07-30T01:00:00.010Z', cumulativeInput: 100, cumulativeOutput: 10, lastInput: 100, lastOutput: 10, cacheWrite: 7 }),
        stateLine({ ts: '2026-07-30T01:00:00.020Z', cumulativeInput: 300, cumulativeOutput: 30, lastInput: 200, lastOutput: 20, cacheWrite: 7 }),
        // The child's own turn, more than a second after the replay burst.
        stateLine({ ts: '2026-07-30T01:00:03.000Z', cumulativeInput: 1300, cumulativeOutput: 128, lastInput: 1000, lastOutput: 98, cacheWrite: 7 }),
      ],
      dir,
      'child.jsonl',
    )
    const totals = (await codexEntries(0, dir)).map(entryTotal).sort((a, b) => a - b)
    expect(totals).toEqual([110, 220, 1098])
  })
})

describe('subagents are exempt from timing fallback', () => {
  const subagentMeta = (ts: string) =>
    JSON.stringify({
      type: 'session_meta',
      timestamp: ts,
      payload: {
        id: 'sub-1',
        session_id: 'parent',
        forked_from_id: 'parent',
        parent_thread_id: 'parent',
        thread_source: 'subagent',
      },
    })

  // Confirmed 0.142.5/0.145.0 subagents insert parent metadata but never replay token_count.
  // Discarding their first real turn just because the parent file is gone loses genuine
  // usage. Same file shape as a manual fork — only `thread_source` differs — so this is the
  // discriminating case.
  it('keeps every turn when the parent is missing', async () => {
    const dir = tempDir()
    write(
      [
        subagentMeta('2026-07-29T01:00:00.000Z'),
        codexLine({ ts: '2026-07-29T01:00:00.010Z', output: 1 }),
        codexLine({ ts: '2026-07-29T01:00:00.020Z', output: 2 }),
        codexLine({ ts: '2026-07-29T01:00:03.000Z', output: 3 }),
      ],
      dir,
      'rollout-sub.jsonl',
    )
    expect((await codexEntries(0, dir)).map((e) => e.output)).toEqual([1, 2, 3])
  })

  it('control: the identical file as a user fork loses the burst', async () => {
    const dir = tempDir()
    write(
      [
        forkedMeta('2026-07-29T01:00:00.000Z'),
        codexLine({ ts: '2026-07-29T01:00:00.010Z', output: 1 }),
        codexLine({ ts: '2026-07-29T01:00:00.020Z', output: 2 }),
        codexLine({ ts: '2026-07-29T01:00:03.000Z', output: 3 }),
      ],
      dir,
      'rollout-fork.jsonl',
    )
    expect((await codexEntries(0, dir)).map((e) => e.output)).toEqual([3])
  })
})

describe('robustness', () => {
  it('clamps an out-of-range cumulative instead of trapping', async () => {
    const dir = tempDir()
    // A trap here would leave the file on disk killing the app on every launch.
    const absurd = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-30T01:00:01.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1e30, cached_input_tokens: 0, output_tokens: 10, total_tokens: 1e30 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 },
        },
      },
    })
    write([sessionMeta('huge', '2026-07-30T01:00:00.000Z'), absurd], dir, 'rollout-huge.jsonl')
    expect((await codexEntries(0, dir)).map(entryTotal)).toEqual([110])
  })
})

describe('isUsableFilenameHint', () => {
  // A degenerate hint matches nearly every rollout filename, so the candidate filter stops
  // filtering and every rollout is fully parsed — measured at 300 files: 0.009s -> 18.2s.
  it.each(['', '-', 'ab', '---'])('rejects the degenerate hint %j', (id) => {
    expect(isUsableFilenameHint(id)).toBe(false)
  })

  it('accepts a real session id', () => {
    expect(isUsableFilenameHint('2eb6d133-a3a2-36da-9f8a-000000000000')).toBe(true)
  })
})

describe('session id probe', () => {
  it('reads the id from the metadata line', async () => {
    const dir = tempDir()
    const path = write([sessionMeta('abc-123', '2026-07-29T01:00:00.000Z'), codexLine({ ts: '2026-07-29T01:00:01.000Z' })], dir)
    expect(await probeCodexRolloutSessionID(path)).toBe('abc-123')
  })

  it('stops at a token_count that precedes any metadata', async () => {
    const dir = tempDir()
    const path = write([codexLine({ ts: '2026-07-29T01:00:01.000Z' }), sessionMeta('late', '2026-07-29T01:00:02.000Z')], dir)
    expect(await probeCodexRolloutSessionID(path)).toBeUndefined()
  })

  it('gives up at the byte limit rather than reading the whole file', async () => {
    const dir = tempDir()
    const padding = JSON.stringify({ type: 'noise', blob: 'x'.repeat(4096) })
    const path = write([...Array.from({ length: 40 }, () => padding), sessionMeta('deep', '2026-07-29T01:00:00.000Z')], dir)
    expect(await probeCodexRolloutSessionID(path, 4096)).toBeUndefined()
    expect(await probeCodexRolloutSessionID(path)).toBe('deep') // found with the real budget
  })

  it('decodes a multibyte character straddling a chunk boundary', async () => {
    const dir = tempDir()
    // Padding sized so the metadata line crosses the 64KB read boundary mid-character.
    const noise = JSON.stringify({ type: 'noise', blob: '가'.repeat(30_000) })
    const path = write([noise, sessionMeta('straddle', '2026-07-29T01:00:00.000Z')], dir)
    expect(await probeCodexRolloutSessionID(path)).toBe('straddle')
  })

  it('throws when the file cannot be opened, so I/O failure is not cached as "no id"', async () => {
    await expect(probeCodexRolloutSessionID(join(tempDir(), 'missing.jsonl'))).rejects.toThrow()
  })
})
