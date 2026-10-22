/**
 * Merges two saves of the same player — one per machine — into one.
 *
 * The design is `docs/sync.md` §3–§4 with one change of policy: a fork is **resolved
 * automatically** rather than put to the user, because sync is meant to run without asking.
 * That is only acceptable because of what a fork can cost, so the rules are worth stating:
 *
 *  - **Growth is never lost.** Every device's tokens are counted per device (`usedByDevice`),
 *    so whatever one side accrued that the other has not seen is credited to the result through
 *    the same `creditDelta` a scan uses. Two machines open at once both keep all their usage.
 *  - **Collections are never lost.** The Pokédex and the other commutative fields are unioned
 *    whichever side wins.
 *  - **One history wins the narrative.** The companion, the egg, the bag, the balance and the
 *    wild queue are RNG-born and cannot be combined (§3.3), so they come whole from one side.
 *    When one save already contains the other, that save wins and nothing is lost at all. Only a
 *    true fork discards anything: the losing side's hatches, purchases and throws since the two
 *    last met. The winner is chosen from the saves alone, so both machines pick the same one.
 *  - **This machine's ledger never travels.** Today's per-provider claims, the date they
 *    belong to and the display language stay as they are here (§1.1).
 *
 * Pure: no clock, no randomness, no I/O. The caller owns the lock and the write.
 */

import { type CompanionState } from './model.js'
import { creditDelta } from './ledger.js'
import {
  LegendaryBalance,
  MilestoneBalance,
  StreakBalance,
  addEncounterUsage,
  grantLegendaryEncounter,
  queuedCount,
} from './encounters.js'
import { isDayKey } from './persistence.js'
import { type SpeciesProgress, freshSpeciesProgress } from './model.js'
import { mergedGrantTier, perKeyMax, sanitized } from './saveTransfer.js'

/**
 *  - `keptLocal`: this save already contained the other; only collections may have grown.
 *  - `adoptedRemote`: the other save contained this one, so its history continues here.
 *  - `forked`: both moved since they last met; `narrative` says whose history won.
 */
export type MergeOutcome = 'keptLocal' | 'adoptedRemote' | 'forked'

export interface MergeResult {
  state: CompanionState
  outcome: MergeOutcome
  /** Whose companion, egg, bag and balance the result carries. */
  narrative: 'local' | 'remote'
  /** Tokens the winning history had not seen, now credited to it. */
  creditedTokens: number
  /** Pokédex entries the result gained over the local save. */
  dexAdded: number
}

/** Every counter in `a` is at least the one in `b`: `a` has seen all of `b`'s history. */
function covers(a: Record<string, number>, b: Record<string, number>): boolean {
  return Object.entries(b).every(([device, count]) => (a[device] ?? 0) >= count)
}

/** Changes a side made since the two last agreed: its counters above the per-key minimum. */
function changesSinceFork(side: Record<string, number>, other: Record<string, number>): number {
  return Object.entries(side).reduce(
    (total, [device, count]) => total + Math.max(0, count - (other[device] ?? 0)),
    0,
  )
}

