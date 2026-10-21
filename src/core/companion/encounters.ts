/**
 * Wild encounters: how they appear, how they feel about you, and how each turn resolves.
 *
 * Pure — no network, no clock, no persistence. Everything that needs the base species index or
 * the disk lives in `store.ts`; everything decided by a rule or a die lives here, so the whole
 * game design is unit-testable in one file.
 *
 * Rules in here that are load-bearing and easy to "simplify" wrongly:
 *
 * 1. **The accumulator carries its remainder.** `payForEncounter` subtracts the threshold, it
 *    never resets to zero. Resetting would throw away most of a busy day.
 * 2. **A wild catch never touches `collectedFinals`.** That set holds completed `base:final`
 *    lines and steers evolution-branch diversity in `growth.pickPlannedChild`. A single caught
 *    species is not a completed line, and adding it would bias every future hatch away from a
 *    branch that was never actually raised.
 * 3. **The odds shown are the odds rolled.** Every probability the panel prints comes from the
 *    same function the die is compared against — `encounterCatchChance` for a ball,
 *    `fleePermille`/`attackPermille` for the reaction — and the reaction thresholds are integer
 *    permille, so "flee 16%" is exactly the number the roll is held to.
 * 4. **One reaction roll per turn, after the action.** A throw draws up to four wobbles and then
 *    exactly one reaction; a berry draws only the reaction. Tests pin individual draws, so the
 *    order is part of the contract.
 */

import {
  type BallKind,
  type BattleStat,
  type BerryKind,
  type CompanionState,
  type DexEntry,
  type ItemKind,
  type Mood,
  NATURE_STAT_EFFECT,
  Pokeball,
  type PokemonNature,
  type Rarity,
  type SpeciesProgress,
  type Temperament,
  type TrailEntry,
  type WildEncounter,
  type WildFind,
  sortRank,
} from './model.js'
import type { RNG } from './growth.js'
import { spendableBalance } from './ledger.js'
import { progressOf, registrationPercent, shareXP } from './registry.js'
import { EconomyBalance } from './economy.js'

// MARK: - Balance

/**
 * Encounter pacing.
 *
 * `threshold` is what one arrival costs. A quarter of arrivals are item finds rather than
 * Pokémon (`findShare`, in permille), so Pokémon still come about once per 2.7M tokens — the pace
 * the game was tuned at — and the finds are the intermediate reward on top.
 *
 * `firstThreshold` exists for the problem this feature was built for: the first ~5M tokens used
 * to pass with nothing visible happening. One cheap first encounter puts something on screen
 * inside a new user's first session, and it is always a Pokémon (see `spawnKind`).
 *
 * `maxQueue` counts Pokémon **and** finds (`queuedCount`). At 12 an active user's queue sat full
 * all day and froze accrual; at 30 expiry, not the cap, is what normally bounds it.
 */
export const EncounterBalance = {
  threshold: 2_000_000,
  firstThreshold: 500_000,
  /** The queue is persisted and drawn as a list; unbounded growth bloats both. */
  maxQueue: 30,
  findShare: 250,
} as const

/**
 * The ceiling on guaranteed legendaries owed and not yet delivered.
 *
 * Its own constant rather than `maxQueue`: it used to borrow the queue's size, so raising the
 * queue would silently have raised how many legendaries a buggy trigger (or an imported save)
 * could bank. Twelve is still far more than the triggers can legitimately owe at once.
 */
export const LegendaryBalance = {
  maxOwed: 12,
} as const

/**
 * When a *guaranteed legendary* encounter is earned by using the tools over time.
 *
 * Two rules, one award. The consecutive rule is what fires for someone who codes every day;
 * the 3-of-7 rule catches someone who skips a day — and since three consecutive days are
 * always three days inside seven, the first is strictly subsumed by the second. That is
 * deliberate, and it is why `days` is not evaluated twice: a separate consecutive check could
 * never fire on its own, so it would be dead code pretending to be a rule.
 *
 * Because they overlap, they share one guard: at most one streak legendary per rolling
 * `windowDays`, whichever rule got there. Awarding per rule would hand out two legendaries for
 * the same week's work.
 */
export const StreakBalance = {
  /** Days with real accrual that earn a legendary. */
  days: 3,
  /**
   * The rolling window those days are counted in, and the cooldown between awards. Seven days
   * so a working week with a day off still qualifies, and so a daily user earns at most one a
   * week (~52/year) rather than one every three days.
   */
  windowDays: 7,
} as const

/**
 * Lifetime-usage milestones that earn a guaranteed legendary.
 *
 * `tokens` is picked against measured burn rather than taste: the reference corpus ran 561M
 * tokens in 118 hours (~4.8M/h, so ~190M across a 40-hour week). At 1B that is one legendary
 * every ~5.3 weeks — ~10 a year — which sits alongside the streak's ~52 for a combined ~1.2 a
 * week.
 *
 * Crossing several multiples in one fold awards **one**, never one per multiple — see
 * `applyLegendaryTriggers`. A big first scan is not a jackpot.
 */
