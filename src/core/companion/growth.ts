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

/** Injectable randomness. Returns a non-negative integer. */
export type RNG = () => number

export type GrowthEvent =
  | { kind: 'evolved'; toSpeciesID: number }
  | { kind: 'graduated' }
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
      p.totalForms === of.totalForms
    ) {
      return
    }
    put(id, {
      ...p,
      unlocked: true,
      threshold,
      lineRarity: of.rarity,
      baseID: of.baseID,
      stageIndex: of.stageIndex,
      totalForms: of.totalForms,
    })
  }
  const register = (id: number, threshold: number, overflow: number): void => {
    const p = entry(id)
    put(id, { ...p, xp: Math.max(threshold, p.xp - overflow), registered: true, unlocked: true })
  }
  credit(currentSpeciesID(mon), delta)

  if (line === undefined) return { mon: current, events, graduated: false, notes, species }
  fix(currentSpeciesID(current), current)

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
      put(disguisedAsSpeciesID, { ...prior, xp: prior.xp - moved })
      current = revealedDitto(current)
      credit(PokemonOdds.dittoSpeciesID, moved)
      fix(PokemonOdds.dittoSpeciesID, current)
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
      register(here, threshold, current.usedAtStage - threshold)
      current = { ...current, usedAtStage: threshold }
      if (wasRegistered) break
      events.push({ kind: 'graduated' })
      return { mon: current, events, graduated: true, notes, species }
    }
    if (wasRegistered && !subtreeHasUnregistered(node, species)) {
      current = { ...current, usedAtStage: threshold }
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
    current = {
      ...current,
      pathIDs: [...current.pathIDs.slice(0, current.stageIndex + 1), next.speciesID],
      stageIndex: current.stageIndex + 1,
      // Overflow carries into the new form rather than being discarded.
      usedAtStage: overflow,
    }
    credit(next.speciesID, overflow)
    fix(next.speciesID, current)
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
