/**
 * Claude Code log parsing, ported from the Claude section of `Core/LocalUsageReader.swift`.
 *
 * Source: `<root>/**\/*.jsonl`, lines with `type:"assistant"` carrying `message.usage`
 * (four token kinds), `message.model`, `message.id` + `requestId` and `timestamp`.
 * Session resume and sidechains duplicate the same message across files, so entries are
 * de-duplicated on `(message.id, requestId)`.
 */

import { promises as fs } from 'node:fs'
import { parseISO8601 } from '../iso8601.js'
import type { Json } from '../models.js'
import { type Entry, dedupKeepMax, intValue, localDayKey } from './entry.js'
import { claudeProjectRoots } from './roots.js'
import { jsonlFiles } from './scan.js'

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseClaudeLine(line: string): Entry | undefined {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(obj) || obj['type'] !== 'assistant') return undefined

  const msg = obj['message']
  if (!isObject(msg)) return undefined
  const usage = msg['usage']
  if (!isObject(usage)) return undefined

  const ts = obj['timestamp']
  if (typeof ts !== 'string') return undefined
  const date = parseISO8601(ts)
  if (date === null) return undefined

  const model = typeof msg['model'] === 'string' ? msg['model'] : 'unknown'
  const messageID = typeof msg['id'] === 'string' ? msg['id'] : ''
  const requestID = typeof obj['requestId'] === 'string' ? obj['requestId'] : ''

  return {
    id: `${messageID}|${requestID}`,
    date,
    localDay: localDayKey(date),
    model,
    input: intValue(usage['input_tokens']),
    output: intValue(usage['output_tokens']),
    cacheWrite: intValue(usage['cache_creation_input_tokens']),
    cacheRead: intValue(usage['cache_read_input_tokens']),
  }
}

/**
 * Parses one file, de-duplicating within it. The cache calls this per file.
 *
 * The substring pre-filter matters: `JSON.parse` on every line of a multi-hundred-megabyte
 * corpus dominates the scan, and most lines are not assistant turns.
 */
export async function parseClaudeFile(path: string): Promise<Entry[]> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch {
    return []
  }
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    const entry = parseClaudeLine(line)
    if (entry !== undefined) out.push(entry)
  }
  return dedupKeepMax(out)
}

/**
 * Claude entries from files modified since `modifiedSince`, de-duplicated globally.
 *
 * Without `roots`, every discovered root is walked. Overlapping roots are safe: the global
 * `(message.id, requestId)` de-duplication counts a turn once even if it is copied into
 * several roots, so totals do not inflate.
 */
export async function claudeEntries(
  modifiedSince: number,
  roots?: string[],
): Promise<Entry[]> {
  const targets = roots ?? (await claudeProjectRoots())
  const all: Entry[] = []
  for (const root of targets) {
    for (const file of await jsonlFiles(root, modifiedSince)) {
      all.push(...(await parseClaudeFile(file.path)))
    }
  }
  return dedupKeepMax(all)
}
