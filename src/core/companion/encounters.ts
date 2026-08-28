/**
 * Wild encounters: how they appear, and how a thrown ball resolves.
 *
 * Pure — no network, no clock, no persistence. Everything that needs the base species index or
 * the disk lives in `store.ts`; everything decided by a rule or a die lives here, so the whole
 * game design is unit-testable in one file.
 *
 * Two rules in here are load-bearing and easy to "simplify" wrongly:
 *
 * 1. **The accumulator carries its remainder.** `payForEncounter` subtracts the threshold, it
 *    never resets to zero. At 2.5M a spawn, resetting would throw away most of a busy day.
 * 2. **A wild catch never touches `collectedFinals`.** That set holds completed `base:final`
 *    lines and steers evolution-branch diversity in `growth.pickPlannedChild`. A single caught
 *    species is not a completed line, and adding it would bias every future hatch away from a
 *    branch that was never actually raised.
 */

import {
  type BallKind,
  type CompanionState,
  type DexEntry,
  Pokeball,
  type Rarity,
  type WildEncounter,
  sortRank,
} from './model.js'
import type { RNG } from './growth.js'

// MARK: - Balance

/**
 * Encounter pacing.
 *
 * `threshold` is half an egg, so you meet roughly two wild Pokémon per companion raised.
 * `docs/ideas-from-tkm.md` first proposed one per 1M tokens; at that rate a Rare Candy's worth
 * of spend would produce ~500 encounters, which drowns the tab rather than filling it.
 *
 * `firstThreshold` exists for the problem this feature was built for: the first ~5M tokens used
 * to pass with nothing visible happening (`docs/todos.md` #7). One cheap first encounter puts
 * something on screen inside a new user's first session.
 */
export const EncounterBalance = {
  threshold: 2_500_000,
  firstThreshold: 500_000,
  /** The queue is persisted and drawn as a list; unbounded growth bloats both. */
  maxQueue: 12,
} as const

/** Cheaper for the very first encounter, steady afterwards. */
export function encounterThresholdFor(encountersSeen: number): number {
  return encountersSeen === 0 ? EncounterBalance.firstThreshold : EncounterBalance.threshold
}

/**
 * Ceiling on the accumulator.
 *
 * A dev scenario granting 1.5B would otherwise owe ~600 encounters and keep minting them out of
 * a single injection for ever. Clamping on the way *in* bounds `owedEncounters` structurally,
 * and it puts the discarded surplus at the one place it is easy to see rather than hiding it in
 * a post-hoc fixup on the loop.
 */
const USAGE_CEILING = EncounterBalance.threshold * (EncounterBalance.maxQueue + 1)

/** Adds a token delta to the accumulator. Negative deltas are ignored, not subtracted. */
export function addEncounterUsage(encounterUsage: number, delta: number): number {
  return Math.min(encounterUsage + Math.max(0, delta), USAGE_CEILING)
}

/** How many encounters the accumulated usage has paid for but not yet received. */
export function owedEncounters(encounterUsage: number, encountersSeen: number): number {
  let usage = Math.min(encounterUsage, USAGE_CEILING)
  let owed = 0
  while (usage >= encounterThresholdFor(encountersSeen + owed)) {
    usage -= encounterThresholdFor(encountersSeen + owed)
    owed += 1
  }
  return owed
}

/**
 * Pays for one spawn.
 *
 * Called **only after the encounter actually materialised**, which is what makes an offline
 * spell defer encounters instead of losing them: the usage stays banked until there is a
 * Pokémon to show for it. It subtracts one threshold rather than resetting — at 2.5M a spawn,
 * resetting would throw away most of a busy day.
 */
export function payForEncounter(
  encounterUsage: number,
  encountersSeen: number,
): { encounterUsage: number; encountersSeen: number } {
  return {
    encounterUsage: Math.max(0, encounterUsage - encounterThresholdFor(encountersSeen)),
    encountersSeen: encountersSeen + 1,
  }
}

/** Tokens still to go before the next encounter, for the tab's empty state. */
export function tokensToNextEncounter(encounterUsage: number, encountersSeen: number): number {
  return Math.max(0, encounterThresholdFor(encountersSeen) - encounterUsage)
}

