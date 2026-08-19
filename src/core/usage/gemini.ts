/**
 * NOT YET VERIFIED — ported but deliberately untested and not wired into the provider list.
 * Scope was cut to Claude + Codex; this file waits for its own test port before being used.
 *
 * Gemini CLI session parsing, ported from the Gemini section of `Core/LocalUsageReader.swift`.
 *
 * Sources: `~/.gemini/tmp/<hash>/chats/session-*.jsonl` and the legacy `.json` form.
 *  - New `.jsonl`: one record per line — inline tokens on `type=="gemini"` messages, or
 *    `type=="message_update"` tokens (for a given id the last value wins).
 *  - Legacy `.json`: a single ConversationRecord `{ messages: [...] }`.
 *
 * Token mapping preserves usageMetadata semantics so `entryTotal === totalTokenCount`:
 *   input = (input - cached) + tool(toolUsePrompt, prompt side) / cacheRead = cached
 *   output = output + thoughts (reasoning, output side) / cacheWrite = 0
 */

import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'
import { parseISO8601 } from '../iso8601.js'
import type { Json } from '../models.js'
import { type Entry, intValue, localDayKey } from './entry.js'
import { geminiTmpDir } from './roots.js'
import { jsonlFiles } from './scan.js'

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function parseGeminiFile(path: string): Promise<Entry[]> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch {
    return []
  }
  const file = basename(path)
  // message id -> entry; a later message_update replaces the earlier value.
  const byID = new Map<string, Entry>()
  const order: string[] = []
  let synthetic = 0

  const absorb = (obj: Json, fallbackTimestamp: number | undefined): void => {
    const tokens = obj['tokens']
    if (!isObject(tokens)) return
    const id = typeof obj['id'] === 'string' ? obj['id'] : `synthetic-${synthetic++}`
    const ts = typeof obj['timestamp'] === 'string' ? parseISO8601(obj['timestamp']) : null
    const date = ts ?? fallbackTimestamp
    if (date === undefined || date === null) return

    const input = intValue(tokens['input'])
    const cached = intValue(tokens['cached'])
    const entry: Entry = {
      id: `gemini|${file}|${id}`,
      date,
      localDay: localDayKey(date),
      model: typeof obj['model'] === 'string' ? obj['model'] : 'gemini',
      input: Math.max(0, input - cached) + intValue(tokens['tool']),
      output: intValue(tokens['output']) + intValue(tokens['thoughts']),
      cacheWrite: 0,
      cacheRead: cached,
    }
    if (!byID.has(id)) order.push(id)
    byID.set(id, entry)
  }

  if (extname(path) === '.jsonl') {
    let lastTimestamp: number | undefined
    for (const line of text.split('\n')) {
      if (line === '') continue
      if (!line.includes('"tokens"') && !line.includes('"timestamp"')) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObject(obj)) continue
      if (typeof obj['timestamp'] === 'string') {
        const ts = parseISO8601(obj['timestamp'])
        if (ts !== null) lastTimestamp = ts
      }
      absorb(obj, lastTimestamp)
    }
  } else {
    // Legacy single JSON document with a messages array.
    let obj: unknown
    try {
      obj = JSON.parse(text)
    } catch {
      return []
    }
    if (!isObject(obj)) return []
    const messages = obj['messages']
    if (!Array.isArray(messages)) return []
    const startRaw = obj['startTime']
    const sessionStart = typeof startRaw === 'string' ? (parseISO8601(startRaw) ?? undefined) : undefined
    for (const m of messages) if (isObject(m)) absorb(m, sessionStart)
  }

  return order.map((id) => byID.get(id)).filter((e): e is Entry => e !== undefined)
}

export async function geminiEntries(modifiedSince: number, root?: string): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const file of await jsonlFiles(root ?? geminiTmpDir(), modifiedSince, { allowJSON: true })) {
    entries.push(...(await parseGeminiFile(file.path)))
  }
  return entries
}
