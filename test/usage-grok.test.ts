import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grokEntries, isGrokUsageFile, parseGrokFile } from '../src/core/usage/grok.js'
import { entryTotal } from '../src/core/usage/entry.js'

// The schema follows the grok-build source (`extensions/notification.rs`, the
// SessionUpdate / PromptUsage serde contract).

function sessionsRoot(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'ptb-grok-')), 'sessions')
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * A streaming chunk. Most of a real updates.jsonl looks like this, and `_meta.totalTokens` is
 * the context window size — counting it as usage inflates the totals badly.
 */
const CHUNK_LINE = JSON.stringify({
  timestamp: 1_785_000_000,
  method: '_x.ai/session/update',
  params: {
    sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    _meta: { totalTokens: 100, eventId: 'e0', agentTimestampMs: 1_785_000_000_000, chunkId: 0 },
  },
})

interface TurnOptions {
  promptID: string
  input?: number
  output?: number
  cachedRead?: number
  total?: number
  costTicks?: number | null
  costIsPartial?: boolean
  usageIsIncomplete?: boolean
  model?: string | null
  envelopeSeconds?: number | null
  agentTimestampMs?: number | null
  isReplay?: boolean
  snakeCase?: boolean
  nullTokens?: boolean
}

/** A turn ending on the durable ACP wire: camelCase `inputTokens` INCLUDES cache reads. */
function turnLine(o: TurnOptions): string {
  const input = o.input ?? 41_203
  const output = o.output ?? 812
  const cachedRead = o.cachedRead ?? 38_400
  const total = o.total ?? 42_015
  const model = o.model === undefined ? 'grok-build-1' : o.model

  const usage: Record<string, unknown> = o.snakeCase
    ? {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cached_read_tokens: cachedRead,
      }
    : { inputTokens: input, outputTokens: output, totalTokens: total, cachedReadTokens: cachedRead }
  usage['reasoningTokens'] = 260
  usage['modelCalls'] = 3
  usage['numTurns'] = 1

  if (o.nullTokens) {
    usage['cachedReadTokens'] = null
    usage['outputTokens'] = null
  }
  if (o.costTicks !== null) usage['costUsdTicks'] = o.costTicks ?? 12_000_000_000
  if (o.costIsPartial) usage['costIsPartial'] = true
  if (o.usageIsIncomplete) usage['usageIsIncomplete'] = true
  if (model !== null) {
    usage['modelUsage'] = {
      [model]: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        cachedReadTokens: cachedRead,
      },
    }
  }

  const meta: Record<string, unknown> = {
    totalTokens: total,
    eventId: `ev-${o.promptID}`,
    promptId: o.promptID,
  }
  const agentMs = o.agentTimestampMs === undefined ? 1_785_000_010_000 : o.agentTimestampMs
  if (agentMs !== null) meta['agentTimestampMs'] = agentMs
  if (o.isReplay) meta['isReplay'] = true

  const envelope: Record<string, unknown> = { method: '_x.ai/session/update' }
  const seconds = o.envelopeSeconds === undefined ? 1_785_000_010 : o.envelopeSeconds
  if (seconds !== null) envelope['timestamp'] = seconds
  envelope['params'] = {
    sessionId: 's1',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: o.promptID,
      stop_reason: 'end_turn',
      usage,
    },
    _meta: meta,
  }
  return JSON.stringify(envelope)
}

/**
 * The real layout nests a session under an encoded working directory, so the fixtures use the
 * same depth — that way the scan's recursion is exercised too.
 */
function writeSession(
  root: string,
  id: string,
  lines: string[],
  options: { sessionKind?: string; summary?: boolean } = {},
): string {
  const dir = join(root, 'cwd-group', id)
  mkdirSync(dir, { recursive: true })
  const updates = join(dir, 'updates.jsonl')
  writeFileSync(updates, lines.join('\n'), 'utf8')
  if (options.summary !== false) {
    const summary: Record<string, unknown> = { session_summary: 'x' }
    if (options.sessionKind !== undefined) summary['session_kind'] = options.sessionKind
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary), 'utf8')
  }
  return updates
}