/**
 * Appends an encounter, making room when the queue is full.
 *
 * Room is made by dropping the **lowest rarity, then the oldest** — considering the newcomer
 * itself, so a queue of legendaries is not emptied one Caterpie at a time. Plain FIFO would
 * drop the legendary that appeared first, which is the one outcome a player would call a bug.
 */
export function enqueueEncounter(
  queue: readonly WildEncounter[],
  incoming: WildEncounter,
): WildEncounter[] {
  const all = [...queue, incoming]
  if (all.length <= EncounterBalance.maxQueue) return all

  let dropIndex = 0
  for (let i = 1; i < all.length; i++) {
    const candidate = all[i]!
    const worst = all[dropIndex]!
    const byRarity = sortRank(candidate.rarity) - sortRank(worst.rarity)
    if (byRarity < 0 || (byRarity === 0 && candidate.appearedAt < worst.appearedAt)) dropIndex = i
  }

  return all.filter((_, i) => i !== dropIndex)
}

// MARK: - Capture

/**
 * Difficulty knobs on the catch, tuned after playtesting the first cut.
 *
 * `difficulty` scales every capture rate down before the ball multiplies it. `maxCatchValue`
 * caps what any ball short of the Master can reach: at the raw formula a 235+ species was a
 * guaranteed, wobble-less catch with the cheapest ball, which made most commons a formality —
 * the cap keeps the best non-Master throw at ~84%, so every ball can wobble out and the
 * guaranteed catch stays what the Master Ball is for.
 *
 * Resulting odds per Poké Ball throw: Caterpie-class 84%, Magnemite-class ~71%, uncommon ~50%,
 * rare ~24% (41% with an Ultra), legendary ~3% — see `test/wild-encounters.test.ts`, which
 * pins these against the formula.
 */
export const Capture = {
  difficulty: 0.85,
  maxCatchValue: 200,
} as const

/**
 * The catch value `a`: the species capture rate scaled by difficulty and the ball, capped.
 *
 * The mainline formula also weighs current HP and status, neither of which exists here — there
 * is no battle, only a throw. That is a deliberate simplification, not an omission: `a` stays a
 * single expression. The Master Ball's `Infinity` multiplier is the one path allowed past the
 * cap, collapsing to 255 — the guaranteed catch.
 */
export function catchValue(captureRate: number, ball: BallKind): number {
  const scaled = Math.round(captureRate * Capture.difficulty * Pokeball.multiplier[ball])
  const ceiling = ball === 'masterBall' ? 255 : Capture.maxCatchValue
  return Math.max(1, Math.min(ceiling, scaled))
}

/** Rolls per throw, as in the mainline games: four wobbles, all four must pass. */
export const SHAKE_ROLLS = 4
const SHAKE_RANGE = 65_536

/**
 * Probability threshold `b` for one wobble, on the Gen-IV curve. At `a = 255` it saturates the
 * range, which is what makes a full-rate species an automatic catch.
 */
export function shakeThreshold(a: number): number {
  if (a >= 255) return SHAKE_RANGE
  return SHAKE_RANGE / Math.pow(255 / a, 0.1875)
}

/**
 * Probability that one throw of `ball` catches a species with this capture rate — the four
 * independent wobble rolls all passing. Shown on the ball rack so choosing a ball is a
 * decision, not a guess; computed from the same `catchValue`/`shakeThreshold` pair that
 * resolves the actual throw, so the odds shown are the odds rolled.
 */
export function catchChance(captureRate: number, ball: BallKind): number {
  const a = catchValue(captureRate, ball)
  if (a >= 255) return 1
  return Math.pow(shakeThreshold(a) / SHAKE_RANGE, SHAKE_ROLLS)
}

export interface ThrowRoll {
  caught: boolean
  shakes: number
}

/**
 * Resolves one throw into a wobble count. The count is what the animation plays, so it is part
 * of the result rather than something the UI re-derives.
 */
export function resolveThrow(encounter: WildEncounter, ball: BallKind, rng: RNG): ThrowRoll {
  const a = catchValue(encounter.captureRate, ball)
  if (a >= 255) return { caught: true, shakes: SHAKE_ROLLS }

  const b = shakeThreshold(a)
  let shakes = 0
  for (let roll = 0; roll < SHAKE_ROLLS; roll++) {
    if (rng() % SHAKE_RANGE >= b) break
    shakes += 1
  }
  return { caught: shakes === SHAKE_ROLLS, shakes }
}

