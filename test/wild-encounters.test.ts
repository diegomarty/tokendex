import { describe, expect, it } from 'vitest'
import {
  Capture,
  EncounterBalance,
  addEncounterUsage,
  catchChance,
  catchValue,
  encounterThresholdFor,
  ENCOUNTER_EXPIRY_MS,
  RARE_ENCOUNTER_EXPIRY_MS,
  enqueueEncounter,
  grantLegendaryEncounter,
  withoutWanderedOff,
  fleeChance,
  owedEncounters,
  payForEncounter,
  resolveThrow,
  runFromEncounter,
  shakeThreshold,
  throwBall,
  tokensToNextEncounter,
} from '../src/core/companion/encounters.js'
import {
  type CompanionState,
  type WildEncounter,
  freshCompanionState,
} from '../src/core/companion/model.js'

/** Deterministic RNG so every roll in a throw is pinned. */
const fixedRNG = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

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

  // [trigger branch] Without the ceiling a dev scenario granting 1.5B owes ~600 encounters and
  // keeps minting them out of one injection; the queue only holds 12, so banking more is
  // meaningless as well as unbounded.
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

  // An IOU the spawn path pays out for ever: a runaway trigger must not become a faucet.
  it('never owes more than a queue could ever hold', () => {
    let owing = state()
    for (let i = 0; i < 50; i++) owing = grantLegendaryEncounter(owing)
    expect(owing.owedLegendaryEncounters).toBe(EncounterBalance.maxQueue)
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

  // [trigger branch] Without the cap, a 235+ species was a guaranteed wobble-less catch with
  // the cheapest ball; the guaranteed catch is the Master Ball's job and nobody else's.
  it('caps every ball short of the Master below certainty', () => {
    expect(catchValue(255, 'pokeBall')).toBe(Capture.maxCatchValue)
    expect(catchValue(200, 'ultraBall')).toBe(Capture.maxCatchValue)
    expect(catchValue(3, 'masterBall')).toBe(255)
  })

  it('never returns less than 1', () => {
    expect(catchValue(0, 'pokeBall')).toBe(1)
  })

  it('is monotonic in ball tier', () => {
    const values = (['pokeBall', 'greatBall', 'ultraBall'] as const).map((b) => catchValue(3, b))
    expect(values).toEqual([...values].sort((a, b) => a - b))
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
  // Ball can reach 255 at all. Asserting the *outcome* would prove nothing (`shakeThreshold`
  // saturates at 255 anyway); what this pins is that no draw is spent.
  it('the Master Ball catches without consuming a roll', () => {
    const exploding = () => {
      throw new Error('resolveThrow drew a die for a guaranteed catch')
    }
    expect(resolveThrow(wild({ captureRate: 255 }), 'masterBall', exploding)).toEqual({
      caught: true,
      shakes: 4,
    })
  })

  // The cap's visible consequence: even a Caterpie can wobble out of a Poké Ball now.
  it('a full-rate species is no longer an automatic catch with a Poké Ball', () => {
    const b = shakeThreshold(catchValue(255, 'pokeBall'))
    expect(b).toBeLessThan(65_536)
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
    const b = shakeThreshold(catchValue(45, 'pokeBall'))
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
    expect(catchChance(255, 'pokeBall')).toBeLessThan(1)
  })

  // The rack shows these numbers; they must be the same maths the throw rolls. The pinned
  // values are the tuned difficulty curve — change `Capture` and these say what it did.
  it('matches the shake threshold raised to the four rolls', () => {
    const b = shakeThreshold(catchValue(45, 'pokeBall'))
    expect(catchChance(45, 'pokeBall')).toBeCloseTo(Math.pow(b / 65_536, 4), 10)
    expect(catchChance(255, 'pokeBall')).toBeCloseTo(0.83, 2) // common ceiling
    expect(catchChance(45, 'pokeBall')).toBeCloseTo(0.24, 2) // rare
    expect(catchChance(45, 'ultraBall')).toBeCloseTo(0.41, 2)
    expect(catchChance(3, 'pokeBall')).toBeCloseTo(0.036, 2) // legendary
  })

  it('is monotonic in ball tier', () => {
    const chances = (['pokeBall', 'greatBall', 'ultraBall', 'masterBall'] as const).map((b) =>
      catchChance(45, b),
    )
    expect(chances).toEqual([...chances].sort((a, b) => a - b))
  })
})

describe('fleeChance', () => {
  it('escalates with every throw and caps', () => {
    const first = fleeChance(wild({ throws: 0 }))
    const later = fleeChance(wild({ throws: 3 }))
    expect(later).toBeGreaterThan(first)
    expect(fleeChance(wild({ throws: 99, rarity: 'legendary' }))).toBeLessThanOrEqual(0.55)
  })

  it('makes rarer Pokémon skittish', () => {
    expect(fleeChance(wild({ rarity: 'legendary' }))).toBeGreaterThan(
      fleeChance(wild({ rarity: 'common' })),
    )
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

    expect(result.outcome).toEqual({ kind: 'noBall' })
    expect(result.state.inventory['pokeBall']).toBe(0)
    expect(result.state.wild).toHaveLength(1)
  })

  it('spends the ball, files a dex entry and clears the encounter on a catch', () => {
    const before = withBall('pokeBall', 2, [wild({ speciesID: 25, names: { en: 'Pikachu' } })])
    const result = throwBall(before, 'w1', 'pokeBall', fixedRNG(0), NOW)

    expect(result.outcome).toEqual({ kind: 'caught', shakes: 4 })
    expect(result.state.inventory['pokeBall']).toBe(1)
    expect(result.state.wild).toHaveLength(0)
    expect(result.state.dex).toHaveLength(1)

    const entry = result.state.dex[0]!
    expect(entry.source).toBe('wild')
    expect(entry.baseID).toBe(25)
    expect(entry.finalID).toBe(25)
    expect(entry.chainOrder).toEqual([25])
    expect(entry.caughtAt).toBe(NOW)
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
    const b = shakeThreshold(catchValue(45, 'pokeBall'))
    // Three shake rolls, a failure, then a flee roll that misses.
    const result = throwBall(
      withBall('pokeBall', 1, [encounter]),
      'w1',
      'pokeBall',
      fixedRNG(0, 0, 0, b, 999),
      NOW,
    )

    expect(result.outcome).toEqual({ kind: 'broke', shakes: 3 })
    expect(result.state.wild).toHaveLength(1)
    expect(result.state.wild[0]!.throws).toBe(1)
    expect(result.state.inventory['pokeBall']).toBe(0)
  })

  it('removes the encounter when it flees after a failed throw', () => {
    const encounter = wild({ captureRate: 45, rarity: 'rare' })
    const b = shakeThreshold(catchValue(45, 'pokeBall'))
    const result = throwBall(withBall('pokeBall', 1, [encounter]), 'w1', 'pokeBall', fixedRNG(b, 0), NOW)

    expect(result.outcome).toEqual({ kind: 'fled', shakes: 0 })
    expect(result.state.wild).toHaveLength(0)
    expect(result.state.dex).toHaveLength(0)
  })

  // [trigger branch] The flee roll must use the throw that just failed. Rolling it against the
  // pre-increment count makes the first miss safer than the design says, and the difference is
  // invisible unless the roll lands between the two chances.
  it('rolls the flee chance including the throw that just failed', () => {
    const encounter = wild({ captureRate: 45, rarity: 'rare' })
    const b = shakeThreshold(catchValue(45, 'pokeBall'))
    // 0.22 before this throw is counted, 0.30 after: a roll of 250 separates the two.
    const result = throwBall(
      withBall('pokeBall', 1, [encounter]),
      'w1',
      'pokeBall',
      fixedRNG(b, 250),
      NOW,
    )

    expect(result.outcome).toEqual({ kind: 'fled', shakes: 0 })
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
