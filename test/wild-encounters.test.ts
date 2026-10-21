import { describe, expect, it } from 'vitest'
import {
  Capture,
  EncounterBalance,
  LegendaryBalance,
  MoodBalance,
  StealBalance,
  TrailBalance,
  addEncounterUsage,
  attackPermille,
  catchChance,
  catchValue,
  collectAllFinds,
  collectFind,
  encounterCatchChance,
  encounterThresholdFor,
  ENCOUNTER_EXPIRY_MS,
  RARE_ENCOUNTER_EXPIRY_MS,
  enqueueEncounter,
  expireQueue,
  fleePermille,
  grantLegendaryEncounter,
  initialMood,
  moodOf,
  queueFullEdge,
  rollFind,
  spawnKind,
  stealAmount,
  takeTurn,
  temperamentFrom,
  trackLegendary,
  trailPrice,
  withoutWanderedOff,
  owedEncounters,
  payForEncounter,
  resolveThrow,
  runFromEncounter,
  shakeThreshold,
  throwBall,
  tokensToNextEncounter,
  type BaseStats,
} from '../src/core/companion/encounters.js'
import {
  type BallKind,
  type CompanionState,
  type TrailEntry,
  type WildEncounter,
  type WildFind,
  type SpeciesProgress,
  PokemonBalance,
  freshCompanionState,
  freshSpeciesProgress,
} from '../src/core/companion/model.js'
import { EconomyBalance } from '../src/core/companion/economy.js'
import { registrationPercent } from '../src/core/companion/registry.js'

/** Deterministic RNG so every roll in a throw is pinned. */
const fixedRNG = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

/** Like `fixedRNG`, but the last value repeats instead of the sequence wrapping around. */
const sequence = (...values: number[]) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

/** A roll no wobble passes (the range is 0..65535) and no reaction threshold reaches. */
const MISS = 65_535
const STAY = 999

const wild = (over: Partial<WildEncounter> = {}): WildEncounter => ({
  id: 'w1',
  speciesID: 10,
  captureRate: 255,
  rarity: 'common',
  isShiny: false,
  appearedAt: 1_700_000_000_000,
  throws: 0,
  ...over,
})

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

const NOW = 1_700_000_100_000

describe('accrual', () => {
  it('owes nothing below the threshold and keeps the usage', () => {
    expect(addEncounterUsage(0, 400_000)).toBe(400_000)
    expect(owedEncounters(400_000, 0)).toBe(0)
  })

  it('applies the cheaper first threshold exactly once', () => {
    expect(owedEncounters(EncounterBalance.firstThreshold, 0)).toBe(1)
    expect(owedEncounters(EncounterBalance.firstThreshold, 1)).toBe(0)
  })

  // [trigger branch] Zeroing the accumulator instead of subtracting the threshold silently
  // loses everything above it, which at 2.5M a spawn is most of a busy day.
  it('carries the remainder past a spawn instead of resetting', () => {
    const paid = payForEncounter(EncounterBalance.threshold + 777, 1)
    expect(paid.encounterUsage).toBe(777)
    expect(paid.encountersSeen).toBe(2)
  })

  it('charges the first spawn the cheap threshold and the next the full one', () => {
    const first = payForEncounter(EncounterBalance.threshold, 0)
    expect(first.encounterUsage).toBe(EncounterBalance.threshold - EncounterBalance.firstThreshold)

    const second = payForEncounter(first.encounterUsage, first.encountersSeen)
    expect(second.encounterUsage).toBe(0)
  })

  it('owes several when one delta crosses the threshold repeatedly', () => {
    expect(owedEncounters(EncounterBalance.threshold * 3, 1)).toBe(3)
  })

  // [trigger branch] Without the ceiling a dev scenario granting 1.5B owes hundreds of encounters
  // and keeps minting them out of one injection; the queue only holds `EncounterBalance.maxQueue`,
  // so banking more is meaningless as well as unbounded.
  it('bounds a single absurd delta rather than banking encounters for ever', () => {
    const usage = addEncounterUsage(0, 1_500_000_000)
    expect(owedEncounters(usage, 1)).toBeLessThanOrEqual(EncounterBalance.maxQueue)
  })

  // [trigger branch] The old fixed ceiling banked 13 spawns' worth of usage. A heavy user's
  // bank was therefore permanently full, so every catch was replaced on the very next scan
  // and the queue count never visibly dropped — reported as "catching doesn't reduce the
  // waiting count". With no room there is no progress to make, so nothing accrues.
  // [trigger branch] Holding is not the same as zeroing. Clamping to `threshold * room` with
  // no room *destroyed* progress the player had already earned, so the slot they freed cost a
  // second full threshold — they were charged twice for the same encounter.
  it('holds the accumulator where it is while the queue is full, rather than rewinding it', () => {
    const earned = EncounterBalance.threshold - 100_000
    expect(addEncounterUsage(earned, 10_000_000, EncounterBalance.maxQueue)).toBe(earned)
  })

  it('accrues nothing while the queue is full', () => {
    expect(addEncounterUsage(0, 10_000_000, EncounterBalance.maxQueue)).toBe(0)
  })

  // A surplus that arrived some other way — an imported save, a dev injection — must not
  // survive a full queue and then mint a burst the moment it drains. It is clamped to the one
  // encounter it can honestly owe rather than to zero, which used to take genuinely earned
  // progress with it.
  it('clamps an already-banked surplus to a single encounter when the queue has filled', () => {
    const held = addEncounterUsage(30_000_000, 1, EncounterBalance.maxQueue)
    expect(held).toBe(EncounterBalance.threshold)
    expect(owedEncounters(held, 1)).toBe(1)
  })

  it('banks at most one threshold per free slot', () => {
    const usage = addEncounterUsage(0, 1_500_000_000, EncounterBalance.maxQueue - 2)
    expect(usage).toBe(EncounterBalance.threshold * 2)
    expect(owedEncounters(usage, 1)).toBe(2)
  })

  it('ignores a negative delta', () => {
    expect(addEncounterUsage(1_000, -5_000)).toBe(1_000)
  })

  it('exposes which threshold applies', () => {
    expect(encounterThresholdFor(0)).toBe(EncounterBalance.firstThreshold)
    expect(encounterThresholdFor(1)).toBe(EncounterBalance.threshold)
  })

  it('reports what is left to go, floored at zero', () => {
    expect(tokensToNextEncounter(0, 1)).toBe(EncounterBalance.threshold)
    expect(tokensToNextEncounter(EncounterBalance.threshold * 2, 1)).toBe(0)
  })
})