export const MilestoneBalance = {
  tokens: 1_000_000_000,
} as const

/**
 * Owes the player one guaranteed-legendary encounter.
 *
 * **This is the single entry point for every trigger that hands a legendary out** — the daily
 * streak and the lifetime milestone today, a graduation reward or a completed Pokédex
 * tomorrow. It deliberately takes no reason: delivery reuses the ordinary spawn path with the
 * rarity forced, and the moment it could see *why* it was called, someone would add a
 * `reason === '…'` branch to it. The copy that names the reason belongs to the trigger, which
 * is the only place that knows the detail worth saying (which day, which milestone).
 *
 * It is a counter, not a flag: two triggers firing in the same fold owe two legendaries, so
 * neither is silently swallowed. It is capped (`LegendaryBalance.maxOwed`) so an unbounded
 * counter fed by a buggy trigger cannot mint legendaries for ever.
 */
export function grantLegendaryEncounter(state: CompanionState, count = 1): CompanionState {
  const owed = Math.max(0, state.owedLegendaryEncounters) + Math.max(0, count)
  return { ...state, owedLegendaryEncounters: Math.min(LegendaryBalance.maxOwed, owed) }
}

/** Everything waiting in the wild area: Pokémon and item finds share the same room. */
export function queuedCount(state: Pick<CompanionState, 'wild' | 'finds'>): number {
  return (state.wild?.length ?? 0) + (state.finds?.length ?? 0)
}

// MARK: - Wandering off

/**
 * How long a wild Pokémon (or a find) waits before wandering off.
 *
 * **This is what keeps the feature alive.** A full queue freezes accrual (see
 * `addEncounterUsage`), so a queue nobody tended used to become a permanent wall: measured on a
 * real save, the queue filled inside 34 minutes and the feature then produced nothing at all for
 * the next 118 hours. With a window, the queue drains by itself and encounters keep arriving.
 *
 * Six hours is one refresh of the app's own 5-hour block plus a margin: a queue left at the end
 * of a working day is clear the next morning, and stepping away for lunch costs nothing.
 */
export const ENCOUNTER_EXPIRY_MS = 6 * 3_600_000

/**
 * The window for the ones that would hurt to lose to a timer — a shiny, or rare and above.
 * A day, so an encounter worth a Master Ball survives a night and a weekday.
 */
export const RARE_ENCOUNTER_EXPIRY_MS = 24 * 3_600_000

interface Expiring {
  rarity: Rarity
  isShiny?: boolean
  appearedAt: number
}

export function encounterExpiryFor(entry: Expiring): number {
  const worthKeeping = entry.isShiny === true || sortRank(entry.rarity) >= sortRank('rare')
  return worthKeeping ? RARE_ENCOUNTER_EXPIRY_MS : ENCOUNTER_EXPIRY_MS
}

export function hasWanderedOff(entry: Expiring, now: number): boolean {
  // A save written before `appearedAt` existed decodes it as 0, and so does a hand-edited one.
  // Reading that as "appeared at the epoch" would empty the whole queue on the first scan
  // after an upgrade — data loss dressed up as a game rule.
  if (!(entry.appearedAt > 0)) return false
  return now - entry.appearedAt >= encounterExpiryFor(entry)
}

/** The queue with everything that has waited too long removed. Order is preserved. */
export function withoutWanderedOff<T extends Expiring>(queue: readonly T[], now: number): T[] {
  return queue.filter((entry) => !hasWanderedOff(entry, now))
}

/**
 * Removes what has waited too long — Pokémon, finds and cold trails — in one pass.
 *
 * A legendary that wanders off leaves a trail, exactly as one that flees does: losing it to a
 * timer is the same loss, and it is the case a player is least able to prevent.
 */
export function expireQueue(state: CompanionState, now: number): CompanionState {
  const leaving = state.wild.filter((encounter) => hasWanderedOff(encounter, now))
  let trail = state.legendaryTrail.filter((entry) => !trailIsCold(entry, now))
  for (const encounter of leaving) {
    if (encounter.rarity === 'legendary') trail = appendTrail(trail, encounter, now)
  }
  return {
    ...state,
    wild: state.wild.filter((encounter) => !hasWanderedOff(encounter, now)),
    finds: withoutWanderedOff(state.finds, now),
    legendaryTrail: trail,
  }
}

// MARK: - Accrual

/** Cheaper for the very first encounter, steady afterwards. */
export function encounterThresholdFor(encountersSeen: number): number {
  return encountersSeen === 0 ? EncounterBalance.firstThreshold : EncounterBalance.threshold
}

/**
 * Hard bound used when reading the accumulator, for values that bypassed `addEncounterUsage`
 * (an imported save, a hand-edited file). One threshold per queue slot is the most that can
 * ever be spent, so anything above it is meaningless.
 */
const USAGE_CEILING = EncounterBalance.threshold * EncounterBalance.maxQueue

