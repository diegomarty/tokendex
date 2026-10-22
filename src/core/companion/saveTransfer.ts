/**
 * Save transfer between machines.
 *
 * The state is wrapped in an envelope rather than written out directly, because state
 * decoding is deliberately lenient (one broken field must not destroy a Pokédex) — which
 * means **any JSON at all** decodes "successfully" with every field defaulted. Without the
 * envelope, importing someone else's JSON would succeed and leave an empty Pokédex, which
 * reads to the user as "the app deleted my progress". `format` and `schema` have no defaults,
 * so they catch that first.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  type CompanionState,
  EGG_STOCK_MAX,
  RareCandy,
  captureRateCeiling,
  freshCompanionState,
} from './model.js'
import {
  EncounterBalance,
  LegendaryBalance,
  StealBalance,
  StreakBalance,
  TrailBalance,
} from './encounters.js'
import { decodeCompanionState } from './persistence.js'
import { isTrainerID } from './trainers.js'

export const SAVE_FORMAT_ID = 'tokendex.save'
export const SAVE_SCHEMA_VERSION = 1

/**
 * Normal saves are a few kilobytes and a full Pokédex stays under a few hundred. Without a
 * ceiling a huge JSON blocks parsing for seconds (measured: 39MB froze the main thread
 * ~1.8s).
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

/**
 * Backups sync takes before it replaces this machine's history — named and rotated apart from the
 * import backups, so a busy week of syncing can never rotate away the backup an import promised.
 */
export function syncBackupFileName(millis: number): string {
  return `${SYNC_BACKUP_FILE_PREFIX}${secondStamp(millis)}.json`
}
export const SYNC_BACKUP_FILE_PREFIX = 'companion-state.pre-sync-'

/**
 * Which backups to delete so at most `keep` of them remain, newest kept.
 *
 * Sorted by **name**, not by mtime: `backupFileName` stamps a lexicographically sortable
 * timestamp into it precisely so this decision needs no filesystem and stays testable. Copying
 * a backup around (a restore attempt, a sync client) rewrites its mtime but never its name.
 *
 * Anything that is not one of our backups is untouched — this runs in a directory that also
 * holds the live save, the usage cache and the sprite index.
 */
export function expiredBackups(
  names: string[],
  keep: number = BACKUPS_TO_KEEP,
  prefix: string = BACKUP_FILE_PREFIX,
): string[] {
  const backups = names.filter((name) => name.startsWith(prefix)).sort()
  return backups.slice(0, Math.max(0, backups.length - Math.max(0, keep)))
}

/**
 * Deletes all but the newest `keep` backups in `directory`.
 *
 * Best effort by design: a backup that cannot be removed is clutter, and failing an import (or
 * a corruption recovery) over clutter would be the worse trade by a wide margin.
 */