// [trigger branch] Nothing ever removed a waiting encounter except the player, and a full
// queue freezes accrual — so a queue nobody tended became a permanent wall. Measured on a real
// save: twelve encounters arrived inside 34 minutes and the feature then produced nothing for
// 118 hours, across 561M tokens of work. Wild Pokémon have to wander off on their own.
describe('wandering off', () => {
  const hours = (n: number) => n * 3_600_000

  it('keeps an encounter that has only just appeared', () => {
    const queue = [wild({ appearedAt: NOW - hours(1) })]
    expect(withoutWanderedOff(queue, NOW)).toHaveLength(1)
  })

  it('lets an ordinary one leave once its window has passed', () => {
    const queue = [wild({ id: 'old', appearedAt: NOW - ENCOUNTER_EXPIRY_MS })]
    expect(withoutWanderedOff(queue, NOW)).toEqual([])
  })

  // Losing a shiny or a rare to a timer is the version of this that would sting, so they wait
  // far longer — the same value `enqueueEncounter` encodes when it decides what to drop.
  it('gives a shiny and a rare a much longer wait', () => {
    const justPastOrdinary = NOW - ENCOUNTER_EXPIRY_MS
    const queue = [
      wild({ id: 'shiny', isShiny: true, appearedAt: justPastOrdinary }),
      wild({ id: 'rare', rarity: 'rare', appearedAt: justPastOrdinary }),
      wild({ id: 'legendary', rarity: 'legendary', appearedAt: justPastOrdinary }),
      wild({ id: 'common', appearedAt: justPastOrdinary }),
    ]
    expect(withoutWanderedOff(queue, NOW).map((e) => e.id)).toEqual(['shiny', 'rare', 'legendary'])
    expect(withoutWanderedOff(queue, NOW + RARE_ENCOUNTER_EXPIRY_MS)).toEqual([])
  })

  // A save written before `appearedAt` existed decodes it as 0. Treating that as "appeared at
  // the epoch" would empty the whole queue on the first scan after an upgrade.
  it('never expires an encounter with no appearance time', () => {
    expect(withoutWanderedOff([wild({ appearedAt: 0 })], NOW)).toHaveLength(1)
  })
})

describe('enqueueEncounter', () => {
  it('appends while there is room, oldest first', () => {
    const queue = enqueueEncounter([wild({ id: 'a' })], wild({ id: 'b' }))
    expect(queue.map((e) => e.id)).toEqual(['a', 'b'])
  })

  // [trigger branch] Plain FIFO would drop the legendary that appeared first to make room for
  // a Caterpie — the one outcome a player would call a bug.
  it('drops the oldest of the lowest rarity present, not simply the oldest', () => {
    const full = Array.from({ length: EncounterBalance.maxQueue }, (_, i) =>
      wild({ id: `f${i}`, rarity: i === 0 ? 'legendary' : 'common' }),
    )
    const queue = enqueueEncounter(full, wild({ id: 'new', rarity: 'common' }))

    expect(queue).toHaveLength(EncounterBalance.maxQueue)
    expect(queue.map((e) => e.id)).toContain('f0')
    expect(queue.map((e) => e.id)).not.toContain('f1')
    expect(queue.map((e) => e.id)).toContain('new')
  })

  // The other half of the same rule, and the one an earned legendary depends on: arriving into
  // a full queue must cost a common its place, never the reward its existence.
  it('makes room for an incoming legendary by dropping a common', () => {
    const full = Array.from({ length: EncounterBalance.maxQueue }, (_, i) => wild({ id: `f${i}` }))
    const queue = enqueueEncounter(full, wild({ id: 'earned', rarity: 'legendary' }))
    expect(queue.map((e) => e.id)).toContain('earned')
    expect(queue).toHaveLength(EncounterBalance.maxQueue)
  })
})

// The "deliver" half of the legendary reward. It has no idea which trigger called it, which is
// exactly what lets a new trigger reuse it without touching anything here.
describe('grantLegendaryEncounter', () => {
  it('owes one legendary per grant, so two triggers in one fold owe two', () => {
    expect(grantLegendaryEncounter(state()).owedLegendaryEncounters).toBe(1)
    expect(grantLegendaryEncounter(grantLegendaryEncounter(state())).owedLegendaryEncounters).toBe(2)
  })

  // [trigger branch] An IOU the spawn path pays out for ever: a runaway trigger must not become a
  // faucet. The ceiling is its own constant — it used to borrow `maxQueue`, so raising the queue
  // to 30 would have silently raised how many legendaries could be banked.
  it('never owes more than its own ceiling, whatever the queue holds', () => {
    let owing = state()
    for (let i = 0; i < 50; i++) owing = grantLegendaryEncounter(owing)
    expect(owing.owedLegendaryEncounters).toBe(LegendaryBalance.maxOwed)
    expect(LegendaryBalance.maxOwed).toBeLessThan(EncounterBalance.maxQueue)
  })

  it('ignores a negative grant rather than cancelling a debt with it', () => {
    expect(grantLegendaryEncounter(grantLegendaryEncounter(state()), -5).owedLegendaryEncounters).toBe(1)
  })
})

describe('catchValue', () => {
  it('scales the capture rate by difficulty and the ball', () => {
    expect(catchValue(45, 'pokeBall')).toBe(38) // 45 × 0.85
    expect(catchValue(45, 'greatBall')).toBe(57)
    expect(catchValue(45, 'ultraBall')).toBe(77)
  })

  // [trigger branch] Without the cap, a full-rate species was a guaranteed wobble-less catch with
  // the cheapest ball; the guaranteed catch is the Master Ball's job and nobody else's.
  it('caps every ball short of the Master below certainty', () => {
    expect(catchValue(255, 'ultraBall')).toBe(Capture.maxCatchValue)
    expect(Capture.maxCatchValue).toBeLessThan(255)
    expect(catchValue(3, 'masterBall')).toBe(255)
  })

  it('never returns less than 1', () => {
    expect(catchValue(0, 'pokeBall')).toBe(1)
  })

  it('is monotonic in ball tier', () => {
    const values = (['pokeBall', 'greatBall', 'ultraBall'] as const).map((b) => catchValue(3, b))
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })

  it('is lowered by anger, raised by trust and by a Razz Berry', () => {
    const calm = catchValue(45, 'pokeBall')
    expect(catchValue(45, 'pokeBall', { anger: 100, trust: 0 })).toBeLessThan(calm)
    expect(catchValue(45, 'pokeBall', { anger: 0, trust: 50 })).toBeGreaterThan(calm)
    expect(catchValue(45, 'pokeBall', { anger: 0, trust: 0 }, true)).toBeGreaterThan(calm)
  })
})

describe('shakeThreshold', () => {
  it('is certain at 255 and long odds at 3', () => {
    expect(shakeThreshold(255)).toBe(65_536)
    expect(shakeThreshold(3)).toBeLessThan(30_000)
  })

  it('rises with the catch value', () => {
    expect(shakeThreshold(90)).toBeGreaterThan(shakeThreshold(45))
  })
})

