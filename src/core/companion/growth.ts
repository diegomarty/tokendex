/**
 * Growth, evolution and graduation, ported from `CompanionStore.applyUsage` and the
 * evolution-path helpers in `Core/CompanionStore.swift`.
 *
 * Kept pure: it takes state in and returns state plus the events that happened, so the
 * caller owns persistence, notifications and celebrations. The Swift version interleaved all
 * of that, which is why several of these branches had no reachable test.
 */

import {
  type EvoLine,
  type EvoNode,
  type MonState,
  PokemonBalance,
  currentSpeciesID,
  evoFinalIDs,
  evoNodeWithID,
} from './model.js'

/** Injectable randomness. Returns a non-negative integer. */
export type RNG = () => number

export type GrowthEvent =
  | { kind: 'evolved'; toSpeciesID: number }
  | { kind: 'graduated' }
  | { kind: 'dittoRevealPending' }

export interface GrowthResult {
  mon: MonState
  events: GrowthEvent[]
  /** Set when the line graduated: the caller records it in the Pokédex and starts a new egg. */
  graduated: boolean
  notes: string[]
}

/**
 * Prefers a branch leading to a final form not yet collected, so repeat lines diversify.
 * Falls back to the whole set once everything downstream is already owned.
 */
export function pickPlannedChild(
  node: EvoNode,
  baseID: number,
  collectedFinals: ReadonlySet<string>,
  rng: RNG,
): EvoNode {
  const fresh = node.children.filter((child) =>
    evoFinalIDs(child).some((id) => !collectedFinals.has(`${baseID}:${id}`)),
  )
  const pool = fresh.length > 0 ? fresh : node.children
  return pool[rng() % pool.length]!
}

export function makeEvolutionPlan(
  root: EvoNode,
  baseID: number,
  collectedFinals: ReadonlySet<string>,
  rng: RNG,
): number[] {
  const plan = [root.speciesID]
  let node = root
  while (node.children.length > 0) {
    const next = pickPlannedChild(node, baseID, collectedFinals, rng)
    plan.push(next.speciesID)
    node = next
  }
  return plan
}

/**
 * Splices a fallback route onto the part of the path already realised. Only joins when the
 * route actually starts where the realised path ends, otherwise the prefix stands alone —
 * grafting a mismatched route would invent an evolution that never happened.
 */
export function repairedPlan(
  realizedPath: number[],
  stageIndex: number,
  fallbackRoute: number[],
): number[] {
  if (realizedPath.length === 0) return fallbackRoute
  const currentIndex = Math.min(stageIndex, realizedPath.length - 1)
  const prefix = realizedPath.slice(0, currentIndex + 1)
  if (fallbackRoute[0] !== prefix[prefix.length - 1]) return prefix
  return [...prefix, ...fallbackRoute.slice(1)]
}

/** Longest id path that actually connects from the root, plus the last valid node. */
export function longestValidPath(ids: number[], root: EvoNode): { path: number[]; lastNode: EvoNode } {
  const path = [root.speciesID]
  let node = root
  if (ids[0] !== root.speciesID) return { path, lastNode: node }
  for (const id of ids.slice(1)) {
    const child = node.children.find((c) => c.speciesID === id)
    if (child === undefined) break
    path.push(id)
    node = child
  }
  return { path, lastNode: node }
}

/**
 * Reconciles a saved path and plan against the current asset tree. Only a *complete* plan is
 * reused, so restarting the app does not consume RNG and silently reroll someone's branch.
 */
export function normalizedEvolutionState(
  saved: MonState,
  root: EvoNode,
  collectedFinals: ReadonlySet<string>,
  rng: RNG,
): MonState {
  const realized = longestValidPath(saved.pathIDs, root)
  const candidate = longestValidPath(saved.plannedPathIDs, root)

  const startsWith = (a: number[], b: number[]) => b.every((v, i) => a[i] === v)
  const canReusePlan =
    candidate.path.length === saved.plannedPathIDs.length &&
    candidate.path.every((v, i) => v === saved.plannedPathIDs[i]) &&
    startsWith(candidate.path, realized.path) &&
    candidate.lastNode.children.length === 0

  const plan = canReusePlan
    ? candidate.path
    : [
        ...realized.path,
        ...makeEvolutionPlan(realized.lastNode, saved.baseID, collectedFinals, rng).slice(1),
      ]

  return {
    ...saved,
    pathIDs: realized.path,
    plannedPathIDs: plan,
    stageIndex: realized.path.length - 1,
    totalForms: plan.length,
  }
}

