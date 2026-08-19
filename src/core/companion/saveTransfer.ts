/**
 * Save transfer between machines, ported from `Core/SaveTransfer.swift`.
 *
 * The state is wrapped in an envelope rather than written out directly, because state
 * decoding is deliberately lenient (one broken field must not destroy a Pokédex) — which
 * means **any JSON at all** decodes "successfully" with every field defaulted. Without the
 * envelope, importing someone else's JSON would succeed and leave an empty Pokédex, which
 * reads to the user as "the app deleted my progress". `format` and `schema` have no defaults,
 * so they catch that first.
 */

import {
  type CompanionState,
  captureRateCeiling,
  freshCompanionState,
} from './model.js'
import { decodeCompanionState } from './persistence.js'

export const SAVE_FORMAT_ID = 'tokendex.save'
export const SAVE_SCHEMA_VERSION = 1

/**
 * Normal saves are a few kilobytes and a full Pokédex stays under a few hundred. Without a
 * ceiling a huge JSON blocks parsing for seconds (measured in Swift: 39MB froze the main
 * thread ~1.8s).
 */
export const MAX_SAVE_BYTES = 8 * 1024 * 1024

/**
 * Ceiling for any number inside a save: 100,000x real usage (billions), so real progress is
 * never clipped, while sums and differences of these stay inside a safe integer.
 */
export const MAX_TOKEN_VALUE = 1_000_000_000_000_000

export interface SaveEnvelope {
  format: string
  schema: number
  appVersion: string
  /** Epoch milliseconds. */
  exportedAt: number
  sourceDevice: string
  state: CompanionState
}

/** Summary shown in the overwrite confirmation, so the warning names what is replaced. */
export interface SaveSummary {
  dexCount: number
  lifetimeTokens: number
}

export function summarize(state: CompanionState): SaveSummary {
  return { dexCount: state.dex.length, lifetimeTokens: state.usedSinceInstall }
}

export type SaveTransferError =
  | { kind: 'notASaveFile' }
  | { kind: 'newerSchema'; found: number; supported: number }
  | { kind: 'fileTooLarge'; bytes: number; limit: number }