describe('resolveThrow', () => {
  // A guaranteed catch must not consume a die — and with the difficulty cap, only the Master
  // Ball can reach 255 at all. What this pins is that no draw is spent.
  it('the Master Ball catches without consuming a roll', () => {
    const exploding = () => {
      throw new Error('resolveThrow drew a die for a guaranteed catch')
    }
    expect(resolveThrow(wild({ captureRate: 255 }), 'masterBall', exploding)).toEqual({
      caught: true,
      shakes: 4,
    })
  })

  // The cap's visible consequence: even a Caterpie can wobble out of a Poké Ball.
  it('a full-rate species is not an automatic catch with a Poké Ball', () => {
    const outcome = resolveThrow(wild({ captureRate: 255 }), 'pokeBall', fixedRNG(65_500))
    expect(outcome.caught).toBe(false)
  })

  it('always catches with a Master Ball, whatever the rolls say', () => {
    const outcome = resolveThrow(
      wild({ captureRate: 3, rarity: 'legendary' }),
      'masterBall',
      fixedRNG(65_535),
    )
    expect(outcome).toEqual({ caught: true, shakes: 4 })
  })

  it('counts shakes up to the first failed roll', () => {
    const encounter = wild({ captureRate: 45, rarity: 'rare' })
    const b = shakeThreshold(catchValue(45, 'pokeBall', moodOf(encounter)))
    // Two passes, then a failure: the fourth value must never be read.
    const outcome = resolveThrow(encounter, 'pokeBall', fixedRNG(0, 0, b, 0))
    expect(outcome).toEqual({ caught: false, shakes: 2 })
  })

  it('catches when all four rolls pass', () => {
    const outcome = resolveThrow(wild({ captureRate: 45, rarity: 'rare' }), 'pokeBall', fixedRNG(0))
    expect(outcome).toEqual({ caught: true, shakes: 4 })
  })
})

describe('catchChance', () => {
  it('is certain only for the Master Ball', () => {
    expect(catchChance(3, 'masterBall')).toBe(1)
    expect(catchChance(255, 'ultraBall')).toBeLessThan(1)
  })

  // The rack shows these numbers; they must be the same maths the throw rolls.
  it('matches the shake threshold raised to the four rolls', () => {
    const b = shakeThreshold(catchValue(45, 'pokeBall'))
    expect(catchChance(45, 'pokeBall')).toBeCloseTo(Math.pow(b / 65_536, 4), 10)
  })

  it('reads the encounter’s mood, so the odds shown are the odds rolled', () => {
    const encounter = wild({ captureRate: 45, mood: { anger: 80, nervousness: 10, trust: 0 } })
    const a = catchValue(45, 'pokeBall', moodOf(encounter))
    expect(encounterCatchChance(encounter, 'pokeBall')).toBeCloseTo(
      Math.pow(shakeThreshold(a) / 65_536, 4),
      10,
    )
    expect(encounterCatchChance(encounter, 'pokeBall')).toBeLessThan(catchChance(45, 'pokeBall'))
  })

  it('is monotonic in ball tier', () => {
    const chances = (['pokeBall', 'greatBall', 'ultraBall', 'masterBall'] as const).map((b) =>
      catchChance(45, b),
    )
    expect(chances).toEqual([...chances].sort((a, b) => a - b))
  })
})

/**
 * Chance of catching it eventually, throwing `ball` until the encounter ends — computed exactly
 * through the engine itself. Each reachable mood is a state; its transitions are read from
 * `takeTurn` (the mood a miss leaves, and the one an attack leaves) and weighted by the same
 * permille the roll is held to. Moods saturate at 100, so the graph has cycles (miss → attack →
 * miss can return to where it started); it is solved by iterating to the fixed point.
 */
function eventualCatch(start: WildEncounter, ball: BallKind): number {
  interface Node {
    p: number
    stay: string | undefined
    attack: string | undefined
    stayWeight: number
    attackWeight: number
  }
  const nodes = new Map<string, Node>()
  const keyOf = (e: WildEncounter) => JSON.stringify(moodOf(e))
  const pending: WildEncounter[] = [start]
  while (pending.length > 0) {
    const encounter = pending.pop()!
    const key = keyOf(encounter)
    if (nodes.has(key)) continue
    const base = state({ usedSinceInstall: 1e12, inventory: { [ball]: 99 }, wild: [encounter] })
    const turn = (roll: number) =>
      takeTurn(base, encounter.id, { kind: 'throw', ball }, sequence(MISS, roll), NOW).state.wild[0]
    const missed = turn(STAY)!
    const flee = fleePermille(missed)
    const attack = attackPermille(missed)
    const attacked = attack > 0 ? turn(flee) : undefined
    nodes.set(key, {
      p: encounterCatchChance(encounter, ball),
      stay: keyOf(missed),
      attack: attacked === undefined ? undefined : keyOf(attacked),
      stayWeight: (1000 - flee - attack) / 1000,
      attackWeight: attack / 1000,
    })
    pending.push(missed)
    if (attacked !== undefined) pending.push(attacked)
  }
  let value = new Map([...nodes.keys()].map((k) => [k, 0]))
  for (let i = 0; i < 500; i++) {
    const next = new Map<string, number>()
    for (const [k, n] of nodes) {
      const stay = n.stay === undefined ? 0 : (value.get(n.stay) ?? 0)
      const hit = n.attack === undefined ? 0 : (value.get(n.attack) ?? 0)
      next.set(k, n.p + (1 - n.p) * (n.stayWeight * stay + n.attackWeight * hit))
    }
    value = next
  }
  return value.get(keyOf(start)) ?? 0
}

// The rebalance this design exists for, pinned. Before it, a legendary got away 89–92% of the
// time with any ball short of a Master, a rare half the time, and the Great and Ultra Balls did
// nothing at all on a common — every one of them sat at the same 83% under the old cap.
describe('balance', () => {
  const neutral = (captureRate: number, rarity: WildEncounter['rarity']) => wild({ captureRate, rarity })

  it.each([
    [3, 'legendary', [0.131, 0.182, 0.226]],
    [45, 'rare', [0.587, 0.698, 0.772]],
    [120, 'uncommon', [0.853, 0.929, 0.97]],
    [255, 'common', [0.978, 0.998, 0.998]],
  ] as const)(
    'rate %i (%s) is caught eventually as often as the design says',
    (rate, rarity, expected) => {
      const odds = (['pokeBall', 'greatBall', 'ultraBall'] as const).map((b) =>
        eventualCatch(neutral(rate, rarity), b),
      )
      odds.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 2))
    },
  )

  // [trigger branch] The old 200 cap flattened every ball onto the same number for a common.
  it('makes a better ball worth buying on a common', () => {
    const caterpie = neutral(255, 'common')
    expect(encounterCatchChance(caterpie, 'greatBall')).toBeGreaterThan(
      encounterCatchChance(caterpie, 'pokeBall') + 0.1,
    )
  })
})

