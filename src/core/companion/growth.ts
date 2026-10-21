/**
 * Growth, evolution and graduation.
 *
 * Kept pure: it takes state in and returns state plus the events that happened, so the
 * caller owns persistence, notifications and celebrations. Interleaving all of that with the
 * rules is what leaves branches with no reachable test.
 */

import {
  type EvoLine,
  type EvoNode,
  type MonState,
  PokemonBalance,
  PokemonOdds,
  type SpeciesProgress,
  currentSpeciesID,
  evoFinalIDs,
  evoNodeWithID,
  freshSpeciesProgress,
} from './model.js'
import { meterStart, obtainShiny, shareXP, shinyTarget } from './registry.js'

/** Injectable randomness. Returns a non-negative integer. */
export type RNG = () => number

export type GrowthEvent =
  | { kind: 'evolved'; toSpeciesID: number }
  | { kind: 'graduated' }
  /** The species on stage filled its shiny bar: it is registered shiny, and the companion is too. */
  | { kind: 'shinyRegistered'; speciesID: number }
  /**
   * The disguise dropped. It carries the species that was being impersonated because the
   * state no longer holds it the instant the reveal lands, and the caller needs that name
   * for the toast ("It was Ditto all along, disguised as Caterpie!").
   */
  | { kind: 'dittoRevealed'; disguisedAsSpeciesID: number }

export interface GrowthResult {
  mon: MonState
  events: GrowthEvent[]
  /** Set when the line graduated: the caller records it in the Pokédex and starts a new egg. */
  graduated: boolean
  notes: string[]
  /** The registry after this delta: the current species filled, evolved-from species registered. */
  species: Record<number, SpeciesProgress>
}

/**
 * Prefers a branch leading to a final form not yet unlocked, so repeat lines diversify.
 * Falls back to the whole set once everything downstream is already owned.
 */
export function pickPlannedChild(node: EvoNode, unlocked: ReadonlySet<number>, rng: RNG): EvoNode {
  const fresh = node.children.filter((child) => evoFinalIDs(child).some((id) => !unlocked.has(id)))
  const pool = fresh.length > 0 ? fresh : node.children
  return pool[rng() % pool.length]!
}