/**
 * Adds a token delta to the accumulator. Negative deltas are ignored, not subtracted.
 *
 * The cap is **one threshold per free queue slot** (`queued` is how many entries are waiting —
 * `queuedCount`). Two behaviours fall out of that, both deliberate:
 *
 * - A dev scenario granting 1.5B cannot owe hundreds of encounters and keep minting them out of
 *   one injection for ever — the accumulator is bounded structurally, on the way in.
 * - **A full queue accrues nothing.** With no room there is no progress to make; a freed slot is
 *   earned back with fresh spend, never from a bank.
 *
 * "Accrues nothing" means **held, not rewound**: a full queue holds what is there, capped at the
 * single encounter it can honestly owe, so the slot the player frees is not charged twice.
 */
export function addEncounterUsage(encounterUsage: number, delta: number, queued = 0): number {
  const room = Math.max(0, EncounterBalance.maxQueue - queued)
  if (room === 0) return Math.min(encounterUsage, EncounterBalance.threshold)
  return Math.min(encounterUsage + Math.max(0, delta), EncounterBalance.threshold * room)
}

/** How many arrivals the accumulated usage has paid for but not yet received. */
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
 * Pays for one arrival — a Pokémon or a find.
 *
 * Called **only after the arrival actually materialised**, which is what makes an offline spell
 * defer encounters instead of losing them: the usage stays banked until there is something to
 * show for it. It subtracts one threshold rather than resetting.
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

/** Tokens still to go before the next arrival, for the tab's empty state. */
export function tokensToNextEncounter(encounterUsage: number, encountersSeen: number): number {
  return Math.max(0, encounterThresholdFor(encountersSeen) - encounterUsage)
}

/**
 * Whether the next arrival is a Pokémon or an item find. One draw, taken **before** any network
 * call, so a find never waits on PokéAPI.
 *
 * The very first arrival is always a Pokémon: the cheap first threshold exists to put a wild
 * Pokémon on screen in a new user's first session, and handing them a Poké Ball instead would
 * spend that moment on the wrong thing.
 */