describe('temperament', () => {
  const mewtwo: BaseStats = {
    hp: 106,
    attack: 110,
    defense: 90,
    specialAttack: 154,
    specialDefense: 90,
    speed: 130,
  }

  it('reads aggression from attack against defence and nerves from speed', () => {
    expect(temperamentFrom(mewtwo, 'hardy', 0)).toEqual({
      aggression: 82,
      skittishness: 75,
      appetite: 20,
    })
  })

  it('applies the nature before reading the stats', () => {
    // Modest raises special attack: an angrier Mewtwo.
    expect(temperamentFrom(mewtwo, 'modest', 0).aggression).toBeGreaterThan(82)
    // Timid raises speed: a jumpier one.
    expect(temperamentFrom(mewtwo, 'timid', 0).skittishness).toBeGreaterThan(75)
  })

  // A missing `/pokemon` response must never block a spawn: the temperament falls back to
  // middling stats rather than to nothing.
  it('falls back to a neutral reading without stats or happiness', () => {
    expect(temperamentFrom(undefined, 'hardy', undefined)).toEqual({
      aggression: 50,
      skittishness: 50,
      appetite: 50,
    })
  })

  it('starts rarer Pokémon on edge, and a tracked one more so', () => {
    const t = { aggression: 50, skittishness: 50, appetite: 50 }
    expect(initialMood(t, 'legendary').nervousness).toBeGreaterThan(initialMood(t, 'common').nervousness)
    expect(initialMood(t, 'legendary', 2).nervousness).toBe(initialMood(t, 'legendary').nervousness + 20)
  })
})

describe('reactions', () => {
  const rare = () => wild({ captureRate: 45, rarity: 'rare' })
  const withBall = (encounter: WildEncounter, extra: Partial<CompanionState> = {}) =>
    state({ inventory: { pokeBall: 5 }, wild: [encounter], usedSinceInstall: 100_000_000, ...extra })
  const afterMiss = (encounter: WildEncounter) =>
    takeTurn(
      withBall(encounter),
      encounter.id,
      { kind: 'throw', ball: 'pokeBall' },
      sequence(MISS, STAY),
      NOW,
    ).state.wild[0]!

  it('a miss makes it angrier and jumpier, and costs trust', () => {
    const before = moodOf(rare())
    const after = moodOf(afterMiss(rare()))
    expect(after.anger).toBeGreaterThan(before.anger)
    expect(after.nervousness).toBeGreaterThan(before.nervousness)
    expect(after.trust).toBe(Math.max(0, before.trust + MoodBalance.missTrust))
  })

  // [trigger branch] The thresholds stack: flee below `flee`, attack below `flee + attack`, stay
  // above. One roll either side of each edge pins the comparison, so `<` cannot become `<=`.
  it('flees just under the flee threshold and attacks right at it', () => {
    const missed = afterMiss(rare())
    const flee = fleePermille(missed)
    const fled = takeTurn(
      withBall(rare()),
      'w1',
      { kind: 'throw', ball: 'pokeBall' },
      sequence(MISS, flee - 1),
      NOW,
    )
    expect(fled.outcome).toMatchObject({ kind: 'fled', via: 'throw' })
    const attacked = takeTurn(
      withBall(rare()),
      'w1',
      { kind: 'throw', ball: 'pokeBall' },
      sequence(MISS, flee),
      NOW,
    )
    expect(attacked.outcome).toMatchObject({
      kind: 'broke',
      attack: { stolen: StealBalance.amount.rare },
    })
  })

  it('stays, without attacking, once the roll clears both thresholds', () => {
    const missed = afterMiss(rare())
    const clear = fleePermille(missed) + attackPermille(missed)
    const stayed = takeTurn(
      withBall(rare()),
      'w1',
      { kind: 'throw', ball: 'pokeBall' },
      sequence(MISS, clear),
      NOW,
    )
    expect(stayed.outcome).toEqual({ kind: 'broke', shakes: 0 })
  })

  // [trigger branch] The reaction reads the mood the miss left behind, not the mood before it — a
  // roll between the two flee thresholds tells them apart.
  it('rolls the reaction against the mood after the miss', () => {
    const before = fleePermille(rare())
    const after = fleePermille(afterMiss(rare()))
    expect(after).toBeGreaterThan(before + 1)
    const outcome = takeTurn(
      withBall(rare()),
      'w1',
      { kind: 'throw', ball: 'pokeBall' },
      sequence(MISS, before + 1),
      NOW,
    )
    expect(outcome.outcome.kind).toBe('fled')
  })

  // Even a frantic Pokémon stays more likely to stay than to run, and a legendary less so still.
  it('tops out below even odds, and lower for a legendary', () => {
    const frantic = { anger: 0, nervousness: 100, trust: 0 }
    expect(fleePermille(wild({ mood: frantic }))).toBe(380)
    expect(fleePermille(wild({ rarity: 'legendary', mood: frantic }))).toBe(
      Math.round(380 * MoodBalance.legendaryFleeFactor),
    )
  })

  it('is far less likely to bolt while eating', () => {
    const e = wild({ mood: { anger: 0, nervousness: 20, trust: 0 } })
    expect(fleePermille(e)).toBe(100)
    expect(fleePermille(e, true)).toBe(25)
  })
})

describe('berries', () => {
  const offer = (
    encounter: WildEncounter,
    berry: 'oranBerry' | 'nanabBerry' | 'razzBerry',
    rng = sequence(STAY),
  ) =>
    takeTurn(
      state({ inventory: { [berry]: 2, pokeBall: 2 }, wild: [encounter] }),
      encounter.id,
      { kind: 'feed', berry },
      rng,
      NOW,
    )

  it('an Oran Berry calms its anger and earns trust, scaled by appetite', () => {
    const angry = { anger: 60, nervousness: 10, trust: 0 }
    const greedy = offer(
      wild({ mood: angry, temperament: { aggression: 50, skittishness: 50, appetite: 100 } }),
      'oranBerry',
    )
    const picky = offer(
      wild({ mood: angry, temperament: { aggression: 50, skittishness: 50, appetite: 0 } }),
      'oranBerry',
    )
    expect(greedy.outcome).toEqual({ kind: 'fed', berry: 'oranBerry' })
    expect(moodOf(greedy.state.wild[0]!)).toEqual({ anger: 30, nervousness: 5, trust: 20 })
    expect(moodOf(picky.state.wild[0]!)).toEqual({ anger: 45, nervousness: 5, trust: 10 })
    expect(greedy.state.inventory['oranBerry']).toBe(1)
  })

  it('a Nanab Berry settles its nerves', () => {
    const jumpy = wild({
      mood: { anger: 0, nervousness: 60, trust: 0 },
      temperament: { aggression: 50, skittishness: 50, appetite: 100 },
    })
    expect(moodOf(offer(jumpy, 'nanabBerry').state.wild[0]!).nervousness).toBe(30)
  })

  // [trigger branch] The Razz Berry's boost belongs to one throw. Kept past it, every later ball
  // would ride a berry eaten long ago.
  it('a Razz Berry boosts exactly one throw', () => {
    const fed = offer(wild({ captureRate: 45 }), 'razzBerry').state
    expect(fed.wild[0]!.primed).toBe(true)
    const boosted = encounterCatchChance(fed.wild[0]!, 'pokeBall')
    const thrown = takeTurn(
      fed,
      'w1',
      { kind: 'throw', ball: 'pokeBall' },
      sequence(MISS, STAY),
      NOW,
    ).state
    expect(thrown.wild[0]!.primed).toBeUndefined()
    expect(encounterCatchChance(thrown.wild[0]!, 'pokeBall')).toBeLessThan(boosted)
  })

  it('a berry turn can still end in a flight', () => {
    const outcome = offer(
      wild({ mood: { anger: 0, nervousness: 100, trust: 0 } }),
      'nanabBerry',
      sequence(0),
    ).outcome
    expect(outcome).toEqual({ kind: 'fled', shakes: 0, via: 'feed', trailed: false })
  })

  it('spends nothing when the bag holds none of that berry', () => {
    const before = state({ inventory: {}, wild: [wild()] })
    const result = takeTurn(before, 'w1', { kind: 'feed', berry: 'razzBerry' }, sequence(STAY), NOW)
    expect(result.outcome).toEqual({ kind: 'noItem' })
    expect(result.state).toBe(before)
  })
})