export async function pruneBackups(
  directory: string,
  keep: number = BACKUPS_TO_KEEP,
  prefix: string = BACKUP_FILE_PREFIX,
): Promise<void> {
  try {
    for (const name of expiredBackups(await fs.readdir(directory), keep, prefix)) {
      await fs.rm(join(directory, name), { force: true })
    }
  } catch {
    // The directory vanished, or is unreadable. Nothing here is worth interrupting for.
  }
}

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
          ? Date.parse(exportedAtRaw) || 0
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
 * would then make later arithmetic overflow, and an overflow on load fails in the worst
 * possible way: the app restarts, reads the same file and fails again, leaving it unusable
 * until the file is deleted by hand. Automatic corruption recovery never fires, because
 * decoding *succeeded*.
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

  // An egg and an active Pokémon coexist on purpose: choosing a companion pauses the egg, and
  // the guarantee paid for it stays with it until it hatches. (It used to be dropped here.)
  next.eggStock = {
    count: Math.min(EGG_STOCK_MAX, Math.max(0, Math.floor(state.eggStock?.count ?? 0))),
    ...(state.eggStock?.lastGrantDay !== undefined ? { lastGrantDay: state.eggStock.lastGrantDay } : {}),
  }

  // A legendary egg guarantee is dropped rather than honoured. It was never sold
  // (`FreshEgg.shopTiers`), so a state carrying one came from a hand edit or an odd version
  // combination — and decoding *succeeds* for it, since lenient decoding only filters unknown
  // values and `'legendary'` is a perfectly known one.
  //
  // Historically this guard also prevented a lock-up: capture_rate cannot express the tier, so
  // both roll paths found zero candidates, the guarantee was never consumed and buying another
  // egg stayed blocked by the active-Pokémon gate. The index now carries the legendary flags
  // (see `meetsRarityFloor`), so the pool would no longer be empty — which makes dropping it a
  // pricing decision now rather than a data one, and the reason to keep it is that nobody paid
  // for it.
  if (next.eggTier !== undefined && captureRateCeiling(next.eggTier) === undefined) {
    delete next.eggTier
  }

  // Both feed the merge's arithmetic: a hand-edited `1e30` would credit itself as growth.
  const clampAll = (record: Record<string, number> | undefined) =>
    Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [k, clamp(v)]))
  next.usedByDevice = clampAll(state.usedByDevice)
  next.revision = clampAll(state.revision)

  next.encounterUsage = clamp(state.encounterUsage ?? 0)
  next.encountersSeen = clamp(state.encountersSeen ?? 0)
  next.milestonesAwarded = clamp(state.milestonesAwarded ?? 0)

  // An owed legendary is an IOU the spawn path pays out one per refresh, for ever, so an
  // imported `1e9` would turn the wild tab into a legendary faucet. One full queue is the most
  // that could ever be waiting to be delivered at once, which makes it the honest ceiling.
  next.owedLegendaryEncounters = Math.min(
    Math.max(0, state.owedLegendaryEncounters ?? 0),
    LegendaryBalance.maxOwed,
  )

  // Deduplicated and capped for the same reason the decoder does it: a repeated day would
  // count twice toward the streak, and the array is read on every fold.
  next.accrualDays = [...new Set(state.accrualDays ?? [])].sort().slice(-StreakBalance.windowDays)

  // The wild queue is the one collection that *is* trimmed here, and it is not data loss in
  // the way a Pokédex would be: an encounter is a pending offer, not something earned. A save
  // carrying ten thousand of them would otherwise be drawn as ten thousand rows. `throws` and
  // `captureRate` are clamped because both feed the catch and flee formulas directly — an
  // imported `throws: 1e9` would make every encounter flee on the first miss.
  //
  // Mood and temperament feed the catch and reaction formulas the same way, so they are clamped
  // to their 0–100 range; `stolen` is the most one encounter can have taken, because a catch pays
  // it back — an imported `1e15` would be a refund faucet.
  const pct = (v: number) => Math.min(100, Math.max(0, v))
  next.wild = (state.wild ?? []).slice(0, EncounterBalance.maxQueue).map((encounter) => {
    const clean = {
      ...encounter,
      captureRate: Math.min(Math.max(1, encounter.captureRate), 255),
      throws: Math.min(Math.max(0, encounter.throws), 99),
    }
    if (encounter.mood !== undefined) {
      clean.mood = {
        anger: pct(encounter.mood.anger),
        nervousness: pct(encounter.mood.nervousness),
        trust: pct(encounter.mood.trust),
      }
    }
    if (encounter.temperament !== undefined) {
      clean.temperament = {
        aggression: pct(encounter.temperament.aggression),
        skittishness: pct(encounter.temperament.skittishness),
        appetite: pct(encounter.temperament.appetite),
      }
    }
    if (encounter.stolen !== undefined) {
      const ceiling = StealBalance.amount[encounter.rarity] * StealBalance.perEncounter
      clean.stolen = Math.min(Math.max(0, encounter.stolen), ceiling)
    }
    if (encounter.trackedCount !== undefined) {
      clean.trackedCount = Math.min(Math.max(0, encounter.trackedCount), TrailBalance.maxTracks)
    }
    return clean
  })
  // Finds share the queue's room; whatever the Pokémon leave is all they get.
  next.finds = (state.finds ?? [])
    .slice(0, Math.max(0, EncounterBalance.maxQueue - next.wild.length))
    .map((find) => ({ ...find, count: Math.min(Math.max(1, find.count), 10) }))
  next.legendaryTrail = (state.legendaryTrail ?? []).slice(-TrailBalance.maxEntries).map((entry) => ({
    ...entry,
    captureRate: Math.min(Math.max(1, entry.captureRate), 255),
    trackedCount: Math.min(Math.max(0, entry.trackedCount), TrailBalance.maxTracks),
  }))
  next.queueFullArmed = state.queueFullArmed ?? true

  // An unknown slug would render as a broken image on every repaint. Falling back to absent
  // (the roster default) is invisible and correct.
  if (next.trainerID !== undefined && !isTrainerID(next.trainerID)) delete next.trainerID
  if (next.keepCompletedCompanion !== true) delete next.keepCompletedCompanion

  if (next.active !== undefined) {
    const active = { ...next.active }
    active.usedAtStage = clamp(active.usedAtStage)
    // `totalForms` appears as `k * (k + 1)` in phaseThreshold, so a large value is itself a
    // trap.
    active.totalForms = Math.min(Math.max(1, active.totalForms), 12)
    active.stageIndex = Math.min(Math.max(0, active.stageIndex), Math.max(0, active.pathIDs.length - 1))
    next.active = active
  }

  // The registry: integers clamped like every other counter, shares kept to 0..1, and the
  // candy count to its cap — an imported `candiesUsed: -1e9` would otherwise be a candy faucet.
  next.earnedTokens = clamp(state.earnedTokens ?? 0)
  next.species = Object.fromEntries(
    Object.entries(state.species ?? {}).map(([id, p]) => {
      const clean = { ...p, xp: clamp(p.xp), caught: Math.min(clamp(p.caught), 1_000_000) }
      clean.candiesUsed = Math.min(Math.max(0, p.candiesUsed), RareCandy.maxPerSpecies)
      if (p.threshold !== undefined) clean.threshold = Math.max(1, clamp(p.threshold))
      if (p.baseID !== undefined) clean.baseID = Math.max(1, Math.floor(p.baseID))
      if (p.stageIndex !== undefined) clean.stageIndex = Math.max(0, Math.floor(p.stageIndex))
      if (p.totalForms !== undefined)
        clean.totalForms = Math.min(12, Math.max(1, Math.floor(p.totalForms)))
      if (p.pendingShare !== undefined) clean.pendingShare = Math.min(1, Math.max(0, p.pendingShare))
      if (p.shinyXP !== undefined) clean.shinyXP = clamp(p.shinyXP)
      if (p.shinyBoosted !== undefined) clean.shinyBoosted = clamp(p.shinyBoosted)
      return [id, clean]
    }),
  )
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

/** The larger value per key: the merge of two grow-only counter maps. */
export function perKeyMax(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const merged = { ...a }
  for (const [key, value] of Object.entries(b)) {
    merged[key] = Math.max(merged[key] ?? 0, value)
  }
  return merged
}

/** Keeps the higher tier per window: granted on either machine counts as granted. */
export function mergedGrantTier(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  return perKeyMax(a, b)
}

export { freshCompanionState }