export function spawnKind(rng: RNG, isFirst: boolean): 'pokemon' | 'find' {
  if (isFirst) return 'pokemon'
  // The *top* of the range is the find, so a low draw — the "nothing special" end every other
  // roll in the game also keeps for the ordinary outcome — is a Pokémon.
  return rng() % 1_000 >= 1_000 - EncounterBalance.findShare ? 'find' : 'pokemon'
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

/**
 * The edge behind the "your wild area is full" notification.
 *
 * Fires **once per fill**: the flag is cleared when it fires and set again only once the queue
 * has room, so a queue that sits full announces itself once rather than on every refresh. The
 * flag moves even when notifications are off — the caller decides whether to show it — so turning
 * them back on never replays a fill that happened while they were silenced.
 */
export function queueFullEdge(state: CompanionState): { state: CompanionState; fire: boolean } {
  const full = queuedCount(state) >= EncounterBalance.maxQueue
  if (full && state.queueFullArmed) return { state: { ...state, queueFullArmed: false }, fire: true }
  if (!full && !state.queueFullArmed) return { state: { ...state, queueFullArmed: true }, fire: false }
  return { state, fire: false }
}

// MARK: - Temperament and mood

/** The six base stats PokéAPI reports for a species' default form. */
export interface BaseStats {
  hp: number
  attack: number
  defense: number
  specialAttack: number
  specialDefense: number
  speed: number
}

/** Stand-in when the stats could not be fetched: middling, so the nature still matters. */
const NEUTRAL_STATS: BaseStats = {
  hp: 80,
  attack: 80,
  defense: 80,
  specialAttack: 80,
  specialDefense: 80,
  speed: 80,
}

export const NEUTRAL_TEMPERAMENT: Temperament = { aggression: 50, skittishness: 50, appetite: 50 }

const clamp100 = (value: number) => Math.min(100, Math.max(0, Math.round(value)))

/**
 * A species' character, from its base stats and the nature it rolled.
 *
 * The nature is applied the mainline way (×1.1 / ×0.9) before anything is read, so an Adamant
 * Machop is angrier than a Modest one. Missing stats fall back to `NEUTRAL_STATS` — never block a
 * spawn on them — and missing happiness to an average appetite.
 */
export function temperamentFrom(
  stats: BaseStats | undefined,
  nature: PokemonNature | undefined,
  baseHappiness: number | undefined,
): Temperament {
  const base = stats ?? NEUTRAL_STATS
  const effect = nature === undefined ? {} : NATURE_STAT_EFFECT[nature]
  const stat = (key: BattleStat) => base[key] * (effect.up === key ? 1.1 : effect.down === key ? 0.9 : 1)
  return {
    aggression: clamp100(
      50 +
        0.5 *
          (Math.max(stat('attack'), stat('specialAttack')) -
            (stat('defense') + stat('specialDefense')) / 2),
    ),
    skittishness: clamp100(10 + 0.5 * stat('speed')),
    appetite:
      baseHappiness === undefined ? NEUTRAL_TEMPERAMENT.appetite : clamp100(20 + 0.9 * baseHappiness),
  }
}

export function temperamentOf(encounter: WildEncounter): Temperament {
  return encounter.temperament ?? NEUTRAL_TEMPERAMENT
}

/**
 * How a Pokémon feels when it appears. Rarer ones start on edge; one that has already been tracked
 * down remembers it (`trackedCount`).
 */
export function initialMood(temperament: Temperament, rarity: Rarity, trackedCount = 0): Mood {
  const rarityNerves = rarity === 'legendary' ? 15 : rarity === 'rare' ? 5 : 0
  return {
    anger: clamp100(0.2 * temperament.aggression),
    nervousness: clamp100(0.3 * temperament.skittishness + rarityNerves + 10 * trackedCount),
    trust: 0,
  }
}

export function moodOf(encounter: WildEncounter): Mood {
  return (
    encounter.mood ?? initialMood(temperamentOf(encounter), encounter.rarity, encounter.trackedCount ?? 0)
  )
}

/**
 * How mood moves. Every number the turn engine changes a mood by is here, so balance is tuned in
 * one place and the tests read the same constants.
 */
export const MoodBalance = {
  /** A failed ball: angrier and jumpier the more aggressive and skittish it is. */
  missAnger: (t: Temperament) => Math.round(6 + 0.12 * t.aggression),
  missNerves: (t: Temperament) => Math.round(6 + 0.08 * t.skittishness),
  missTrust: -5,
  /** Lashing out vents some nerves and feeds the anger. */
  attackAnger: 8,
  attackNerves: -5,
  /**
   * Flee per mille: a base plus nerves. Nerves top out at 100, so the most any Pokémon can reach is
   * 380‰ — below even odds, which is what keeps a stubborn encounter winnable with a better ball.
   */
  fleeBase: 30,
  fleePerNerve: 3.5,
  /** Legendaries are calmer than their nerves suggest — the encounter is the hard part, not the run. */
  legendaryFleeFactor: 0.6,
  /** Eating something is the least likely moment to bolt. */
  afterBerryFleeFactor: 0.25,
  attackPerAnger: 3,
  attackCap: 300,
} as const

/**
 * What a berry does, at full appetite. Scaled by `(100 + appetite) / 200`, so a Pokémon that does
 * not care much for food still gets half the effect.
 */
export const BerryEffect: Record<
  BerryKind,
  { anger: number; nervousness: number; trust: number; primes: boolean }
> = {
  oranBerry: { anger: -30, nervousness: -5, trust: 20, primes: false },
  nanabBerry: { anger: 0, nervousness: -30, trust: 10, primes: false },
  razzBerry: { anger: 0, nervousness: 0, trust: 5, primes: true },
}

/** The Razz Berry's boost to the next ball's catch value. */
export const RAZZ_CATCH_FACTOR = 1.5

function appetiteScale(temperament: Temperament): number {
  return (100 + temperament.appetite) / 200
}

function moved(mood: Mood, delta: Partial<Mood>): Mood {
  return {
    anger: clamp100(mood.anger + (delta.anger ?? 0)),
    nervousness: clamp100(mood.nervousness + (delta.nervousness ?? 0)),
    trust: clamp100(mood.trust + (delta.trust ?? 0)),
  }
}

/** Per mille chance it runs, given how it feels now. */
export function fleePermille(encounter: WildEncounter, afterBerry = false): number {
  const raw = MoodBalance.fleeBase + MoodBalance.fleePerNerve * moodOf(encounter).nervousness
  const legendary = encounter.rarity === 'legendary' ? MoodBalance.legendaryFleeFactor : 1
  const berry = afterBerry ? MoodBalance.afterBerryFleeFactor : 1
  return Math.round(raw * legendary * berry)
}

/** Per mille chance it attacks instead, given how angry it is. */
export function attackPermille(encounter: WildEncounter): number {
  return Math.min(MoodBalance.attackCap, Math.round(MoodBalance.attackPerAnger * moodOf(encounter).anger))
}

// MARK: - Capture

/**
 * Difficulty knobs on the catch.
 *
 * `difficulty` scales every capture rate down before the ball multiplies it. `maxCatchValue` caps
 * what any ball short of the Master can reach. At 200 the cap made the Great and Ultra Ball
 * worthless on commons (all three sat at 83%); at 250 a better ball matters again on every tier
 * (85% → 98.5% on a Caterpie) while 255 — the certain catch — stays the Master Ball's alone.
 */
export const Capture = {
  difficulty: 0.85,
  maxCatchValue: 250,
} as const

/**
 * The catch value `a`: the capture rate scaled by difficulty, the ball, and how the Pokémon feels.
 *
 * Trust stands in for the mainline formula's HP factor (a fed Pokémon is easier, up to ×3), anger
 * works against you (down to ×0.5) and a Razz Berry adds ×1.5 to one throw. The Master Ball's
 * `Infinity` is the one path past the cap, collapsing to 255 — the guaranteed catch.
 */
export function catchValue(
  captureRate: number,
  ball: BallKind,
  mood: Pick<Mood, 'anger' | 'trust'> = { anger: 0, trust: 0 },
  primed = false,
): number {
  const factor = (1 + mood.trust / 50) * (1 - mood.anger / 200) * (primed ? RAZZ_CATCH_FACTOR : 1)
  const scaled = Math.round(captureRate * Capture.difficulty * Pokeball.multiplier[ball] * factor)
  const ceiling = ball === 'masterBall' ? 255 : Capture.maxCatchValue
  return Math.max(1, Math.min(ceiling, scaled))
}

/** Rolls per throw, as in the mainline games: four wobbles, all four must pass. */
export const SHAKE_ROLLS = 4
const SHAKE_RANGE = 65_536

/**
 * Probability threshold `b` for one wobble, on the Gen-IV curve. At `a = 255` it saturates the
 * range, which is what makes the Master Ball an automatic catch.
 */
export function shakeThreshold(a: number): number {
  if (a >= 255) return SHAKE_RANGE
  return SHAKE_RANGE / Math.pow(255 / a, 0.1875)
}

/** Probability that one throw with catch value `a` succeeds: four wobbles all passing. */
function chanceFor(a: number): number {
  if (a >= 255) return 1
  return Math.pow(shakeThreshold(a) / SHAKE_RANGE, SHAKE_ROLLS)
}

/** One throw's odds for a bare capture rate, with no mood — the shop's and the tests' view. */
export function catchChance(captureRate: number, ball: BallKind): number {
  return chanceFor(catchValue(captureRate, ball))
}

/**
 * One throw's odds against **this** encounter, as it feels right now. What the ball rack shows,
 * and computed from the same `catchValue` the throw resolves with — the odds shown are the odds
 * rolled.
 */
export function encounterCatchChance(encounter: WildEncounter, ball: BallKind): number {
  return chanceFor(catchValue(encounter.captureRate, ball, moodOf(encounter), encounter.primed === true))
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
  const a = catchValue(encounter.captureRate, ball, moodOf(encounter), encounter.primed === true)
  if (a >= 255) return { caught: true, shakes: SHAKE_ROLLS }

  const b = shakeThreshold(a)
  let shakes = 0
  for (let roll = 0; roll < SHAKE_ROLLS; roll++) {
    if (rng() % SHAKE_RANGE >= b) break
    shakes += 1
  }
  return { caught: shakes === SHAKE_ROLLS, shakes }
}

// MARK: - Attacks

/**
 * What one attack takes from the wallet, by rarity, and the most one encounter can take in total.
 *
 * Bounded twice: never more than the spendable balance (an empty wallet loses nothing and the
 * balance can never go negative), and never more than `perEncounter` amounts from one Pokémon.
 * Debited through `spentTokens`, the wallet's only debit — so growth (`usedSinceInstall`) is never
 * touched, and a save merge carries the theft together with the bag and the queue it belongs to.
 */
export const StealBalance = {
  amount: {
    common: 500_000,
    uncommon: 1_000_000,
    rare: 2_000_000,
    legendary: 4_000_000,
  } as Record<Rarity, number>,
  perEncounter: 3,
} as const

/** Tokens an attack by this encounter would take right now. */
export function stealAmount(state: CompanionState, encounter: WildEncounter): number {
  const amount = StealBalance.amount[encounter.rarity]
  const wallet = spendableBalance(state)
  const left = amount * StealBalance.perEncounter - (encounter.stolen ?? 0)
  return Math.max(0, Math.min(amount, wallet, left))
}

// MARK: - The legendary trail

/**
 * Tracking a legendary that got away.
 *
 * The price doubles with every track and the trail ends after `maxTracks`, so even three tracks
 * (700M) stay below a Master Ball — a second chance, never a cheaper certainty. Only fleeing and
 * wandering off leave a trail: running away does not, or tracking would be a paid "reset its
 * mood" button.
 */
export const TrailBalance = {
  windowMs: 72 * 3_600_000,
  basePrice: 100_000_000,
  growth: 2,
  maxTracks: 3,
  maxEntries: 6,
} as const

export function trailPrice(entry: Pick<TrailEntry, 'trackedCount'>): number {
  return TrailBalance.basePrice * Math.pow(TrailBalance.growth, entry.trackedCount)
}

export function trailIsCold(entry: TrailEntry, now: number): boolean {
  return now - entry.lostAt >= TrailBalance.windowMs
}

/** Leaves a trail for a legendary that just got away — unless it has been tracked to the limit. */
export function appendTrail(
  trail: readonly TrailEntry[],
  encounter: WildEncounter,
  now: number,
): TrailEntry[] {
  const trackedCount = encounter.trackedCount ?? 0
  if (encounter.rarity !== 'legendary' || trackedCount >= TrailBalance.maxTracks) return [...trail]
  const entry: TrailEntry = {
    id: encounter.id,
    speciesID: encounter.speciesID,
    captureRate: encounter.captureRate,
    isShiny: encounter.isShiny,
    trackedCount,
    lostAt: now,
  }
  if (encounter.names !== undefined) entry.names = encounter.names
  if (encounter.nature !== undefined) entry.nature = encounter.nature
  if (encounter.temperament !== undefined) entry.temperament = encounter.temperament
  if (encounter.types !== undefined) entry.types = encounter.types
  return [...trail.filter((e) => e.id !== entry.id), entry].slice(-TrailBalance.maxEntries)
}

export type TrackOutcome = 'tracked' | 'unknown' | 'expired' | 'noRoom' | 'cantAfford'

/**
 * Pays to put a legendary that got away back in the queue — the **same** Pokémon: species, shiny,
 * nature and temperament, rebuilt from the trail with no network. It comes back a little more
 * nervous for every time it has been tracked.
 *
 * Checked in an order that never charges for nothing: an unknown or cold trail, or no room for it,
 * is refused before the wallet is looked at.
 */
export function trackLegendary(
  state: CompanionState,
  trailID: string,
  now: number,
): { state: CompanionState; outcome: TrackOutcome } {
  const entry = state.legendaryTrail.find((e) => e.id === trailID)
  if (entry === undefined) return { state, outcome: 'unknown' }
  if (trailIsCold(entry, now)) return { state, outcome: 'expired' }
  if (queuedCount(state) >= EncounterBalance.maxQueue) return { state, outcome: 'noRoom' }
  const price = trailPrice(entry)
  if (spendableBalance(state) < price) return { state, outcome: 'cantAfford' }

  const trackedCount = entry.trackedCount + 1
  const encounter: WildEncounter = {
    id: `${entry.id}-t${trackedCount}`,
    speciesID: entry.speciesID,
    captureRate: entry.captureRate,
    rarity: 'legendary',
    isShiny: entry.isShiny,
    appearedAt: now,
    throws: 0,
    trackedCount,
  }
  if (entry.names !== undefined) encounter.names = entry.names
  if (entry.nature !== undefined) encounter.nature = entry.nature
  if (entry.temperament !== undefined) encounter.temperament = entry.temperament
  if (entry.types !== undefined) encounter.types = entry.types
  encounter.mood = initialMood(temperamentOf(encounter), 'legendary', trackedCount)

  return {
    state: {
      ...state,
      spentTokens: state.spentTokens + price,
      legendaryTrail: state.legendaryTrail.filter((e) => e.id !== trailID),
      wild: [...state.wild, encounter],
    },
    outcome: 'tracked',
  }
}

// MARK: - Item finds

/** What can turn up lying in the wild. Never a Master Ball, never anything that grows a Pokémon. */
export const FINDABLE_ITEMS = [
  'pokeBall',
  'greatBall',
  'ultraBall',
  'oranBerry',
  'nanabBerry',
  'razzBerry',
] as const
export type FindableItem = (typeof FINDABLE_ITEMS)[number]

export function isFindableItem(item: string): item is FindableItem {
  return (FINDABLE_ITEMS as readonly string[]).includes(item)
}

/**
 * The find table: a rarity draw, then a weighted contents draw inside it.
 *
 * Expected value is ~10M tokens of items per find — enough that tending the queue keeps you in
 * Poké Balls, not enough to replace the shop for the better balls and berries.
 */
export const FIND_TABLE: readonly {
  rarity: Rarity
  permille: number
  contents: readonly { item: FindableItem; count: number; weight: number }[]
}[] = [
  {
    rarity: 'common',
    permille: 700,
    contents: [
      { item: 'pokeBall', count: 1, weight: 3 },
      { item: 'oranBerry', count: 1, weight: 1 },
      { item: 'nanabBerry', count: 1, weight: 1 },
      { item: 'razzBerry', count: 1, weight: 1 },
    ],
  },
  {
    rarity: 'uncommon',
    permille: 230,
    contents: [
      { item: 'pokeBall', count: 2, weight: 1 },
      { item: 'greatBall', count: 1, weight: 1 },
      { item: 'razzBerry', count: 2, weight: 1 },
    ],
  },
  {
    rarity: 'rare',
    permille: 60,
    contents: [
      { item: 'greatBall', count: 2, weight: 1 },
      { item: 'ultraBall', count: 1, weight: 1 },
    ],
  },
  { rarity: 'legendary', permille: 10, contents: [{ item: 'ultraBall', count: 3, weight: 1 }] },
]

/** Rolls one find: two draws, rarity then contents. */
export function rollFind(rng: RNG, id: string, now: number): WildFind {
  let r = rng() % 1_000
  let tier = FIND_TABLE[FIND_TABLE.length - 1]!
  for (const row of FIND_TABLE) {
    if (r < row.permille) {
      tier = row
      break
    }
    r -= row.permille
  }
  const total = tier.contents.reduce((sum, c) => sum + c.weight, 0)
  let w = rng() % total
  let pick = tier.contents[tier.contents.length - 1]!
  for (const content of tier.contents) {
    if (w < content.weight) {
      pick = content
      break
    }
    w -= content.weight
  }
  return { id, item: pick.item, count: pick.count, rarity: tier.rarity, appearedAt: now }
}

function addToBag(
  inventory: Record<string, number>,
  item: ItemKind,
  count: number,
): Record<string, number> {
  return { ...inventory, [item]: (inventory[item] ?? 0) + count }
}

/** Picks one find up. `undefined` for an id the queue does not hold — a stale webview fails closed. */
export function collectFind(state: CompanionState, findID: string): CompanionState | undefined {
  const find = state.finds.find((f) => f.id === findID)
  if (find === undefined) return undefined
  return {
    ...state,
    inventory: addToBag(state.inventory, find.item, find.count),
    finds: state.finds.filter((f) => f.id !== findID),
  }
}

/** Picks everything up at once — with thirty slots, one click each is a chore. */
export function collectAllFinds(state: CompanionState): CompanionState {
  let inventory = state.inventory
  for (const find of state.finds) inventory = addToBag(inventory, find.item, find.count)
  return { ...state, inventory, finds: [] }
}

// MARK: - Turns

export type EncounterAction = { kind: 'throw'; ball: BallKind } | { kind: 'feed'; berry: BerryKind }

/** An attack that happened this turn, and what it took (0 when the wallet was empty). */
export interface Attack {
  stolen: number
}

export type TurnOutcome =
  /**
   * `refunded`: what it had stolen, paid back by catching it. A first catch says how far its
   * registration now reads (`registeredPercent`); a duplicate, what it paid (`reward`).
   */
  | { kind: 'caught'; shakes: number; refunded: number; registeredPercent?: number; reward?: number }
  /** The ball failed and it is still there — and it may have struck back. */
  | { kind: 'broke'; shakes: number; attack?: Attack }
  /** It ate the berry and stayed — and it may have struck back anyway. */
  | { kind: 'fed'; berry: BerryKind; attack?: Attack }
  /** It ran. `shakes` is 0 after a berry; `trailed` says a legendary left tracks. */
  | { kind: 'fled'; shakes: number; via: 'throw' | 'feed'; trailed: boolean }
  /** The bag held none of that item: nothing was spent. */
  | { kind: 'noItem' }
  /** A stale webview echoed an id the queue no longer holds. */
  | { kind: 'unknownEncounter' }

export interface TurnResult {
  state: CompanionState
  outcome: TurnOutcome
}

/**
 * A catch, in the registry. A species not yet obtained is unlocked and fills
 * `EconomyBalance.catchShare` of its bar — owed as `pendingShare` until its line fixes the
 * threshold. One already obtained is a duplicate: it pays `duplicateReward` into `earnedTokens`
 * (never off `spentTokens`, which clamps at zero and would swallow it) and adds no experience.
 * A shiny marks the shiny form obtained either way.
 */
function caughtSpecies(
  state: CompanionState,
  encounter: WildEncounter,
): { state: CompanionState; registeredPercent?: number; reward?: number } {
  const id = encounter.speciesID
  const before = progressOf(state, id)
  const p: SpeciesProgress = { ...before, unlocked: true, caught: before.caught + 1 }
  if (encounter.isShiny) p.shinyUnlocked = true
  if (before.unlocked) {
    const reward = EconomyBalance.duplicateReward[encounter.rarity]
    return {
      state: {
        ...state,
        earnedTokens: state.earnedTokens + reward,
        species: { ...state.species, [id]: p },
      },
      reward,
    }
  }
  if (p.threshold !== undefined) {
    p.xp = Math.min(p.threshold, p.xp + shareXP(EconomyBalance.catchShare, p.threshold))
  } else {
    p.pendingShare = Math.min(1, (p.pendingShare ?? 0) + EconomyBalance.catchShare)
  }
  return {
    state: { ...state, species: { ...state.species, [id]: p } },
    registeredPercent: registrationPercent(p),
  }
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
  if (encounter.nature !== undefined) entry.nature = encounter.nature
  if (encounter.names !== undefined) entry.names = { [encounter.speciesID]: encounter.names }
  return entry
}

/**
 * The Pokémon's answer to your turn: one draw against stacked thresholds — flee, then attack,
 * otherwise it stays. The thresholds are read from the mood *after* your action, so a missed ball
 * raises the very nerves this roll is held to.
 */
function react(
  state: CompanionState,
  index: number,
  encounter: WildEncounter,
  afterBerry: boolean,
  rng: RNG,
  now: number,
): { state: CompanionState; fled: boolean; trailed: boolean; attack?: Attack } {
  const fleeAt = fleePermille(encounter, afterBerry)
  const attackAt = fleeAt + attackPermille(encounter)
  const roll = rng() % 1_000

  if (roll < fleeAt) {
    const trail = appendTrail(state.legendaryTrail, encounter, now)
    return {
      state: { ...state, wild: state.wild.filter((_, i) => i !== index), legendaryTrail: trail },
      fled: true,
      trailed: trail.some((e) => e.id === encounter.id),
    }
  }

  if (roll < attackAt) {
    const stolen = stealAmount(state, encounter)
    const angrier: WildEncounter = {
      ...encounter,
      mood: moved(moodOf(encounter), {
        anger: MoodBalance.attackAnger,
        nervousness: MoodBalance.attackNerves,
      }),
      stolen: (encounter.stolen ?? 0) + stolen,
    }
    return {
      state: {
        ...state,
        spentTokens: state.spentTokens + stolen,
        wild: state.wild.map((e, i) => (i === index ? angrier : e)),
      },
      fled: false,
      trailed: false,
      attack: { stolen },
    }
  }

  return {
    state: { ...state, wild: state.wild.map((e, i) => (i === index ? encounter : e)) },
    fled: false,
    trailed: false,
  }
}

/**
 * One turn against one encounter: your action, then its reaction.
 *
 * Fails closed twice before touching anything: an id the queue does not hold is a stale webview,
 * and an empty bag must not spend an item it does not have. Both return the state unchanged.
 */
export function takeTurn(
  state: CompanionState,
  encounterID: string,
  action: EncounterAction,
  rng: RNG,
  now: number,
): TurnResult {
  const index = state.wild.findIndex((e) => e.id === encounterID)
  if (index === -1) return { state, outcome: { kind: 'unknownEncounter' } }

  const item = action.kind === 'throw' ? action.ball : action.berry
  const owned = state.inventory[item] ?? 0
  if (owned <= 0) return { state, outcome: { kind: 'noItem' } }

  const encounter = state.wild[index]!
  const spent: CompanionState = { ...state, inventory: { ...state.inventory, [item]: owned - 1 } }
  const temperament = temperamentOf(encounter)

  if (action.kind === 'throw') {
    const roll = resolveThrow(encounter, action.ball, rng)
    if (roll.caught) {
      const refunded = Math.min(encounter.stolen ?? 0, spent.spentTokens)
      const filed = caughtSpecies(
        {
          ...spent,
          spentTokens: spent.spentTokens - refunded,
          wild: spent.wild.filter((_, i) => i !== index),
          dex: [...spent.dex, wildDexEntry(encounter, now)],
        },
        encounter,
      )
      const outcome: TurnOutcome = { kind: 'caught', shakes: roll.shakes, refunded }
      if (filed.registeredPercent !== undefined) outcome.registeredPercent = filed.registeredPercent
      if (filed.reward !== undefined) outcome.reward = filed.reward
      return { state: filed.state, outcome }
    }

    const missed: WildEncounter = {
      ...encounter,
      throws: encounter.throws + 1,
      mood: moved(moodOf(encounter), {
        anger: MoodBalance.missAnger(temperament),
        nervousness: MoodBalance.missNerves(temperament),
        trust: MoodBalance.missTrust,
      }),
    }
    // The Razz Berry's boost is spent on this throw, hit or miss.
    delete missed.primed
    const reaction = react(spent, index, missed, false, rng, now)
    if (reaction.fled) {
      return {
        state: reaction.state,
        outcome: { kind: 'fled', shakes: roll.shakes, via: 'throw', trailed: reaction.trailed },
      }
    }
    const outcome: TurnOutcome = { kind: 'broke', shakes: roll.shakes }
    if (reaction.attack !== undefined) outcome.attack = reaction.attack
    return { state: reaction.state, outcome }
  }

  const effect = BerryEffect[action.berry]
  const k = appetiteScale(temperament)
  const fed: WildEncounter = {
    ...encounter,
    mood: moved(moodOf(encounter), {
      anger: Math.round(effect.anger * k),
      // The Oran Berry's nerve effect is small and flat; only the bait's scales with appetite.
      nervousness:
        action.berry === 'nanabBerry' ? Math.round(effect.nervousness * k) : effect.nervousness,
      trust: Math.round(effect.trust * k),
    }),
  }
  if (effect.primes) fed.primed = true
  const reaction = react(spent, index, fed, true, rng, now)
  if (reaction.fled) {
    return {
      state: reaction.state,
      outcome: { kind: 'fled', shakes: 0, via: 'feed', trailed: reaction.trailed },
    }
  }
  const outcome: TurnOutcome = { kind: 'fed', berry: action.berry }
  if (reaction.attack !== undefined) outcome.attack = reaction.attack
  return { state: reaction.state, outcome }
}

/** Throws one ball. Kept as the ball-only entry point the store and older tests call. */
export function throwBall(
  state: CompanionState,
  encounterID: string,
  ball: BallKind,
  rng: RNG,
  now: number,
): TurnResult {
  return takeTurn(state, encounterID, { kind: 'throw', ball }, rng, now)
}

/** The player walks away. Discards the encounter, spends nothing, and leaves no trail. */
export function runFromEncounter(state: CompanionState, encounterID: string): CompanionState {
  const queue = state.wild ?? []
  if (!queue.some((e) => e.id === encounterID)) return state
  return { ...state, wild: queue.filter((e) => e.id !== encounterID) }
}