describe('attacks', () => {
  const furious = (over: Partial<WildEncounter> = {}) =>
    wild({ captureRate: 45, rarity: 'rare', mood: { anger: 100, nervousness: 0, trust: 0 }, ...over })
  // The reaction reads the mood the miss leaves, so the attack band starts at *that* flee threshold.
  const turn = (s: CompanionState) => {
    const missed = takeTurn(s, 'w1', { kind: 'throw', ball: 'pokeBall' }, sequence(MISS, STAY), NOW).state
      .wild[0]!
    return takeTurn(
      s,
      'w1',
      { kind: 'throw', ball: 'pokeBall' },
      sequence(MISS, fleePermille(missed)),
      NOW,
    )
  }

  it('takes its amount from the wallet, never from growth, and gets angrier', () => {
    const before = state({
      inventory: { pokeBall: 1 },
      wild: [furious({ mood: { anger: 50, nervousness: 0, trust: 0 } })],
      usedSinceInstall: 50_000_000,
    })
    const flee = fleePermille(
      takeTurn(before, 'w1', { kind: 'throw', ball: 'pokeBall' }, sequence(MISS, STAY), NOW).state
        .wild[0]!,
    )
    const result = takeTurn(before, 'w1', { kind: 'throw', ball: 'pokeBall' }, sequence(MISS, flee), NOW)
    expect(result.outcome).toMatchObject({ kind: 'broke', attack: { stolen: StealBalance.amount.rare } })
    expect(result.state.spentTokens).toBe(StealBalance.amount.rare)
    expect(result.state.usedSinceInstall).toBe(50_000_000)
    expect(result.state.wild[0]!.stolen).toBe(StealBalance.amount.rare)
  })

  // [trigger branch] Bounded by what is spendable: an attack must never push the balance negative.
  it('takes no more than the wallet holds, and nothing from an empty one', () => {
    const thin = turn(state({ inventory: { pokeBall: 1 }, wild: [furious()], usedSinceInstall: 300_000 }))
    expect(thin.outcome).toMatchObject({ attack: { stolen: 300_000 } })
    const empty = turn(state({ inventory: { pokeBall: 1 }, wild: [furious()], usedSinceInstall: 0 }))
    expect(empty.outcome).toMatchObject({ attack: { stolen: 0 } })
    expect(empty.state.spentTokens).toBe(0)
  })

  it('takes no more than its per-encounter cap from one Pokémon', () => {
    const cap = StealBalance.amount.rare * StealBalance.perEncounter
    const result = turn(
      state({ inventory: { pokeBall: 1 }, wild: [furious({ stolen: cap })], usedSinceInstall: 1e10 }),
    )
    expect(result.outcome).toMatchObject({ attack: { stolen: 0 } })
  })

  it('pays back what it took when you catch it', () => {
    const thief = furious({ stolen: 3_000_000 })
    const result = takeTurn(
      state({
        inventory: { masterBall: 1 },
        wild: [thief],
        usedSinceInstall: 1e10,
        spentTokens: 5_000_000,
      }),
      'w1',
      { kind: 'throw', ball: 'masterBall' },
      sequence(STAY),
      NOW,
    )
    expect(result.outcome).toEqual({
      kind: 'caught',
      shakes: 4,
      refunded: 3_000_000,
      registeredPercent: 5,
    })
    expect(result.state.spentTokens).toBe(2_000_000)
  })
})

