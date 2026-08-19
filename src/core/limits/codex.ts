/**
 * Codex official limits.
 *
 * Codex exposes no limits file and no HTTP endpoint we may call — the numbers only exist
 * inside its own app-server. So this spawns `codex app-server --stdio`, speaks three JSON-RPC
 * lines at it, and reads one reply. It asks for an **account snapshot only**; it never starts
 * a model turn, so it costs the user nothing.
 *
 * The subprocess is the expensive part of a refresh, so treat it as the last resort it is:
 * one call per refresh, a hard timeout, and no retry.
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import * as AppPaths from '../appPaths.js'
import { augmentedPath, commonToolPaths, resolveBinary } from '../binaryLocator.js'
import { childEnvironment, inheritedPath } from '../shellEnvironment.js'
import { type CodexRateLimitStatus, decodeCodexRateLimitStatus } from './models.js'

const RESPONSE_ID = 1
const DEFAULT_TIMEOUT_MS = 20_000

export function defaultBinaryCandidates(home: string = AppPaths.home()): string[] {
  const candidates = [join(home, '.codex', 'bin', 'codex')]
  if (process.platform === 'darwin') {
    candidates.unshift('/Applications/Codex.app/Contents/Resources/codex')
  }
  return [...candidates, ...commonToolPaths('codex', home)]
}

export function resolveCodexBinary(home?: string): Promise<string | undefined> {
  return resolveBinary('codex', defaultBinaryCandidates(home))
}

/**
 * The three lines the app-server expects before it will answer.
 *
 * `initialized` carries no id on purpose — it is a notification, and giving it one makes the
 * server treat it as a request it never answers.
 */
export function requestLines(version: string): string[] {
  return [
    {
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: { name: 'tokendex', title: 'Tokendex', version },
        capabilities: { experimentalApi: true },
      },
    },
    { method: 'initialized', params: {} },
    { method: 'account/rateLimits/read', id: RESPONSE_ID, params: {} },
  ].map((message) => JSON.stringify(message))
}

export class CodexRPCError extends Error {}

/**
 * Scans accumulated stdout for the reply with `id`.
 *
 * Reading line by line rather than parsing the stream whole is what makes a partial write
 * harmless: the server interleaves notifications with the reply, and the tail of the buffer is
 * routinely half a line.
 */
export function jsonRPCResult(raw: string, responseID: number): unknown | undefined {
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let object: unknown
    try {
      object = JSON.parse(line)
    } catch {
      continue // a half-written line, or a log line that is not JSON at all
    }
    if (typeof object !== 'object' || object === null) continue
    const message = object as Record<string, unknown>
    if (message['id'] !== responseID) continue
    const error = message['error']
    if (typeof error === 'object' && error !== null) {
      const detail = (error as Record<string, unknown>)['message']
      throw new CodexRPCError(typeof detail === 'string' ? detail : JSON.stringify(error))
    }
    if (message['result'] === undefined) continue
    return message['result']
  }
  return undefined
}

export interface RunOptions {
  timeoutMs?: number
  version?: string
  home?: string
}

/**
 * Runs the exchange and resolves with the raw `result`, or `undefined` if the server never
 * produced one before exiting or timing out.
 *
 * stdout is drained as it arrives rather than after exit. A server that outlives its answer —
 * this one does, it keeps a session open — would otherwise hold the promise until the timeout
 * even though the reply was already on the wire.
 */
export async function runCodexRPC(
  binary: string,
  options: RunOptions = {},
): Promise<unknown | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<unknown | undefined>((resolve, reject) => {
    const child = spawn(binary, ['app-server', '--stdio'], {
      env: childEnvironment(augmentedPath(binary, inheritedPath())),
      stdio: ['pipe', 'pipe', 'ignore'],
    })

    let buffer = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.removeAllListeners()
      // The server does not exit on its own once a session is open.
      child.kill()
      fn()
    }

    const timer = setTimeout(() => finish(() => resolve(undefined)), timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      try {
        const result = jsonRPCResult(buffer, RESPONSE_ID)
        if (result !== undefined) finish(() => resolve(result))
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new CodexRPCError(String(e))))
      }
    })

    // A server that dies before reading stdin turns the write into EPIPE; the error listener
    // is what keeps that from taking down the extension host.
    child.stdin.on('error', () => undefined)
    child.on('error', () => finish(() => resolve(undefined)))
    child.on('close', () => finish(() => resolve(jsonRPCResultOrUndefined(buffer))))

    child.stdin.end(`${requestLines(options.version ?? '0.1.0').join('\n')}\n`)
  })
}

/** Post-exit re-read: the flush that carries the reply can land after the last `data` event. */
function jsonRPCResultOrUndefined(buffer: string): unknown | undefined {
  try {
    return jsonRPCResult(buffer, RESPONSE_ID)
  } catch {
    return undefined
  }
}

/** `undefined` means Codex is not installed, or told us nothing — not "no limits". */
export async function fetchCodexLimits(
  options: RunOptions = {},
): Promise<CodexRateLimitStatus | undefined> {
  const binary = await resolveCodexBinary(options.home)
  if (binary === undefined) return undefined
  const result = await runCodexRPC(binary, options)
  return result === undefined ? undefined : decodeCodexRateLimitStatus(result)
}