export function makeEvolutionPlan(root: EvoNode, unlocked: ReadonlySet<number>, rng: RNG): number[] {
  const plan = [root.speciesID]
  let node = root
  while (node.children.length > 0) {
    const next = pickPlannedChild(node, unlocked, rng)
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
  unlocked: ReadonlySet<number>,
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
    : [...realized.path, ...makeEvolutionPlan(realized.lastNode, unlocked, rng).slice(1)]

  return {
    ...saved,
    pathIDs: realized.path,
    plannedPathIDs: plan,
    stageIndex: realized.path.length - 1,
    totalForms: plan.length,
  }
}

/**
 * Drops the disguise: the companion *is* the Ditto it always was.
 *
 * Ditto has no evolutions, so the line collapses to a single form — and that is what keeps the
 * economy honest. `totalForms = 1` makes `phaseThreshold` return the whole graduation total,
 * while `usedAtStage` carries over untouched, so a revealed Ditto graduates for exactly what
 * the line it was impersonating would have cost. Graduating on the spot would instead hand out
 * a Pokédex entry at a third of the price.
 *
 * `rarity` is deliberately NOT changed to Ditto's own: it is what every threshold this
 * Pokémon has already paid was computed against, and rewriting it mid-raise moves the
 * goalposts in whichever direction the roll happened to fall.
 *
 * `baseID` becomes Ditto's. That is load-bearing twice over: it is what makes the caller
 * refetch the evolution line (the disguise line does not contain species 132), and it is what
 * keeps the disguise species out of `collectedFinals` at graduation — that line was never
 * actually raised, so it must not bias future branch choices.
 */
export function revealedDitto(mon: MonState): MonState {
  return {
    ...mon,
    baseID: PokemonOdds.dittoSpeciesID,
    pathIDs: [PokemonOdds.dittoSpeciesID],
    plannedPathIDs: [PokemonOdds.dittoSpeciesID],
    stageIndex: 0,
    totalForms: 1,
    dittoRevealed: true,
  }
}

/** The ids from the root down to `speciesID`, or undefined when the tree does not hold it. */
export function pathToSpecies(root: EvoNode, speciesID: number): number[] | undefined {
  if (root.speciesID === speciesID) return [root.speciesID]
  for (const child of root.children) {
    const below = pathToSpecies(child, speciesID)
    if (below !== undefined) return [root.speciesID, ...below]
  }
  return undefined
}

/** Whether anything below `node` is still unregistered: what keeps a registered species evolving. */
function subtreeHasUnregistered(node: EvoNode, species: Record<number, SpeciesProgress>): boolean {
  return node.children.some((child) => branchHasUnregistered(child, species))
}

/** `node` itself or anything below it is still unregistered. */
function branchHasUnregistered(node: EvoNode, species: Record<number, SpeciesProgress>): boolean {
  return !(species[node.speciesID]?.registered ?? false) || subtreeHasUnregistered(node, species)
}

/**
 * The companion has nothing left to fill: its form is registered, its meter full, and nothing
 * below it in the line is unregistered. What `CompanionStore` moves on from, unless the player
 * keeps it (`keepCompletedCompanion`). A disguised Ditto is never done — its reveal is pending.
 */
export function companionIsDone(
  mon: MonState,
  line: EvoLine,
  species: Record<number, SpeciesProgress>,
): boolean {
  if (mon.dittoDisguise !== undefined && !mon.dittoRevealed) return false
  const id = currentSpeciesID(mon)
  if (species[id]?.registered !== true) return false
  if (mon.usedAtStage < PokemonBalance.phaseThreshold(mon.rarity, mon.totalForms, mon.stageIndex))
    return false
  const node = evoNodeWithID(line.tree, id)
  return node !== undefined && !subtreeHasUnregistered(node, species)
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
  unlocked: ReadonlySet<number>,
  rng: RNG,
  speciesIn: Record<number, SpeciesProgress> = {},
): GrowthResult {
  let current: MonState = { ...mon, usedAtStage: mon.usedAtStage + delta }
  const events: GrowthEvent[] = []
  const notes: string[] = []

  // The registry mirrors the meter: the same delta fills the current species' bar, raw. Only
  // once the line is known does the bar get its threshold (below), and an evolution settles the
  // split — the species evolved from is capped at its threshold and registered, the overflow
  // goes to the species evolved into. Both numbers are therefore always one story.
  // Copied on first write only: the fold settles with a zero delta on every refresh, and a
  // registry of hundreds of species must not be spread for nothing.
  let species = speciesIn
  const entry = (id: number): SpeciesProgress => species[id] ?? freshSpeciesProgress()
  const put = (id: number, next: SpeciesProgress): void => {
    if (species === speciesIn) species = { ...speciesIn }
    species[id] = next
  }
  const credit = (id: number, amount: number): void => {
    if (amount <= 0 && entry(id).unlocked) return
    const p = entry(id)
    put(id, { ...p, xp: p.xp + Math.max(0, amount), unlocked: true })
  }
  const fix = (id: number, of: MonState): void => {
    const p = entry(id)
    const threshold = PokemonBalance.phaseThreshold(of.rarity, of.totalForms, of.stageIndex)
    if (
      p.unlocked &&
      p.threshold === threshold &&
      p.lineRarity === of.rarity &&
      p.baseID === of.baseID &&
      p.stageIndex === of.stageIndex &&
      p.totalForms === of.totalForms &&
      p.pendingShare === undefined
    ) {
      return
    }
    const fixed: SpeciesProgress = {
      ...p,
      unlocked: true,
      threshold,
      lineRarity: of.rarity,
      baseID: of.baseID,
      stageIndex: of.stageIndex,
      totalForms: of.totalForms,
    }
    // A share owed by a catch made before the line was known becomes experience now that there
    // is a threshold to take it from.
    if (p.pendingShare !== undefined) {
      fixed.xp = Math.max(p.xp, Math.min(threshold, p.xp + shareXP(p.pendingShare, threshold)))
      delete fixed.pendingShare
    }
    put(id, fixed)
  }
  /**
   * A registered species' surplus goes to its shiny bar, capped at `shinyTarget`. Filling it
   * registers the shiny and dresses the companion. Nothing moves without the line's rarity (no
   * requirement to measure against) or once the shiny is registered.
   */
  const shinyCredit = (id: number, amount: number): void => {
    const p = entry(id)
    if (amount <= 0 || p.shinyRegistered === true || p.lineRarity === undefined) return
    const target = shinyTarget(p.lineRarity)
    const shinyXP = Math.min(target, (p.shinyXP ?? 0) + amount)
    if (shinyXP < target) {
      put(id, { ...p, shinyXP })
      return
    }
    put(id, { ...p, shinyXP, shinyRegistered: true, shinyUnlocked: true })
    current = { ...current, isShiny: true }
    events.push({ kind: 'shinyRegistered', speciesID: id })
  }
  const register = (id: number, threshold: number, overflow: number): void => {
    const p = entry(id)
    put(id, { ...p, xp: Math.max(threshold, p.xp - overflow), registered: true, unlocked: true })
  }
  /**
   * Fixes the species the companion is on, then lifts the meter to where its bar already is (a
   * catch's share, an earlier life): `meterStart`, the rule `setCompanion` follows. Runs on
   * every form the companion lands on — the first and each one evolved into. Not for a disguised
   * Ditto (the disguise species' bar is another Pokémon's) nor once registered (the meter is
   * pinned there).
   */
  const settle = (of: MonState): MonState => {
    const id = currentSpeciesID(of)
    fix(id, of)
    const p = entry(id)
    if (p.registered || p.threshold === undefined) return of
    if (of.dittoDisguise !== undefined && !of.dittoRevealed) return of
    const start = meterStart(p, p.threshold)
    return start > of.usedAtStage ? { ...of, usedAtStage: start } : of
  }
  credit(currentSpeciesID(mon), delta)

  if (line === undefined) return { mon: current, events, graduated: false, notes, species }
  current = settle(current)

  for (let steps = 0; steps < MAX_EVOLUTION_STEPS; steps++) {
    const threshold = PokemonBalance.phaseThreshold(
      current.rarity,
      current.totalForms,
      current.stageIndex,
    )
    if (current.usedAtStage < threshold) break

    // The reveal comes **before** anything that reads the loaded tree. Two reasons, and both
    // have teeth: asset normalisation can turn a disguised multi-form line into a leaf, so a
    // later check would graduate the disguise species into the Pokédex by mistake; and the
    // revealed Ditto is not in the disguise line's tree at all, so a node lookup placed first
    // would stall it here for ever.
    if (current.dittoDisguise !== undefined && !current.dittoRevealed) {
      const disguisedAsSpeciesID = currentSpeciesID(current)
      // What *this life* earned was Ditto's all along: exactly `usedAtStage` of it, which is
      // what the meter accrued since the hatch. It moves to Ditto; whatever the disguise species
      // had from a real life of its own stays where it was.
      const moved = Math.min(entry(disguisedAsSpeciesID).xp, current.usedAtStage)
      const prior = entry(disguisedAsSpeciesID)
      // The hatch unlocked the disguise species; if nothing else ever did — no catch, no bar of
      // its own — the reveal takes that unlock back, or the first real one caught would be paid
      // as a duplicate of a Pokémon the player never had.
      const left = prior.xp - moved
      const onlyByDisguise = left === 0 && prior.caught === 0 && !prior.registered
      put(disguisedAsSpeciesID, { ...prior, xp: left, unlocked: prior.unlocked && !onlyByDisguise })
      current = revealedDitto(current)
      credit(PokemonOdds.dittoSpeciesID, moved)
      fix(PokemonOdds.dittoSpeciesID, current)
      // A shiny Ditto hatched in disguise registers its shiny now, as Ditto — the hatch held it
      // back so the disguise species would not get a shiny it never had.
      if (current.isShiny) put(PokemonOdds.dittoSpeciesID, obtainShiny(entry(PokemonOdds.dittoSpeciesID)))
      events.push({ kind: 'dittoRevealed', disguisedAsSpeciesID })
      // One reveal per pass: `line` still describes the disguise, so there is nothing here
      // that could legitimately evolve or graduate a Ditto. Growth resumes once the caller
      // has loaded Ditto's own line.
      break
    }

    const node = evoNodeWithID(line.tree, currentSpeciesID(current))
    if (node === undefined) break

    // A registered species stays where it is unless a branch below it still has something to
    // register: the bar reads full, the surplus is the shiny bar's (phase 5), and `graduated`
    // fires exactly once — when the final form first registers — for the celebration and the
    // Pokédex entry, never again on the next refresh.
    const here = currentSpeciesID(current)
    const wasRegistered = entry(here).registered
    if (node.children.length === 0) {
      const surplus = current.usedAtStage - threshold
      register(here, threshold, surplus)
      current = { ...current, usedAtStage: threshold }
      shinyCredit(here, surplus)
      if (wasRegistered) break
      events.push({ kind: 'graduated' })
      return { mon: current, events, graduated: true, notes, species }
    }
    if (wasRegistered && !subtreeHasUnregistered(node, species)) {
      const surplus = current.usedAtStage - threshold
      const p = entry(here)
      put(here, { ...p, xp: Math.max(threshold, p.xp - surplus) })
      current = { ...current, usedAtStage: threshold }
      shinyCredit(here, surplus)
      break
    }

    const nextIndex = current.stageIndex + 1
    const plannedID = current.plannedPathIDs[nextIndex]
    const planned =
      plannedID === undefined ? undefined : node.children.find((c) => c.speciesID === plannedID)

    // A registered species evolves only to reach something unregistered, so a plan pointing at
    // a branch that is all registered is redirected like an invalid one: following it would
    // park the companion at a dead end while a sibling branch still waits.
    const candidates = wasRegistered
      ? { ...node, children: node.children.filter((c) => branchHasUnregistered(c, species)) }
      : node

    let next: EvoNode
    if (planned !== undefined && candidates.children.includes(planned)) {
      next = planned
    } else {
      next = pickPlannedChild(candidates, unlocked, rng)
      const fallbackRoute = [node.speciesID, ...makeEvolutionPlan(next, unlocked, rng)]
      const repaired = repairedPlan(current.pathIDs, current.stageIndex, fallbackRoute)
      current = { ...current, plannedPathIDs: repaired, totalForms: repaired.length }
      notes.push(`evolve: repaired invalid planned path for base ${current.baseID}`)
    }

    const overflow = current.usedAtStage - threshold
    register(currentSpeciesID(current), threshold, overflow)
    // A new form is not the one the player chose by hand: the move-on rule applies to it again.
    delete current.chosenWhenRegistered
    current = {
      ...current,
      pathIDs: [...current.pathIDs.slice(0, current.stageIndex + 1), next.speciesID],
      stageIndex: current.stageIndex + 1,
      // Overflow carries into the new form rather than being discarded.
      usedAtStage: overflow,
    }
    credit(next.speciesID, overflow)
    current = settle(current)
    events.push({ kind: 'evolved', toSpeciesID: next.speciesID })
  }

  return { mon: current, events, graduated: false, notes, species }
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