describe('the legendary trail', () => {
  const legendary = (over: Partial<WildEncounter> = {}) =>
    wild({
      id: 'mew',
      speciesID: 150,
      captureRate: 3,
      rarity: 'legendary',
      isShiny: true,
      nature: 'timid',
      temperament: { aggression: 80, skittishness: 70, appetite: 30 },
      types: ['psychic'],
      ...over,
    })
  const flee = (encounter: WildEncounter) =>
    takeTurn(
      state({ inventory: { pokeBall: 1 }, wild: [encounter] }),
      encounter.id,
      { kind: 'throw', ball: 'pokeBall' },
      sequence(MISS, 0),
      NOW,
    )

  // A catch obtains the species: the registry says so from this moment, as the seed says it for
  // a catch made before the registry existed. The 5% of registration is phase 3's.
  it('a catch unlocks the species and counts it', () => {
    const target = wild()
    const caught = takeTurn(
      state({ inventory: { masterBall: 1 }, wild: [target] }),
      'w1',
      { kind: 'throw', ball: 'masterBall' },
      sequence(STAY),
      NOW,
    )
    expect(caught.outcome.kind).toBe('caught')
    expect(caught.state.species[target.speciesID]).toMatchObject({ unlocked: true, caught: 1 })
    const again = takeTurn(
      { ...caught.state, inventory: { masterBall: 1 }, wild: [wild({ id: 'w2' })] },
      'w2',
      { kind: 'throw', ball: 'masterBall' },
      sequence(STAY),
      NOW,
    )
    expect(again.state.species[target.speciesID]?.caught).toBe(2)
  })

  it('a legendary that flees leaves tracks; a common does not', () => {
    const gone = flee(legendary())
    expect(gone.outcome).toMatchObject({ kind: 'fled', trailed: true })
    expect(gone.state.legendaryTrail.map((e) => e.id)).toEqual(['mew'])
    // The terrain it is met on comes back with it, so the trail has to carry its types.
    expect(gone.state.legendaryTrail[0]!.types).toEqual(['psychic'])
    expect(flee(wild()).state.legendaryTrail).toEqual([])
  })

  // [trigger branch] Running away is a choice; a track after it would be a paid mood reset.
  it('running away leaves no tracks', () => {
    expect(runFromEncounter(state({ wild: [legendary()] }), 'mew').legendaryTrail).toEqual([])
  })

  it('one that wanders off leaves tracks too, and cold tracks are cleared', () => {
    const expired = expireQueue(
      state({ wild: [legendary({ appearedAt: NOW - RARE_ENCOUNTER_EXPIRY_MS })] }),
      NOW,
    )
    expect(expired.wild).toEqual([])
    expect(expired.legendaryTrail.map((e) => e.id)).toEqual(['mew'])
    expect(expireQueue(expired, NOW + TrailBalance.windowMs).legendaryTrail).toEqual([])
  })

  it('a legendary tracked to the limit leaves no more tracks', () => {
    expect(flee(legendary({ trackedCount: TrailBalance.maxTracks })).state.legendaryTrail).toEqual([])
  })

  const trail = (over: Partial<TrailEntry> = {}): TrailEntry => ({
    id: 'mew',
    speciesID: 150,
    captureRate: 3,
    isShiny: true,
    nature: 'timid',
    temperament: { aggression: 80, skittishness: 70, appetite: 30 },
    types: ['psychic'],
    trackedCount: 0,
    lostAt: NOW,
    ...over,
  })

  it('tracking brings the same Pokémon back, more nervous, for a doubling price', () => {
    const before = state({ legendaryTrail: [trail({ trackedCount: 1 })], usedSinceInstall: 1e10 })
    const result = trackLegendary(before, 'mew', NOW)
    expect(result.outcome).toBe('tracked')
    expect(result.state.spentTokens).toBe(TrailBalance.basePrice * 2)
    expect(result.state.legendaryTrail).toEqual([])
    const back = result.state.wild[0]!
    expect(back).toMatchObject({
      speciesID: 150,
      isShiny: true,
      nature: 'timid',
      rarity: 'legendary',
      trackedCount: 2,
      types: ['psychic'],
    })
    expect(moodOf(back).nervousness).toBe(initialMood(back.temperament!, 'legendary').nervousness + 20)
    expect(trailPrice({ trackedCount: 2 })).toBe(TrailBalance.basePrice * 4)
  })

  it.each([
    ['unknown', state({ legendaryTrail: [trail()], usedSinceInstall: 1e10 }), 'nope', NOW],
    [
      'expired',
      state({ legendaryTrail: [trail()], usedSinceInstall: 1e10 }),
      'mew',
      NOW + TrailBalance.windowMs,
    ],
    [
      'cantAfford',
      state({ legendaryTrail: [trail()], usedSinceInstall: TrailBalance.basePrice - 1 }),
      'mew',
      NOW,
    ],
    [
      'noRoom',
      state({
        legendaryTrail: [trail()],
        usedSinceInstall: 1e10,
        wild: Array.from({ length: EncounterBalance.maxQueue }, (_, i) => wild({ id: `q${i}` })),
      }),
      'mew',
      NOW,
    ],
  ] as const)('refuses %s and charges nothing', (outcome, before, id, now) => {
    const result = trackLegendary(before, id, now)
    expect(result.outcome).toBe(outcome)
    expect(result.state).toBe(before)
  })
})

describe('item finds', () => {
  // [trigger branch] The cheap first threshold exists to put a wild Pokémon on screen early; a
  // find there would spend the moment on a Poké Ball.
  it('the very first arrival is always a Pokémon', () => {
    expect(spawnKind(fixedRNG(999), true)).toBe('pokemon')
    expect(spawnKind(fixedRNG(999), false)).toBe('find')
  })

  it('a low draw is a Pokémon, so "nothing special" stays the ordinary outcome', () => {
    expect(spawnKind(fixedRNG(0), false)).toBe('pokemon')
    expect(spawnKind(fixedRNG(1_000 - EncounterBalance.findShare - 1), false)).toBe('pokemon')
    expect(spawnKind(fixedRNG(1_000 - EncounterBalance.findShare), false)).toBe('find')
  })

  it('rolls a rarity, then what is inside it — never a Master Ball', () => {
    expect(rollFind(fixedRNG(0, 0), 'f', NOW)).toEqual({
      id: 'f',
      item: 'pokeBall',
      count: 1,
      rarity: 'common',
      appearedAt: NOW,
    })
    expect(rollFind(fixedRNG(999, 0), 'f', NOW)).toMatchObject({
      item: 'ultraBall',
      count: 3,
      rarity: 'legendary',
    })
    for (let r = 0; r < 1000; r += 7) {
      for (let w = 0; w < 6; w++) expect(rollFind(fixedRNG(r, w), 'f', NOW).item).not.toBe('masterBall')
    }
  })

  const find = (over: Partial<WildFind> = {}): WildFind => ({
    id: 'f1',
    item: 'greatBall',
    count: 2,
    rarity: 'uncommon',
    appearedAt: NOW,
    ...over,
  })

  it('picking one up puts it in the bag and takes it out of the queue', () => {
    const after = collectFind(
      state({ inventory: { greatBall: 1 }, finds: [find(), find({ id: 'f2' })] }),
      'f1',
    )!
    expect(after.inventory['greatBall']).toBe(3)
    expect(after.finds.map((f) => f.id)).toEqual(['f2'])
  })

  it('a stale id picks up nothing', () => {
    expect(collectFind(state({ finds: [find()] }), 'nope')).toBeUndefined()
  })

  it('picks everything up at once', () => {
    const after = collectAllFinds(
      state({ inventory: {}, finds: [find(), find({ id: 'f2', item: 'razzBerry', count: 1 })] }),
    )
    expect(after.finds).toEqual([])
    expect(after.inventory).toEqual({ greatBall: 2, razzBerry: 1 })
  })

  it('finds wander off on the same clock as Pokémon', () => {
    const expired = expireQueue(
      state({ finds: [find({ rarity: 'common', appearedAt: NOW - ENCOUNTER_EXPIRY_MS })] }),
      NOW,
    )
    expect(expired.finds).toEqual([])
  })
})

describe('the full-queue notice', () => {
  const filled = (n: number, armed: boolean) =>
    state({ queueFullArmed: armed, wild: Array.from({ length: n }, (_, i) => wild({ id: `q${i}` })) })

  // [trigger branch] An edge, not a level: a queue that sits full announces itself once, not on
  // every refresh while it stays full.
  it('fires once when the queue fills, not again while it stays full', () => {
    const first = queueFullEdge(filled(EncounterBalance.maxQueue, true))
    expect(first.fire).toBe(true)
    const again = queueFullEdge(first.state)
    expect(again.fire).toBe(false)
  })

  it('re-arms once a slot frees, and fires again on the next fill', () => {
    const drained = queueFullEdge(filled(EncounterBalance.maxQueue - 1, false))
    expect(drained).toMatchObject({ fire: false, state: { queueFullArmed: true } })
    expect(
      queueFullEdge({ ...drained.state, wild: filled(EncounterBalance.maxQueue, true).wild }).fire,
    ).toBe(true)
  })

  it('counts finds toward the queue', () => {
    const half = Math.floor(EncounterBalance.maxQueue / 2)
    const mixed = state({
      wild: Array.from({ length: half }, (_, i) => wild({ id: `q${i}` })),
      finds: Array.from({ length: EncounterBalance.maxQueue - half }, (_, i) => ({
        id: `f${i}`,
        item: 'pokeBall' as const,
        count: 1,
        rarity: 'common' as const,
        appearedAt: NOW,
      })),
    })
    expect(queueFullEdge(mixed).fire).toBe(true)
  })
})