describe('token mapping', () => {
  // camelCase inputTokens includes the cache, so it must be subtracted out, and the entry
  // total has to land exactly on usage.totalTokens.
  it('preserves the total identity', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [CHUNK_LINE, turnLine({ promptID: 'p1' })])
    const entries = await parseGrokFile(path)
    expect(entries).toHaveLength(1)

    const e = entries[0]!
    expect(e.input).toBe(41_203 - 38_400)
    expect(e.cacheRead).toBe(38_400)
    expect(e.output).toBe(812)
    expect(e.cacheWrite).toBe(0) // Grok folds cache writes into the prompt tokens
    expect(entryTotal(e)).toBe(42_015)
  })

  // [trigger branch] snake_case input_tokens ALREADY excludes the cache. Treating both
  // spellings alike subtracts the cache twice.
  it('does not cache-adjust the snake_case input a second time', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [
      turnLine({
        promptID: 'p1',
        snakeCase: true,
        input: 2_803,
        cachedRead: 38_400,
        total: 42_015,
      }),
    ])
    const e = (await parseGrokFile(path))[0]!
    expect(e.input).toBe(2_803)
    expect(e.cacheRead).toBe(38_400)
  })

  // Folding with max(0, ...) instead let input + cacheRead exceed inputTokens, silently
  // inflating the total.
  it('clamps the cache read to the prompt total', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [
      turnLine({ promptID: 'p1', input: 1_000, cachedRead: 5_000, output: 10, total: 1_010 }),
    ])
    const e = (await parseGrokFile(path))[0]!
    expect(e.cacheRead).toBe(1_000)
    expect(e.input).toBe(0)
    expect(entryTotal(e)).toBe(1_010)
  })

  it('attributes a residual against the reported total to output', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [
      turnLine({ promptID: 'p1', input: 100, cachedRead: 0, output: 10, total: 200 }),
    ])
    const e = (await parseGrokFile(path))[0]!
    expect(e.output).toBe(10 + 90)
    expect(entryTotal(e)).toBe(200)
  })

  // An explicit null read as "present" would subtract the wrong cache figure or zero tokens.
  it('does not let null token fields zero the turn', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [turnLine({ promptID: 'p1', nullTokens: true })])
    const e = (await parseGrokFile(path))[0]!
    expect(entryTotal(e)).toBe(42_015)
  })

  it('records no entry for a zero-usage turn', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [
      turnLine({ promptID: 'p1', input: 0, output: 0, cachedRead: 0, total: 0 }),
    ])
    expect(await parseGrokFile(path)).toEqual([])
  })
})

describe('turn identity', () => {
  it('aggregates several turns', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [
      turnLine({ promptID: 'p1' }),
      CHUNK_LINE,
      turnLine({ promptID: 'p2', input: 100, cachedRead: 0, output: 5, total: 105 }),
    ])
    expect(await parseGrokFile(path)).toHaveLength(2)
  })

  it('does not count a replay-marked line', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [turnLine({ promptID: 'p1', isReplay: true })])
    expect(await parseGrokFile(path)).toEqual([])
  })

  // A fork copies the parent's updates verbatim, so the prompt ids match and the global pass
  // folds them into one.
  it('does not double count a forked session copy', async () => {
    const root = sessionsRoot()
    writeSession(root, 'parent', [turnLine({ promptID: 'p1' })])
    writeSession(root, 'child', [
      turnLine({ promptID: 'p1' }),
      turnLine({ promptID: 'p2', total: 500, input: 400, cachedRead: 0, output: 100 }),
    ])
    const entries = await grokEntries(0, root)
    expect(entries).toHaveLength(2)
  })

  it('ignores a file with no turn endings at all', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [CHUNK_LINE, CHUNK_LINE])
    expect(await parseGrokFile(path)).toEqual([])
  })
})

