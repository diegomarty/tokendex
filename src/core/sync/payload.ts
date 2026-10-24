/**
 * What one device publishes to the others: its save, in the export envelope, minus this
 * machine's ledger.
 *
 * The envelope is `encodeSave`'s on purpose — the format id, the schema check that refuses a
 * save from a newer build, the size ceiling and `sanitized` at the trust boundary all come with
 * it, so a synced save is held to exactly the rules an imported one is.
 *
 * **The local fields are stripped**, and not for privacy alone: they are rewritten on every scan
 * (`claimedTodayTokensByProvider`, `lastDate`), so if they travelled, every scan would change
 * the payload and push, and two open machines would upload all day for nothing. `mergeSaves`
 * takes all of them from the local side anyway.
 */

import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { type CompanionState } from '../companion/model.js'
import { MAX_SAVE_BYTES, SaveTransferFailure, decodeSave, encodeSave } from '../companion/saveTransfer.js'

const FILE_PATTERN = /^tokendex-([0-9a-f]{32})\.json$/

/** The file a device publishes under; its id is the only thing in the name. */
export function syncFileName(deviceID: string): string {
  return `tokendex-${deviceID}.json`
}

/** The device behind a file name, or `undefined` for anything that is not a device save. */
export function deviceOfSyncFile(name: string): string | undefined {
  return FILE_PATTERN.exec(name)?.[1]
}

/** Fields that describe this machine, not the game. The same list `mergeSaves` keeps local. */
export const LOCAL_ONLY_FIELDS = [
  'installBaselineSet',
  'lastDate',
  'claimedTodayTokensByProvider',
  'language',
  'keepCompletedCompanion',
  'lastEncounterToastAt',
  'queueFullArmed',
] as const satisfies readonly (keyof CompanionState)[]

/**
 * Above this the text is gzipped. A full Pokédex is ~260 KB (`docs/sync.md` §1) and GitHub
 * serves a gist file whole up to 1 MB; compressing well before that keeps every read one request.
 */
export const COMPRESS_ABOVE_BYTES = 256 * 1024
const GZIP_PREFIX = 'gz:'

export interface SyncPayloadMeta {
  appVersion: string
  /** The device label, never the hostname (`device.ts`). */
  label: string
}

export interface SyncPayload {
  text: string
  /** Of the uncompressed text: equal digests mean nothing worth pushing changed. */
  digest: string
}

export function encodeSyncPayload(state: Readonly<CompanionState>, meta: SyncPayloadMeta): SyncPayload {
  const travelling: Partial<CompanionState> = { ...state }
  for (const key of LOCAL_ONLY_FIELDS) delete travelling[key]
  // `exportedAt` is pinned: a timestamp would make every payload new, which is the churn the
  // stripping above exists to prevent.
  const json = encodeSave(travelling as CompanionState, meta.appVersion, meta.label, 0)
  const digest = createHash('sha256').update(json).digest('hex')
  const text =
    Buffer.byteLength(json, 'utf8') > COMPRESS_ABOVE_BYTES
      ? GZIP_PREFIX + gzipSync(json).toString('base64')
      : json
  return { text, digest }
}

export interface DecodedSyncPayload {
  state: CompanionState
  label: string
  appVersion: string
  digest: string
}

/** Throws `SaveTransferFailure`, exactly as importing a bad file does. */
export function decodeSyncPayload(text: string, hostLanguage?: string): DecodedSyncPayload {
  let json = text
  if (text.startsWith(GZIP_PREFIX)) {
    try {
      // Bounded: a small compressed text must not be allowed to inflate without limit.
      json = gunzipSync(Buffer.from(text.slice(GZIP_PREFIX.length), 'base64'), {
        maxOutputLength: MAX_SAVE_BYTES,
      }).toString('utf8')
    } catch {
      throw new SaveTransferFailure({ kind: 'notASaveFile' })
    }
  }
  const envelope = decodeSave(json, hostLanguage)
  return {
    state: envelope.state,
    label: envelope.sourceDevice,
    appVersion: envelope.appVersion,
    digest: createHash('sha256').update(json).digest('hex'),
  }
}