const FLEE_BASE = 0.12
const FLEE_PER_THROW = 0.08
const FLEE_CAP = 0.55

/** Extra skittishness by tier, so a legendary punishes a cheap ball twice. */
function fleeRarityBonus(rarity: Rarity): number {
  switch (rarity) {
    case 'legendary':
      return 0.18
    case 'rare':
      return 0.1
    default:
      return 0
  }
}

/**
 * Chance the Pokémon runs after a ball has failed, escalating with the throws it has already
 * survived. Capped, so a stubborn encounter stays winnable with a better ball.
 */
export function fleeChance(encounter: WildEncounter): number {
  const raw = FLEE_BASE + FLEE_PER_THROW * encounter.throws + fleeRarityBonus(encounter.rarity)
  return Math.min(FLEE_CAP, raw)
}

function rollFlee(encounter: WildEncounter, rng: RNG): boolean {
  return rng() % 1_000 < Math.round(fleeChance(encounter) * 1_000)
}

// MARK: - State transitions

export type ThrowOutcome =
  | { kind: 'caught'; shakes: number }
  /** The ball failed and the Pokémon is still there. */
  | { kind: 'broke'; shakes: number }
  | { kind: 'fled'; shakes: number }
  /** The bag was empty: nothing was spent. */
  | { kind: 'noBall' }
  /** A stale webview echoed an id the queue no longer holds. */
  | { kind: 'unknownEncounter' }

export interface ThrowResult {
  state: CompanionState
  outcome: ThrowOutcome
}

/** The Pokédex entry a wild catch files: one species, not a raised line. See rule 2 in the header. */
function wildDexEntry(encounter: WildEncounter, now: number): DexEntry {
  const entry: DexEntry = {
    id: `wild-${encounter.id}`,
    baseID: encounter.speciesID,
    finalID: encounter.speciesID,
    chainOrder: [encounter.speciesID],
    rarity: encounter.rarity,
    caughtAt: now,
    isShiny: encounter.isShiny,
    source: 'wild',
  }
  if (encounter.names !== undefined) entry.names = { [encounter.speciesID]: encounter.names }
  return entry
}

/**
 * Throws one ball at one encounter.
 *
 * Fails closed twice before touching anything: an id the queue does not hold is a stale webview,
 * and an empty bag must not spend a ball it does not have. Both return the state unchanged.
 */
export function throwBall(
  state: CompanionState,
  encounterID: string,
  ball: BallKind,
  rng: RNG,
  now: number,
): ThrowResult {
  const queue = state.wild ?? []
  const index = queue.findIndex((e) => e.id === encounterID)
  if (index === -1) return { state, outcome: { kind: 'unknownEncounter' } }

  const owned = state.inventory[ball] ?? 0
  if (owned <= 0) return { state, outcome: { kind: 'noBall' } }

  const encounter = queue[index]!
  const spent: CompanionState = {
    ...state,
    inventory: { ...state.inventory, [ball]: owned - 1 },
  }

  const roll = resolveThrow(encounter, ball, rng)
  if (roll.caught) {
    return {
      state: {
        ...spent,
        wild: queue.filter((_, i) => i !== index),
        dex: [...spent.dex, wildDexEntry(encounter, now)],
      },
      outcome: { kind: 'caught', shakes: roll.shakes },
    }
  }

  // The flee roll uses the throw that just failed, so pressure rises from the first miss.
  const survived: WildEncounter = { ...encounter, throws: encounter.throws + 1 }
  if (rollFlee(survived, rng)) {
    return {
      state: { ...spent, wild: queue.filter((_, i) => i !== index) },
      outcome: { kind: 'fled', shakes: roll.shakes },
    }
  }

  return {
    state: { ...spent, wild: queue.map((e, i) => (i === index ? survived : e)) },
    outcome: { kind: 'broke', shakes: roll.shakes },
  }
}

/** The player walks away. Discards the encounter and spends nothing. */
export function runFromEncounter(state: CompanionState, encounterID: string): CompanionState {
  const queue = state.wild ?? []
  if (!queue.some((e) => e.id === encounterID)) return state
  return { ...state, wild: queue.filter((e) => e.id !== encounterID) }
}