describe('session selection', () => {
  // Subagent tokens are already folded into the parent turn, so counting them again is
  // double counting.
  it('skips subagent sessions and keeps user ones', async () => {
    const root = sessionsRoot()
    writeSession(root, 'user', [turnLine({ promptID: 'p1' })])
    writeSession(root, 'sub', [turnLine({ promptID: 'p2' })], { sessionKind: 'subagent' })
    const entries = await grokEntries(0, root)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('grok|p1')
  })

  it.each(['subagent', 'subagent_fork', 'subagent_resume'])('skips %s', async (kind) => {
    const root = sessionsRoot()
    writeSession(root, 'sub', [turnLine({ promptID: 'p1' })], { sessionKind: kind })
    expect(await grokEntries(0, root)).toEqual([])
  })

  // The CLI writes the summary when it creates a session, so absence means a new session with
  // no turns yet — not a subagent.
  it('treats a missing summary as a user session', async () => {
    const root = sessionsRoot()
    writeSession(root, 's1', [turnLine({ promptID: 'p1' })], { summary: false })
    expect(await grokEntries(0, root)).toHaveLength(1)
  })

  // Only updates.jsonl carries usage. chat_history.jsonl has no usage fields and events.jsonl
  // only records turn outcomes, so scanning them would just pad the cache with empty blobs.
  it('reads only updates.jsonl', async () => {
    const root = sessionsRoot()
    const dir = join(root, 'cwd-group', 's1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'updates.jsonl'), turnLine({ promptID: 'p1' }), 'utf8')
    writeFileSync(join(dir, 'events.jsonl'), turnLine({ promptID: 'p9' }), 'utf8')
    writeFileSync(join(dir, 'summary.json'), '{}', 'utf8')

    expect(await isGrokUsageFile(join(dir, 'events.jsonl'))).toBe(false)
    expect(await grokEntries(0, root)).toHaveLength(1)
  })

  // [trigger branch] The decision lives at file selection, not inside parsing. A subagent
  // parsed before its summary had session_kind would otherwise freeze into the blob cache and
  // double count forever, because the file never changes again.
  it('stops counting once session_kind is written late', async () => {
    const root = sessionsRoot()
    const dir = join(root, 'cwd-group', 'late')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'updates.jsonl'), turnLine({ promptID: 'p1' }), 'utf8')
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ session_summary: 'x' }), 'utf8')
    expect(await grokEntries(0, root)).toHaveLength(1)

    // The updates file is untouched; only the sibling summary changes.
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ session_kind: 'subagent' }), 'utf8')
    expect(await grokEntries(0, root)).toEqual([])
  })
})

describe('cost and model', () => {
  it('converts ticks to dollars', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [turnLine({ promptID: 'p1', costTicks: 12_000_000_000 })])
    expect((await parseGrokFile(path))[0]?.explicitCost).toBeCloseTo(1.2, 9)
  })

  // There is no Grok rate table, so the alternative to a trusted number is 0, not a guess.
  it.each([
    ['costIsPartial', { costIsPartial: true }],
    ['usageIsIncomplete', { usageIsIncomplete: true }],
  ])('drops the cost when %s is set', async (_label, flag) => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [turnLine({ promptID: 'p1', ...flag })])
    expect((await parseGrokFile(path))[0]?.explicitCost).toBeUndefined()
  })

  it('drops a zero cost rather than recording it', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [turnLine({ promptID: 'p1', costTicks: 0 })])
    expect((await parseGrokFile(path))[0]?.explicitCost).toBeUndefined()
  })

  it('names the model from the busiest row', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [turnLine({ promptID: 'p1', model: 'grok-code-fast-1' })])
    expect((await parseGrokFile(path))[0]?.model).toBe('grok-code-fast-1')
  })

  it('falls back to a generic name with no model breakdown', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [turnLine({ promptID: 'p1', model: null })])
    expect((await parseGrokFile(path))[0]?.model).toBe('grok')
  })
})

describe('turn time', () => {
  // The envelope timestamp is the moment it was written, and a fork re-stamps it while
  // copying — using it alone piles a forked history onto the fork date.
  it('prefers the agent timestamp over the envelope write time', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [
      turnLine({
        promptID: 'p1',
        agentTimestampMs: 1_700_000_000_000,
        envelopeSeconds: 1_785_000_010,
      }),
    ])
    expect((await parseGrokFile(path))[0]?.date).toBe(1_700_000_000_000)
  })

  it('uses the envelope seconds when the agent timestamp is missing', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [
      turnLine({ promptID: 'p1', agentTimestampMs: null, envelopeSeconds: 1_785_000_010 }),
    ])
    expect((await parseGrokFile(path))[0]?.date).toBe(1_785_000_010_000)
  })

  it('drops a turn with no usable time at all', async () => {
    const root = sessionsRoot()
    const path = writeSession(root, 's1', [
      turnLine({ promptID: 'p1', agentTimestampMs: null, envelopeSeconds: null }),
    ])
    expect(await parseGrokFile(path)).toEqual([])
  })
})