/** Canonical text of a counter map, so a tie can be broken identically on both machines. */
function canonical(record: Record<string, number>): string {
  return JSON.stringify(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Which history continues after a fork. **Symmetric**: `forkWinner(a, b)` names the same save
 * as `forkWinner(b, a)`, so the two machines converge instead of each keeping its own.
 *
 * The side that did more since the fork wins, because that is the side with more to lose. When
 * either side has no counters (a save from before sync) "since the fork" cannot be measured, so
 * lifetime usage — how far each game has progressed — decides instead. Ties fall to lifetime
 * usage, then to the canonical counters — arbitrary, but the same everywhere.
 */
function forkWinner(
  local: CompanionState,
  remote: CompanionState,
  untracked: boolean,
): 'local' | 'remote' {
  const localScore = untracked ? 0 : changesSinceFork(local.revision, remote.revision)
  const remoteScore = untracked ? 0 : changesSinceFork(remote.revision, local.revision)
  if (localScore !== remoteScore) return localScore > remoteScore ? 'local' : 'remote'
  if (local.usedSinceInstall !== remote.usedSinceInstall) {
    return local.usedSinceInstall > remote.usedSinceInstall ? 'local' : 'remote'
  }
  return canonical(local.revision) >= canonical(remote.revision) ? 'local' : 'remote'
}

/** Tokens `other` accrued that `base` has not counted, device by device. */
function unseenTokens(base: CompanionState, other: CompanionState): number {
  return Object.entries(other.usedByDevice).reduce((total, [device, used]) => {
    return total + Math.max(0, used - (base.usedByDevice[device] ?? 0))
  }, 0)
}

function mergeRegistries(
  base: Record<number, SpeciesProgress>,
  other: Record<number, SpeciesProgress>,
): Record<number, SpeciesProgress> {
  const out: Record<number, SpeciesProgress> = {}
  const ids = new Set([...Object.keys(base), ...Object.keys(other)].map(Number))
  for (const id of ids) {
    const a = base[id]
    const b = other[id]
    const merged: SpeciesProgress = {
      ...(a ?? freshSpeciesProgress()),
      unlocked: (a?.unlocked ?? false) || (b?.unlocked ?? false),
      seen: (a?.seen ?? false) || (b?.seen ?? false),
      registered: (a?.registered ?? false) || (b?.registered ?? false),
      caught: Math.max(a?.caught ?? 0, b?.caught ?? 0),
      candiesUsed: Math.max(a?.candiesUsed ?? 0, b?.candiesUsed ?? 0),
    }
    // Fixed from the line, so either side's reading is the reading.
    const threshold = a?.threshold ?? b?.threshold
    if (threshold !== undefined) merged.threshold = threshold
    const baseID = a?.baseID ?? b?.baseID
    if (baseID !== undefined) merged.baseID = baseID
    const stageIndex = a?.stageIndex ?? b?.stageIndex
    if (stageIndex !== undefined) merged.stageIndex = stageIndex
    const totalForms = a?.totalForms ?? b?.totalForms
    if (totalForms !== undefined) merged.totalForms = totalForms
    const lineRarity = a?.lineRarity ?? b?.lineRarity
    if (lineRarity !== undefined) merged.lineRarity = lineRarity
    // A share is owed only until a threshold settles it: once either side knows the threshold,
    // the side that fixed it has already turned its share into experience, and carrying the
    // other side's over would apply the same catch twice.
    const pendingShare = Math.max(a?.pendingShare ?? 0, b?.pendingShare ?? 0)
    if (pendingShare > 0 && threshold === undefined) merged.pendingShare = pendingShare
    // Counters like the catches: the furthest of either side, never the losing side's wipe.
    const shinyXP = Math.max(a?.shinyXP ?? 0, b?.shinyXP ?? 0)
    if (shinyXP > 0) merged.shinyXP = shinyXP
    const shinyBoosted = Math.max(a?.shinyBoosted ?? 0, b?.shinyBoosted ?? 0)
    if (shinyBoosted > 0) merged.shinyBoosted = shinyBoosted
    if (a?.shinyUnlocked || b?.shinyUnlocked) merged.shinyUnlocked = true
    if (a?.shinyRegistered || b?.shinyRegistered) merged.shinyRegistered = true
    if (a?.companionShiny || b?.companionShiny) merged.companionShiny = true
    // Registered first on either machine: the earlier moment.
    const stamps = [a?.registeredAt, b?.registeredAt].filter((t): t is number => t !== undefined)
    if (stamps.length > 0) merged.registeredAt = Math.min(...stamps)
    const nature = a?.nature ?? b?.nature
    if (nature !== undefined) merged.nature = nature
    out[id] = merged
  }
  return out
}

export interface MergeOptions {
  /**
   * Whose history continues **if** the saves forked — the player's answer to the first sync onto
   * a machine that already has a companion (`docs/sync.md` §7.1). Ignored when one save contains
   * the other: adopting the newer one loses nothing, and forcing the older would.
   */
  onFork?: 'local' | 'remote'
}

export function mergeSaves(
  local: CompanionState,
  remote: CompanionState,
  options: MergeOptions = {},
): MergeResult {
  const localCovers = covers(local.revision, remote.revision)
  const remoteCovers = covers(remote.revision, local.revision)
  // A save from before sync has no counters, and "every counter covers nothing" is vacuously
  // true — so a tracked save would swallow it whole, companion, bag and usage, as if the import
  // had been a no-op. Having no history is not having seen the other's: that is a fork.
  const untracked = Object.keys(local.revision).length === 0 || Object.keys(remote.revision).length === 0

  let outcome: MergeOutcome
  let narrative: 'local' | 'remote'
  if (!untracked && localCovers) {
    outcome = 'keptLocal'
    narrative = 'local'
  } else if (!untracked && remoteCovers) {
    outcome = 'adoptedRemote'
    narrative = 'remote'
  } else {
    outcome = 'forked'
    narrative = options.onFork ?? forkWinner(local, remote, untracked)
  }

  const base = narrative === 'local' ? local : remote
  const other = narrative === 'local' ? remote : local

  let state: CompanionState = { ...base }

  // This machine's ledger and preferences, whichever history won.
  state.installBaselineSet = local.installBaselineSet
  state.lastDate = local.lastDate
  if (local.claimedTodayTokensByProvider !== undefined) {
    state.claimedTodayTokensByProvider = { ...local.claimedTodayTokensByProvider }
  } else {
    delete state.claimedTodayTokensByProvider
  }
  state.language = local.language
  // The trainer is the player's choice, not the machine's, so it follows the winning history —
  // and when that history never chose one, the other side's choice, so both machines settle on
  // the same trainer rather than each keeping its own.
  if (base.trainerID === undefined && other.trainerID !== undefined) state.trainerID = other.trainerID
  // Challenges: the narrative winner's board. On the same day and week, each challenge keeps the
  // furthest progress of either side but the winner's paid flag — the reward lives in the winner's
  // `earnedTokens`, so one only the loser completed is paid on the next settle, not lost.
  const lb = local.challenges
  const rb = remote.challenges
  if (lb !== undefined && rb !== undefined && lb.day === rb.day && lb.week === rb.week) {
    const winner = state.challenges ?? lb
    const other = winner === lb ? rb : lb
    state.challenges = {
      ...winner,
      items: winner.items.map((c) => {
        const twin = other.items.find((o) => o.id === c.id)
        return twin === undefined ? c : { ...c, progress: Math.max(c.progress, twin.progress) }
      }),
    }
  }
  // Paid challenges are the winner's, with the winner's `earnedTokens` they were paid into. A
  // union brought over the loser's "paid" while its tokens stayed behind, and the next settle
  // marked the challenge done with nothing in the wallet (code review 9.12 #7); left out, the
  // settle pays it — once, into the merged wallet. `state` is the winner's copy, list and all.
  // Medals only grow: one celebrated on either side stays celebrated, never announced twice.
  const medals = new Set([...(local.medals ?? []), ...(remote.medals ?? [])])
  if (medals.size > 0) state.medals = [...medals]
  if (local.medalsSeeded === true || remote.medalsSeeded === true) state.medalsSeeded = true
  // A setting, like the language: this machine's choice.
  if (local.keepCompletedCompanion === true) state.keepCompletedCompanion = true
  else delete state.keepCompletedCompanion
  if (local.lastEncounterToastAt !== undefined) state.lastEncounterToastAt = local.lastEncounterToastAt
  else delete state.lastEncounterToastAt
  // Whether this machine has already announced a full queue is about this machine's
  // notifications, not about the game. The finds and the legendary trail, by contrast, are
  // narrative: they come whole from the winner with the queue they belong to — a union would bring
  // back a legendary already tracked and caught on the other side.
  state.queueFullArmed = local.queueFullArmed

  // Growth the winning history has not seen. Credited the way a scan credits it, so it feeds the
  // egg or the current stage and the encounter meter alike; evolution follows on the next fold.
  const credited = unseenTokens(base, other)
  if (credited > 0) {
    state = creditDelta(state, credited)
    state.encounterUsage = addEncounterUsage(state.encounterUsage, credited, queuedCount(state))
  }
  state.usedByDevice = perKeyMax(base.usedByDevice, other.usedByDevice)
  state.revision = perKeyMax(base.revision, other.revision)

  // Collections: union, whichever side won.
  const dexIDs = new Set(state.dex.map((entry) => entry.id))
  state.dex = [...state.dex, ...other.dex.filter((entry) => !dexIDs.has(entry.id))]
  state.collectedFinals = [...new Set([...state.collectedFinals, ...other.collectedFinals])]
  state.candyGrantTier = mergedGrantTier(base.candyGrantTier, other.candyGrantTier)
  state.candyFeatureSeeded = base.candyFeatureSeeded || other.candyFeatureSeeded
  // The registry. The Pokédex states are flags and flags only ever turn on, so they are unioned:
  // a species the losing side registered stays registered. The experience itself is history —
  // RNG-free, but the tokens behind it are the same tokens the credit above already paid to the
  // winner's companion, so taking the loser's xp as well would count them twice. It comes from
  // the winner; what the loser put into a species the winner never had is lost with the rest of
  // its history, and that species is simply unlocked at zero.
  state.earnedTokens = base.earnedTokens
  // Fail-closed: the winner's count (a maximum would resurrect eggs already incubated) and the
  // most recent grant day, so two machines never both grant today's egg.
  const grantDays = [base.eggStock.lastGrantDay, other.eggStock.lastGrantDay].filter(isDayKey).sort()
  const lastGrantDay = grantDays[grantDays.length - 1]
  state.eggStock = { count: base.eggStock.count, ...(lastGrantDay === undefined ? {} : { lastGrantDay }) }
  // From `state`, not `base`: the credit above already moved the companion's bar.
  state.species = mergeRegistries(state.species, other.species)
  state.encountersSeen = Math.max(base.encountersSeen, other.encountersSeen)
  state.accrualDays = [...new Set([...base.accrualDays, ...other.accrualDays])]
    .sort()
    .slice(-StreakBalance.windowDays)
  const awardDates = [base.lastStreakAwardDate, other.lastStreakAwardDate].filter(isDayKey).sort()
  const lastAward = awardDates[awardDates.length - 1]
  if (lastAward !== undefined) state.lastStreakAwardDate = lastAward

  // A legendary waiting in the losing queue was an entitlement someone earned; dropping it
  // with the rest of that queue would revoke it, so it is owed again (§2.4). The loser's
  // entitlements are its debt *plus* what it already delivered, compared against the winner's
  // debt as one figure: an entitlement owed before the fork shows up on one side as "owed" and on
  // the other as "delivered", and adding the two would pay it twice. Without per-entitlement ids
  // (§2.3) one direction must be chosen: a legendary the loser earned *after* the fork, while the
  // winner owes one of its own, is under-paid by one rather than any entitlement paid twice.
  if (outcome === 'forked') {
    const waiting = new Set(state.wild.map((encounter) => encounter.id))
    const dropped = other.wild.filter((e) => e.rarity === 'legendary' && !waiting.has(e.id)).length
    state.owedLegendaryEncounters = Math.min(
      LegendaryBalance.maxOwed,
      Math.max(state.owedLegendaryEncounters, other.owedLegendaryEncounters + dropped),
    )
  }

  // Milestones: a high-water mark, merged together with the total it is derived from. Every
  // milestone the merged total crosses beyond it is paid, not just one — each was crossed by
  // work actually observed, only on another machine (§2.2).
  state.milestonesAwarded = Math.max(base.milestonesAwarded, other.milestonesAwarded)
  const reached = Math.floor(Math.max(0, state.usedSinceInstall) / MilestoneBalance.tokens)
  if (reached > state.milestonesAwarded) {
    state = grantLegendaryEncounter(state, reached - state.milestonesAwarded)
    state.milestonesAwarded = reached
  }

  const merged = sanitized(state)
  return {
    state: merged,
    outcome,
    narrative,
    creditedTokens: credited,
    dexAdded: merged.dex.length - local.dex.length,
  }
}

/**
 * Whether `after` differs from `before` in its **history**, not merely in what it accrued.
 *
 * Accrual — the ledger, the token totals, the egg's and the companion's meters, species
 * experience, the encounter meter, active days, challenge progress — is reconciled by the merge
 * itself from `usedByDevice`: the tokens one side has not seen are credited to the other, whichever
 * history continues. Counting it as a revision would make two machines that are merely both in use
 * fork on every round, and a fork discards the losing side's catches and purchases for nothing.
 * Everything else — a hatch, an evolution, a spawn, a catch, a purchase, a daily egg, a payout —
 * is history, and is counted.
 */
export function changesHistory(before: CompanionState, after: CompanionState): boolean {
  return historyKey(before) !== historyKey(after)
}

/** Top-level fields that only accrue (see `changesHistory`), plus the counters themselves. */
const ACCRUAL_FIELDS = [
  'usedSinceInstall',
  'usedByDevice',
  'claimedTodayTokensByProvider',
  'lastDate',
  'installBaselineSet',
  'accrualDays',
  'eggUsage',
  'encounterUsage',
  'queueFullArmed',
  'lastEncounterToastAt',
  'revision',
] as const satisfies readonly (keyof CompanionState)[]

/** The save with everything that only accrues taken out, as canonical text. */
function historyKey(state: CompanionState): string {
  const rest: Partial<CompanionState> = { ...state }
  for (const key of ACCRUAL_FIELDS) delete rest[key]
  if (state.active !== undefined) rest.active = { ...state.active, usedAtStage: 0 }
  rest.species = Object.fromEntries(
    Object.entries(state.species).map(([id, progress]) => [id, { ...progress, xp: 0, shinyXP: 0 }]),
  )
  if (state.challenges !== undefined) {
    rest.challenges = {
      ...state.challenges,
      items: state.challenges.items.map((c) => ({ ...c, progress: 0 })),
    }
  }
  return canonicalJSON(rest)
}

/** JSON with object keys sorted, so the same content always reads the same. */
function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  )
}

/** Records one committed change by `device`. Called on every write that changed the save. */
export function withRevision(state: CompanionState, device: string): CompanionState {
  return { ...state, revision: { ...state.revision, [device]: (state.revision[device] ?? 0) + 1 } }
}