/** Guard against a malformed tree spinning the evolution loop forever. */
const MAX_EVOLUTION_STEPS = 50

/**
 * Applies a token delta to the active Pokémon, evolving or graduating at each threshold.
 *
 * Usage is credited **before** the line is consulted: dropping a delta because the line is
 * not loaded yet (just after restart, or offline) would lose it permanently, since the
 * per-provider ledger has already advanced. Only the evolution decision waits for the line.
 */
export function applyUsage(
  mon: MonState,
  delta: number,
  line: EvoLine | undefined,
  collectedFinals: ReadonlySet<string>,
  rng: RNG,
): GrowthResult {
  let current: MonState = { ...mon, usedAtStage: mon.usedAtStage + delta }
  const events: GrowthEvent[] = []
  const notes: string[] = []

  if (line === undefined) return { mon: current, events, graduated: false, notes }

  for (let steps = 0; steps < MAX_EVOLUTION_STEPS; steps++) {
    const threshold = PokemonBalance.phaseThreshold(current.rarity, current.totalForms, current.stageIndex)
    if (current.usedAtStage < threshold) break

    const node = evoNodeWithID(line.tree, currentSpeciesID(current))
    if (node === undefined) break

    // A disguised Ditto can become a leaf after asset normalisation even though it hatched
    // with several forms, so the reveal must come **before** the terminal graduation check —
    // otherwise the disguise species graduates into the Pokédex by mistake.
    if (current.dittoDisguise !== undefined && !current.dittoRevealed) {
      events.push({ kind: 'dittoRevealPending' })
      break
    }

    if (node.children.length === 0) {
      events.push({ kind: 'graduated' })
      return { mon: current, events, graduated: true, notes }
    }

    const nextIndex = current.stageIndex + 1
    const plannedID = current.plannedPathIDs[nextIndex]
    const planned =
      plannedID === undefined ? undefined : node.children.find((c) => c.speciesID === plannedID)

    let next: EvoNode
    if (planned !== undefined) {
      next = planned
    } else {
      next = pickPlannedChild(node, current.baseID, collectedFinals, rng)
      const fallbackRoute = [node.speciesID, ...makeEvolutionPlan(next, current.baseID, collectedFinals, rng)]
      const repaired = repairedPlan(current.pathIDs, current.stageIndex, fallbackRoute)
      current = { ...current, plannedPathIDs: repaired, totalForms: repaired.length }
      notes.push(`evolve: repaired invalid planned path for base ${current.baseID}`)
    }

    current = {
      ...current,
      pathIDs: [...current.pathIDs.slice(0, current.stageIndex + 1), next.speciesID],
      stageIndex: current.stageIndex + 1,
      // Overflow carries into the new form rather than being discarded.
      usedAtStage: current.usedAtStage - threshold,
    }
    events.push({ kind: 'evolved', toSpeciesID: next.speciesID })
  }

  return { mon: current, events, graduated: false, notes }
}

/** Tokens still needed to reach the next threshold. */
export function tokensToNext(mon: MonState): number {
  const threshold = PokemonBalance.phaseThreshold(mon.rarity, mon.totalForms, mon.stageIndex)
  return Math.max(0, threshold - mon.usedAtStage)
}

/** Progress through the current form, 0..1. */
export function stageProgress(mon: MonState): number {
  const threshold = PokemonBalance.phaseThreshold(mon.rarity, mon.totalForms, mon.stageIndex)
  if (threshold <= 0) return 1
  return Math.min(1, Math.max(0, mon.usedAtStage / threshold))
}