describe('throwBall', () => {
  const withBall = (kind: string, count: number, wilds: WildEncounter[]) =>
    state({ inventory: { [kind]: count }, wild: wilds })

  // [trigger branch] The webview is a separate bundle and can be stale after an update; a
  // renamed or resolved id must not index into the queue.
  it('fails closed on an unknown encounter id', () => {
    const before = withBall('pokeBall', 3, [wild({ id: 'w1' })])
    const result = throwBall(before, 'nope', 'pokeBall', fixedRNG(0), NOW)

    expect(result.outcome).toEqual({ kind: 'unknownEncounter' })
    expect(result.state).toBe(before)
  })

  // [trigger branch] Decrementing before the check would spend a ball the player does not own
  // and leave the count negative.
  it('spends nothing when the bag is empty', () => {
    const before = withBall('pokeBall', 0, [wild()])
    const result = throwBall(before, 'w1', 'pokeBall', fixedRNG(0), NOW)

    expect(result.outcome).toEqual({ kind: 'noItem' })
    expect(result.state.inventory['pokeBall']).toBe(0)
    expect(result.state.wild).toHaveLength(1)
  })

  it('spends the ball, files a dex entry and clears the encounter on a catch', () => {
    const before = withBall('pokeBall', 2, [
      wild({ speciesID: 25, names: { en: 'Pikachu' }, nature: 'jolly' }),
    ])
    const result = throwBall(before, 'w1', 'pokeBall', fixedRNG(0), NOW)

    expect(result.outcome).toEqual({ kind: 'caught', shakes: 4, refunded: 0, registeredPercent: 5 })
    expect(result.state.inventory['pokeBall']).toBe(1)
    expect(result.state.wild).toHaveLength(0)
    expect(result.state.dex).toHaveLength(1)

    const entry = result.state.dex[0]!
    expect(entry.source).toBe('wild')
    expect(entry.baseID).toBe(25)
    expect(entry.finalID).toBe(25)
    expect(entry.chainOrder).toEqual([25])
    expect(entry.caughtAt).toBe(NOW)
    expect(entry.nature).toBe('jolly')
    expect(entry.names).toEqual({ 25: { en: 'Pikachu' } })
  })

  // [trigger branch] `collectedFinals` steers evolution-branch diversity in
  // `pickPlannedChild`. A single wild species is not a completed line, and adding it would
  // quietly bias every future hatch away from a branch never actually raised.
  it('never touches collectedFinals on a wild catch', () => {
    const before = withBall('pokeBall', 1, [wild({ speciesID: 25 })])
    const result = throwBall(before, 'w1', 'pokeBall', fixedRNG(0), NOW)

    expect(result.outcome.kind).toBe('caught')
    expect(result.state.collectedFinals).toEqual([])
  })

  it('records the throw and keeps the encounter when the ball breaks and it stays', () => {
    const encounter = wild({ captureRate: 45, rarity: 'rare' })
    const b = shakeThreshold(catchValue(45, 'pokeBall', moodOf(encounter)))
    // Three shake rolls, a failure, then a reaction roll that clears both thresholds.
    const result = throwBall(
      withBall('pokeBall', 1, [encounter]),
      'w1',
      'pokeBall',
      sequence(0, 0, 0, b, STAY),
      NOW,
    )

    expect(result.outcome).toEqual({ kind: 'broke', shakes: 3 })
    expect(result.state.wild).toHaveLength(1)
    expect(result.state.wild[0]!.throws).toBe(1)
    expect(result.state.inventory['pokeBall']).toBe(0)
  })

  it('removes the encounter when it flees after a failed throw', () => {
    const encounter = wild({ captureRate: 45, rarity: 'rare' })
    const result = throwBall(
      withBall('pokeBall', 1, [encounter]),
      'w1',
      'pokeBall',
      sequence(MISS, 0),
      NOW,
    )

    expect(result.outcome).toEqual({ kind: 'fled', shakes: 0, via: 'throw', trailed: false })
    expect(result.state.wild).toHaveLength(0)
    expect(result.state.dex).toHaveLength(0)
  })

  it('leaves the other encounters in the queue alone', () => {
    const before = withBall('pokeBall', 1, [wild({ id: 'a' }), wild({ id: 'b' })])
    const result = throwBall(before, 'a', 'pokeBall', fixedRNG(0), NOW)
    expect(result.state.wild.map((e) => e.id)).toEqual(['b'])
  })
})

describe('runFromEncounter', () => {
  it('discards the encounter without spending a ball', () => {
    const before = state({ inventory: { pokeBall: 2 }, wild: [wild({ id: 'a' }), wild({ id: 'b' })] })
    const after = runFromEncounter(before, 'a')

    expect(after.wild.map((e) => e.id)).toEqual(['b'])
    expect(after.inventory['pokeBall']).toBe(2)
    expect(after.dex).toHaveLength(0)
  })

  it('is a no-op for an unknown id', () => {
    const before = state({ wild: [wild({ id: 'a' })] })
    expect(runFromEncounter(before, 'nope')).toBe(before)
  })
})

// The wallet is `spendableBalance` and nothing else: what was used, plus what was earned, minus
// what was spent. Two encounter paths once read `usedSinceInstall − spentTokens` inline, which
// silently ignored `earnedTokens` — a wallet the shop accepted but a trail refused.
describe('the wallet encounters spend from', () => {
  const lost: TrailEntry = {
    id: 'mew',
    speciesID: 150,
    captureRate: 3,
    isShiny: false,
    nature: 'timid',
    temperament: { aggression: 50, skittishness: 50, appetite: 50 },
    types: ['psychic'],
    trackedCount: 0,
    lostAt: NOW,
  }

  // [trigger branch] Usage alone could not pay; only the earned tokens make the price.
  it('lets earned tokens pay for a trail', () => {
    const before = state({
      legendaryTrail: [lost],
      usedSinceInstall: 0,
      earnedTokens: TrailBalance.basePrice,
    })
    const result = trackLegendary(before, 'mew', NOW)
    expect(result.outcome).toBe('tracked')
    expect(result.state.spentTokens).toBe(TrailBalance.basePrice)
  })

  // [trigger branch] Spent beyond usage, still solvent through earnings: the attack takes what
  // the wallet holds — not zero, as usage minus spent would say, and not the full amount.
  it('lets an attack take exactly the wallet, earnings included', () => {
    const wallet = 300_000
    const before = state({ usedSinceInstall: 1_000_000, spentTokens: 1_200_000, earnedTokens: 500_000 })
    expect(stealAmount(before, wild({ rarity: 'rare' }))).toBe(wallet)
  })
})

