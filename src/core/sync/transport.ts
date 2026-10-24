/**
 * Where synced saves live, as far as the engine is concerned: a flat set of named text files.
 *
 * One file per device, each written only by its own device (`docs/sync.md` §4.2). That is what
 * lets a transport with no compare-and-swap — a gist — carry the save: no file ever has two
 * writers, so there is no write to lose, and the merge on the reading side is symmetric, so
 * every device converges on the same game.
 *
 * Core: no `vscode`. The GitHub implementation is `gistTransport.ts`; tests use an in-memory one.
 */

export interface RemoteFile {
  name: string
  text: string
}

/** `notModified`: the etag still matches, so nothing has changed since the last read. */
export type ReadResult = { kind: 'notModified' } | { kind: 'files'; files: RemoteFile[]; etag?: string }

export interface SyncTransport {
  /** Every file, unless `etag` says nothing moved since it was handed out. */
  read(etag?: string): Promise<ReadResult>
  /** Creates or replaces one file. Must not touch any other. */
  write(name: string, text: string): Promise<void>
}

/**
 * - `auth`: the credential was refused; the host has to get a new one.
 * - `notFound`: the store vanished (the gist was deleted) and could not be recreated.
 * - `rateLimited`: back off; `retryAfterMs` says for how long when the server said.
 * - `network`: offline, a timeout, a 5xx. Retried with backoff.
 * - `tooLarge`: the payload was refused for its size.
 * - `protocol`: the server answered something this client does not understand.
 */
export type SyncErrorReason = 'auth' | 'notFound' | 'rateLimited' | 'network' | 'tooLarge' | 'protocol'

/**
 * The one error a transport throws. The message never carries a request's headers: an
 * `Authorization` header in an error that reaches the output channel is a leaked token.
 */
export class SyncError extends Error {
  constructor(
    readonly reason: SyncErrorReason,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}