export class SaveTransferFailure extends Error {
  constructor(readonly detail: SaveTransferError) {
    super(detail.kind)
    this.name = 'SaveTransferFailure'
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

function dayStamp(millis: number): string {
  const d = new Date(millis)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function secondStamp(millis: number): string {
  const d = new Date(millis)
  return `${dayStamp(millis)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** The date is part of the name so repeated exports do not overwrite each other. */
export function suggestedFileName(millis: number): string {
  return `Tokendex-Save-${dayStamp(millis)}.json`
}

/**
 * Backups get a new slot every import. Keeping only one means a second import overwrites the
 * **original** — precisely in the situation ("I imported the wrong file, undo it") where the
 * thing to undo to has just been destroyed.
 */
export function backupFileName(millis: number): string {
  return `companion-state.pre-import-${secondStamp(millis)}.json`
}
export const BACKUP_FILE_PREFIX = 'companion-state.pre-import-'
export const BACKUPS_TO_KEEP = 5

export function encodeSave(
  state: CompanionState,
  appVersion: string,
  deviceName: string,
  now: number,
): string {
  const envelope: SaveEnvelope = {
    format: SAVE_FORMAT_ID,
    schema: SAVE_SCHEMA_VERSION,
    appVersion,
    exportedAt: now,
    sourceDevice: deviceName,
    state,
  }
  // Pretty-printed so a human can open it and see what is being moved. At ~4KB, size is moot.
  // Keys are sorted for a stable diff — NOT via `JSON.stringify`'s array replacer, which is a
  // recursive key allowlist and silently drops every nested field it does not list.
  return JSON.stringify(withSortedKeys(envelope), null, 2)
}

/** Recursively sorts object keys so exports diff cleanly. Arrays keep their order. */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys)
  if (typeof value !== 'object' || value === null) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = withSortedKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

export function decodeSave(text: string, hostLanguage?: string): SaveEnvelope {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_SAVE_BYTES) {
    throw new SaveTransferFailure({ kind: 'fileTooLarge', bytes, limit: MAX_SAVE_BYTES })
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new SaveTransferFailure({ kind: 'notASaveFile' })
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new SaveTransferFailure({ kind: 'notASaveFile' })
  }
  const outer = raw as Record<string, unknown>

  // The header is read first so a save from a *newer* build is reported accurately. Without
  // it, such a file shows up as "not a save file" and the user never learns that updating
  // the extension is the fix.
  if (outer['format'] !== SAVE_FORMAT_ID) throw new SaveTransferFailure({ kind: 'notASaveFile' })
  const schema = outer['schema']
  if (typeof schema !== 'number') throw new SaveTransferFailure({ kind: 'notASaveFile' })
  if (schema > SAVE_SCHEMA_VERSION) {
    throw new SaveTransferFailure({
      kind: 'newerSchema',
      found: schema,
      supported: SAVE_SCHEMA_VERSION,
    })
  }

  let state: CompanionState
  try {
    state = decodeCompanionState(outer['state'], hostLanguage)
  } catch {
    throw new SaveTransferFailure({ kind: 'notASaveFile' }) // same schema but unreadable = corrupt
  }

  const exportedAtRaw = outer['exportedAt']
  return {
    format: SAVE_FORMAT_ID,
    schema,
    appVersion: typeof outer['appVersion'] === 'string' ? outer['appVersion'] : '',
    exportedAt:
      typeof exportedAtRaw === 'number'
        ? exportedAtRaw
        : typeof exportedAtRaw === 'string'
          ? (Date.parse(exportedAtRaw) || 0)
          : 0,
    sourceDevice: typeof outer['sourceDevice'] === 'string' ? outer['sourceDevice'] : '',
    state: sanitized(state),
  }
}

/**
 * Normalises trust-boundary values, because a save arrives from **outside** the app (hand
 * edits, transfer corruption, a different build).
 *
 * State decoding is deliberately lenient, so nonsensical values get through. Persisting them
 * would then make later arithmetic overflow — and in Swift that killed the process, which
 * restarted, read the same file and died again, leaving the app unusable until the file was
 * deleted by hand. Automatic corruption recovery never fires, because decoding *succeeded*.
 *
 * Guarding at each arithmetic site would just reopen the hole every time a new site appears,
 * so normalisation happens once, at the boundary. Only fields that actually feed arithmetic
 * are touched — Pokédex and inventory entries are never trimmed, because that is data loss.
 */
export function sanitized(state: CompanionState): CompanionState {
  const clamp = (v: number) => Math.min(Math.max(0, v), MAX_TOKEN_VALUE)
  const next: CompanionState = {
    ...state,
    usedSinceInstall: clamp(state.usedSinceInstall),
    spentTokens: clamp(state.spentTokens),
    eggUsage: clamp(state.eggUsage),
  }

  if (state.claimedTodayTokensByProvider !== undefined) {
    next.claimedTodayTokensByProvider = Object.fromEntries(
      Object.entries(state.claimedTodayTokensByProvider).map(([k, v]) => [k, clamp(v)]),
    )
  }

  // An egg guarantee belongs to the egg currently being incubated, so it cannot coexist with
  // an active Pokémon. If a hand edit or an odd version combination produces both, the
  // guarantee would leak onto the *next* egg and become permanently premium. The species
  // pre-rolled under it goes too: dropping only the guarantee would let the **free** egg
  // received after graduating hatch that pre-roll, producing a premium result nobody bought.
  if (next.active !== undefined) {
    delete next.eggTier
    delete next.pendingHatchID
  }

  // An unsatisfiable guarantee locks the egg forever: legendary cannot be expressed via
  // capture_rate, so both roll paths find zero candidates, the guarantee is never consumed,
  // and buying another egg is blocked by the active-Pokémon gate. Decoding *succeeds*, so
  // corruption recovery never fires either. Lenient decoding only filters unknown values —
  // a known but impossible one passes straight through.
  if (next.eggTier !== undefined && captureRateCeiling(next.eggTier) === undefined) {
    delete next.eggTier
  }

  if (next.active !== undefined) {
    const active = { ...next.active }
    active.usedAtStage = clamp(active.usedAtStage)
    // `totalForms` appears as `k * (k + 1)` in phaseThreshold, so a large value is itself a
    // trap.
    active.totalForms = Math.min(Math.max(1, active.totalForms), 12)
    active.stageIndex = Math.min(Math.max(0, active.stageIndex), Math.max(0, active.pathIDs.length - 1))
    next.active = active
  }
  return next
}

/**
 * Rebases an imported state onto **this** machine.
 *
 * The fields fall into three groups:
 *  - **Progress** — true on any machine (`usedSinceInstall`, `dex`, `inventory`, `active`,
 *    `eggUsage`, `eggTier`). Carried over as-is. An egg guarantee is something that was
 *    bought, not this machine's ledger, so it travels with the save.
 *  - **Local ledger** — how far *that* machine had accrued (`claimedTodayTokensByProvider`,
 *    `lastDate`, `installBaselineSet`). Re-anchored here. Importing it verbatim would make
 *    the old machine's daily total a threshold, so the per-provider increment gate stays
 *    false for the rest of the day and this machine's usage silently fails to register —
 *    and it fixes itself at midnight, which is exactly why it does not look like a bug.
 *  - **Device preference** — how things are displayed here, not progress (`language`). The
 *    current machine's value wins: a save from a Japanese Mac must not switch an English
 *    Mac's UI language.
 *
 * The account-wide grant ledger (`candyGrantTier`) is **merged per key by max**, not
 * replaced. Limit-window keys are account-scoped, so both machines see the same windows;
 * wholesale replacement by an older save would erase a window already paid out and grant its
 * candy again.
 */
export function rebasedForThisDevice(
  imported: CompanionState,
  current: CompanionState,
  observation: {
    todayTokensByProvider: Record<string, number>
    todayDate: string
    hasUsageData: boolean
  },
): CompanionState {
  const state: CompanionState = { ...imported }
  state.language = current.language
  state.candyGrantTier = mergedGrantTier(imported.candyGrantTier, current.candyGrantTier)
  state.candyFeatureSeeded = imported.candyFeatureSeeded || current.candyFeatureSeeded

  const hasCurrentProviderData =
    observation.hasUsageData && Object.keys(observation.todayTokensByProvider).length > 0

  if (hasCurrentProviderData) {
    // Same rule as a fresh install: usage on this machine from before the import is not
    // retroactively granted.
    state.installBaselineSet = true
    state.claimedTodayTokensByProvider = { ...observation.todayTokensByProvider }
    state.lastDate = observation.todayDate
  } else {
    // This machine's usage for today is not known yet (not parsed, no providers, only a
    // stale snapshot). `hasUsageData` says a snapshot exists, not that today's data does.
    // Saving an empty map as an already-seeded ledger would make the first healthy snapshot
    // look like a "new provider" and silently drop that day's usage up to that point, so the
    // baseline decision is handed back to the fresh-install path.
    state.installBaselineSet = false
    delete state.claimedTodayTokensByProvider
    state.lastDate = ''
  }
  return state
}

/** Keeps the higher tier per window: granted on either machine counts as granted. */
export function mergedGrantTier(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const merged = { ...a }
  for (const [key, value] of Object.entries(b)) {
    merged[key] = Math.max(merged[key] ?? 0, value)
  }
  return merged
}

export { freshCompanionState }