describe('catching registers', () => {
  const catchOne = (s: CompanionState, target: WildEncounter = wild()) =>
    takeTurn(
      { ...s, inventory: { masterBall: 1 }, wild: [target] },
      target.id,
      { kind: 'throw', ball: 'masterBall' },
      sequence(STAY),
      NOW,
    )
  const known = (over: Partial<SpeciesProgress> = {}): SpeciesProgress => ({
    ...freshSpeciesProgress(),
    threshold: 10_000_000,
    ...over,
  })

  // [trigger branch] A first catch with the line known: the share goes straight to the bar.
  it('registers a share of a new species whose threshold is known', () => {
    const result = catchOne(state({ species: { 10: known({ seen: true }) } }))
    expect(result.state.species[10]).toMatchObject({ unlocked: true, caught: 1, xp: 500_000 })
    expect(result.outcome).toMatchObject({ kind: 'caught', registeredPercent: 5 })
    expect(result.state.earnedTokens).toBe(0)
  })

  // [trigger branch] No line yet: the share is owed, and the Pokédex already reads it.
  it('owes the share of a species never raised, and shows it', () => {
    const result = catchOne(state())
    const progress = result.state.species[10]!
    expect(progress).toMatchObject({ unlocked: true, xp: 0, pendingShare: EconomyBalance.catchShare })
    expect(registrationPercent(progress)).toBe(5)
    expect(result.outcome).toMatchObject({ registeredPercent: 5 })
  })

  // [trigger branch] Already obtained: tokens from the table, into `earnedTokens`, and no xp. With
  // nothing spent, a reward taken off `spentTokens` would clamp to zero and vanish.
  it('pays a duplicate from the table and adds no experience', () => {
    const owned = known({ unlocked: true, caught: 1, xp: 500_000 })
    const result = catchOne(state({ species: { 10: owned }, spentTokens: 0 }))
    expect(result.state.earnedTokens).toBe(EconomyBalance.duplicateReward.common)
    expect(result.state.species[10]).toMatchObject({ xp: 500_000, caught: 2 })
    expect(result.state.species[10]?.pendingShare).toBeUndefined()
    expect(result.outcome).toMatchObject({ reward: EconomyBalance.duplicateReward.common })
    expect(result.outcome).not.toHaveProperty('registeredPercent')
    const rare = catchOne(state({ species: { 10: owned } }), wild({ rarity: 'rare' }))
    expect(rare.state.earnedTokens).toBe(EconomyBalance.duplicateReward.rare)
  })

  // [trigger branch] A threshold where 5% is not a whole number: rounding down would read 4%.
  it('reads the full share whatever the threshold', () => {
    const odd = known({ seen: true, threshold: 16_666_667 })
    const result = catchOne(state({ species: { 10: odd } }))
    expect(result.outcome).toMatchObject({ registeredPercent: 5 })
    expect(registrationPercent(result.state.species[10]!)).toBe(5)
  })

  it('never takes a species past its bar with the share', () => {
    const nearly = known({ seen: true, xp: 9_800_000 })
    expect(catchOne(state({ species: { 10: nearly } })).state.species[10]?.xp).toBe(10_000_000)
  })

  it('marks the shiny form obtained when a shiny is caught', () => {
    expect(catchOne(state(), wild({ isShiny: true })).state.species[10]?.shinyUnlocked).toBe(true)
    expect(catchOne(state()).state.species[10]?.shinyUnlocked).toBeUndefined()
  })

  // [trigger branch] Caught a shiny of the companion's own species: the companion wears it, as
  // it does when the bar fills by playing or by a boost.
  it('dresses the companion when a shiny of its species is caught', () => {
    const active = {
      baseID: 10,
      pathIDs: [10],
      plannedPathIDs: [10],
      stageIndex: 0,
      usedAtStage: 0,
      rarity: 'common' as const,
      totalForms: 1,
      isShiny: false,
      dittoRevealed: false,
    }
    const owned = known({ unlocked: true, lineRarity: 'common' })
    const result = catchOne(state({ active, species: { 10: owned } }), wild({ isShiny: true }))
    expect(result.state.active?.isShiny).toBe(true)
  })

  // [trigger branch] A shiny caught completes its shiny bar at once (C5): the draw still pays,
  // duplicate or not, with the bar full when the line's rarity is known.
  it('completes the shiny bar of a shiny caught', () => {
    const owned = known({ unlocked: true, lineRarity: 'common' })
    const result = catchOne(state({ species: { 10: owned } }), wild({ isShiny: true }))
    expect(result.state.species[10]).toMatchObject({
      shinyRegistered: true,
      shinyXP: 8 * PokemonBalance.graduationTotal('common'),
    })
    expect(catchOne(state(), wild({ isShiny: true })).state.species[10]?.shinyRegistered).toBe(true)
  })
})

describe('catching an evolved form', () => {
  const evolved = (over: Partial<WildEncounter> = {}) =>
    wild({
      speciesID: 6,
      rarity: 'rare',
      line: { baseID: 4, stageIndex: 2, totalForms: 3, rarity: 'uncommon' },
      ...over,
    })
  const catchIt = (s: CompanionState, target: WildEncounter) =>
    takeTurn(
      { ...s, inventory: { masterBall: 1 }, wild: [target] },
      target.id,
      { kind: 'throw', ball: 'masterBall' },
      sequence(STAY),
      NOW,
    )

  // [trigger branch] The encounter knows where the form sits, so the share lands as experience
  // at once — priced by the line's rarity and stage — instead of waiting as `pendingShare`.
  it('registers its share against its place in the line', () => {
    const result = catchIt(state(), evolved())
    const threshold = PokemonBalance.phaseThreshold('uncommon', 3, 2)
    expect(result.state.species[6]).toMatchObject({
      unlocked: true,
      threshold,
      baseID: 4,
      stageIndex: 2,
      totalForms: 3,
      lineRarity: 'uncommon',
      xp: Math.ceil(EconomyBalance.catchShare * threshold),
    })
    expect(result.state.species[6]?.pendingShare).toBeUndefined()
  })

  // [trigger branch] A duplicate pays by the line's rarity, not the form's own.
  it('pays a duplicate by the line’s rarity', () => {
    const owned = { 6: { ...freshSpeciesProgress(), unlocked: true } }
    const result = catchIt(state({ species: owned }), evolved())
    expect(result.state.earnedTokens).toBe(EconomyBalance.duplicateReward.uncommon)
  })
})

describe('catching the lured species', () => {
  // [trigger branch] The lure has done its job: catching its target ends it, while catching
  // anything else leaves it running.
  it('ends the lure on catching its target, and only then', () => {
    const lure = { speciesID: 10, baseID: 10, stageIndex: 0, until: NOW + 1_000_000 }
    const go = (s: CompanionState, target: WildEncounter) =>
      takeTurn(
        { ...s, inventory: { masterBall: 1 }, wild: [target] },
        target.id,
        { kind: 'throw', ball: 'masterBall' },
        sequence(STAY),
        NOW,
      )
    expect(go(state({ lure }), wild()).state.lure).toBeUndefined()
    expect(go(state({ lure }), wild({ speciesID: 11 })).state.lure).toEqual(lure)
  })
})
