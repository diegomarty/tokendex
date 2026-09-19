import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompanionStore, SaveBusyError } from '../src/core/companion/store.js'
import { FileLock, type LockHandle, lockPathFor } from '../src/core/coordination/fileLock.js'
import { buyItem } from '../src/core/companion/shop.js'
import {
  PokemonBalance,
  currentSpeciesID,
  makeEvoLine,
  type EvoNode,
} from '../src/core/companion/model.js'
import type { BaseSpecies, PokeProviding } from '../src/core/pokeapi.js'
import { BACKUP_FILE_PREFIX } from '../src/core/companion/saveTransfer.js'
import { EncounterBalance, MilestoneBalance } from '../src/core/companion/encounters.js'
import { Pokeball } from '../src/core/companion/model.js'
import { DEFAULT_TRAINER_ID } from '../src/core/companion/trainers.js'
import { sourceRoot } from './repoRoot.js'

const node = (id: number, children: EvoNode[] = []): EvoNode => ({ speciesID: id, children })

/** Stub provider: no network, deterministic lines. */
function stubProvider(over: Partial<PokeProviding> = {}): PokeProviding {
  return {
    line: async (baseID: number) =>
      makeEvoLine(baseID, node(baseID, [node(baseID + 1)]), 'common', {
        [baseID]: { en: `Base${baseID}` },
        [baseID + 1]: { en: `Evo${baseID}` },
      }),
    baseSpeciesIndex: async (): Promise<BaseSpecies[]> => [{ id: 1, captureRate: 255 }],
    baseSpecies: async (id: number) => ({ id, captureRate: 255 }),
    wildSpecies: async (id: number) => ({
      id,
      captureRate: 255,
      rarity: 'common' as const,
      names: { en: `Wild${id}` },
    }),
    ...over,
  }
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ptb-store-')), 'companion-state.json')
}

const store = (over: Partial<ConstructorParameters<typeof CompanionStore>[0]> = {}) =>
  new CompanionStore({
    provider: stubProvider(),
    filePath: tempFile(),
    now: () => 1_700_000_000_000,
    rng: () => 1, // never hits the 1-in-N rolls
    hostLanguage: 'en',
    dittoEnabled: false,
    ...over,
  })

const obs = (tokens: number, date = '2026-08-19') => ({
  todayTokensByProvider: { claude_code: tokens },
  todayDate: date,
  hasUsageData: true,
})

describe('update flow', () => {
  it('takes a baseline first without granting anything', async () => {
    const s = store()
    await s.update(obs(9_000_000))
    expect(s.snapshot().usedSinceInstall).toBe(0)
    expect(s.snapshot().eggUsage).toBe(0)
  })

  it('accrues into the egg after the baseline', async () => {
    const s = store()
    await s.update(obs(1_000))
    await s.update(obs(1_000 + 2_000_000))
    expect(s.snapshot().eggUsage).toBe(2_000_000)
    expect(s.snapshot().active).toBeUndefined() // below the hatch threshold
  })

  it('hatches once the threshold is crossed, carrying the overflow', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold + 777))
    const active = s.snapshot().active
    expect(active).toBeDefined()
    expect(active?.usedAtStage).toBe(777) // overflow carried into the hatchling
    expect(s.snapshot().eggUsage).toBe(0)
    expect(s.drainEvents().map((e) => e.kind)).toContain('hatched')
  })

  // Fixed at hatch like shininess. Without it the Mint would act on nothing.
  it('assigns a nature at hatch', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active?.nature).toBeDefined()
  })

  it('keeps the egg when the network is down', async () => {
    const failing = stubProvider({
      line: async () => {
        throw new Error('offline')
      },
      baseSpeciesIndex: async () => {
        throw new Error('offline')
      },
      baseSpecies: async () => {
        throw new Error('offline')
      },
    })
    const s = store({ provider: failing })
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active).toBeUndefined()
    // The usage is not lost, so the next tick hatches without re-earning it.
    expect(s.snapshot().eggUsage).toBeGreaterThanOrEqual(PokemonBalance.eggHatchThreshold)
  })

  // [trigger branch] Without the backoff, an offline user re-attempted the full sequential
  // PokéAPI chain inside every update() — with 8 s timeouts per request, long enough to
  // stall the scan the status bar is waiting on.
  it('backs off PokéAPI retries after a failure and recovers after the window', async () => {
    let clock = 1_700_000_000_000
    let attempts = 0
    const failing = stubProvider({
      line: async () => {
        attempts += 1
        throw new Error('offline')
      },
      baseSpeciesIndex: async () => {
        attempts += 1
        throw new Error('offline')
      },
      baseSpecies: async () => {
        attempts += 1
        throw new Error('offline')
      },
    })
    const s = store({ provider: failing, now: () => clock })
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold)) // first attempt fails
    expect(s.snapshot().active).toBeUndefined() // the egg survives, as before
    const afterFirst = attempts
    expect(afterFirst).toBeGreaterThan(0)

    clock += 30_000 // inside the 60 s backoff window
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(attempts).toBe(afterFirst) // no retry: the network is not hammered every tick

    clock += 31_000 // past the window
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(attempts).toBeGreaterThan(afterFirst) // the retry does come back
  })

  // [trigger branch] Hatching and encounter spawning both reach PokéAPI in the same pass. The
  // backoff means "the network is down", not "how many call sites noticed": two reports per pass
  // double the window twice, so the delay grows 4x per tick and reaches the 30-minute ceiling in
  // half the ticks. The symptom is a user who reconnects and is still made to wait.
  //
  // The test above already fails on the first doubling; this one pins the *growth*, so 60 s then
  // 120 s cannot quietly become 60 s then 480 s.
  it('doubles the backoff once per pass, however many paths fail', async () => {
    let clock = 1_700_000_000_000
    let attempts = 0
    const offline = stubProvider({
      line: async () => {
        throw new Error('offline')
      },
      baseSpeciesIndex: async () => {
        attempts += 1
        throw new Error('offline')
      },
      baseSpecies: async () => {
        throw new Error('offline')
      },
    })
    const s = store({ provider: offline, now: () => clock })
    await s.update(obs(0))
    // Enough for the egg to be ready *and* for encounters to be owed: both paths fail together.
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    const afterPassOne = attempts

    clock += 61_000 // past the 60 s window the first pass opened
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(attempts).toBeGreaterThan(afterPassOne)
    const afterPassTwo = attempts

    clock += 119_000 // inside the 120 s window the second pass opened
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(attempts).toBe(afterPassTwo)

    clock += 2_000 // and past it
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(attempts).toBeGreaterThan(afterPassTwo)
  })

  // `pendingHatchID` was documented as "pre-rolled while still an egg, removing network latency
  // at the hatch moment" but nothing ever wrote it, so every hatch paid a full round trip
  // inside update() — which the scan, and with it the status bar, awaits.
  describe('egg pre-roll', () => {
    const counting = () => {
      const calls = { index: 0, line: 0 }
      const provider = stubProvider({
        baseSpeciesIndex: async () => {
          calls.index += 1
          return [{ id: 1, captureRate: 255 }]
        },
        line: async (baseID: number) => {
          calls.line += 1
          return makeEvoLine(baseID, node(baseID, [node(baseID + 1)]), 'common', {
            [baseID]: { en: `Base${baseID}` },
            [baseID + 1]: { en: `Evo${baseID}` },
          })
        },
      })
      return { calls, store: store({ provider }) }
    }

    it('leaves a fresh egg alone', async () => {
      const { store: s } = counting()
      await s.update(obs(0))
      await s.update(obs(PokemonBalance.eggHatchThreshold * 0.25))
      expect(s.snapshot().pendingHatchID).toBeUndefined()
    })

    it('rolls the species once the egg is past halfway', async () => {
      const { calls, store: s } = counting()
      await s.update(obs(0))
      await s.update(obs(PokemonBalance.eggHatchThreshold * 0.75))
      expect(s.snapshot().pendingHatchID).toBe(1)
      expect(calls.line).toBe(1) // the line is warmed too, which is what makes the hatch free

      // And it is not re-rolled on every later tick: the species is decided once.
      await s.update(obs(PokemonBalance.eggHatchThreshold * 0.8))
      expect(s.snapshot().pendingHatchID).toBe(1)
      expect(calls.line).toBe(1)
    })

    // [trigger branch] A failed line warm must still open the backoff. Reporting success
    // there (the roll itself did work) would wipe the window the failure just opened, and an
    // offline user would be back to a full PokeAPI attempt on every single tick. Observed
    // through the *hatch* that follows, because that is what the backoff actually gates.
    it('opens the backoff when the line cannot be warmed, but keeps the roll', async () => {
      let clock = 1_700_000_000_000
      let lineAttempts = 0
      const provider = stubProvider({
        line: async () => {
          lineAttempts += 1
          throw new Error('offline')
        },
      })
      const s = store({ provider, now: () => clock })
      await s.update(obs(0))
      await s.update(obs(PokemonBalance.eggHatchThreshold * 0.75))
      expect(s.snapshot().pendingHatchID).toBe(1) // the roll survives the failed warm
      expect(lineAttempts).toBe(1)

      // The egg is ready now, but the window that failure opened has not passed.
      clock += 30_000
      await s.update(obs(PokemonBalance.eggHatchThreshold))
      expect(lineAttempts).toBe(1) // no retry inside the backoff
      expect(s.snapshot().active).toBeUndefined()

      clock += 31_000 // past it
      await s.update(obs(PokemonBalance.eggHatchThreshold))
      expect(lineAttempts).toBeGreaterThan(1)
    })

    it('hatches into the species it pre-rolled', async () => {
      const { store: s } = counting()
      await s.update(obs(0))
      await s.update(obs(PokemonBalance.eggHatchThreshold * 0.75))
      const rolled = s.snapshot().pendingHatchID
      await s.update(obs(PokemonBalance.eggHatchThreshold))
      expect(s.snapshot().active?.baseID).toBe(rolled)
      expect(s.snapshot().pendingHatchID).toBeUndefined()
    })
  })

  it('consumes the egg guarantee exactly at hatch', async () => {
    const s = store()
    await s.update(obs(0))
    await s.mutate((tx) => tx.commit({ ...tx.state, eggTier: 'common', pendingHatchID: 1 }))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().eggTier).toBeUndefined()
    expect(s.snapshot().pendingHatchID).toBeUndefined()
  })

  it('evolves and then graduates, recording the line in the dex', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active).toBeDefined()

    // Enough to clear both stages of the two-form common line.
    const huge = PokemonBalance.eggHatchThreshold + PokemonBalance.graduationTotal('common') * 2
    await s.update(obs(huge))

    const after = s.snapshot()
    expect(after.active).toBeUndefined() // graduated, a new egg is waiting
    expect(after.dex).toHaveLength(1)
    expect(after.collectedFinals).toHaveLength(1)
    expect(after.eggUsage).toBe(0)
    expect(s.drainEvents().map((e) => e.kind)).toContain('graduated')
  })

  it('stores per-species names at graduation so the dex works offline', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    await s.update(obs(PokemonBalance.eggHatchThreshold + PokemonBalance.graduationTotal('common') * 2))
    expect(s.snapshot().dex[0]?.names).toBeDefined()
  })
})

// [trigger branch] The reveal used to emit a growth event no caller handled, so a disguised
// companion stopped at its first evolution threshold and never moved again — no evolution, no
// graduation, for any amount of usage. This walks the whole path instead of asserting the
// transition alone, because the stall only showed up end to end.
describe('Ditto reveal', () => {
  /** A store whose every 1-in-N roll hits, so the hatch is guaranteed to be disguised. */
  const dittoStore = () =>
    store({
      rng: () => 0,
      dittoEnabled: true,
      provider: {
        ...stubProvider(),
        // Ditto's own line: a single form, which is what the reveal switches to.
        line: async (baseID: number) =>
          baseID === 132
            ? makeEvoLine(132, node(132), 'common', { 132: { en: 'Ditto' } })
            : makeEvoLine(baseID, node(baseID, [node(baseID + 1)]), 'common', {
                [baseID]: { en: `Base${baseID}` },
                [baseID + 1]: { en: `Evo${baseID}` },
              }),
      },
    })

  const hatchDisguised = async (s: ReturnType<typeof dittoStore>) => {
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active?.dittoDisguise).toBe(132)
    return s
  }

  it('reveals at the first threshold and announces what it was pretending to be', async () => {
    const s = await hatchDisguised(dittoStore())
    s.drainEvents()

    const first = PokemonBalance.phaseThreshold('common', 2, 0)
    await s.update(obs(PokemonBalance.eggHatchThreshold + first))

    const active = s.snapshot().active
    expect(active?.dittoRevealed).toBe(true)
    expect(active?.baseID).toBe(132)
    expect(currentSpeciesID(active!)).toBe(132)
    const revealed = s.drainEvents().find((e) => e.kind === 'dittoRevealed')
    expect(revealed).toEqual({ kind: 'dittoRevealed', disguisedAs: 'Base1', isShiny: true })
  })

  it('graduates as Ditto for the same spend the disguised line would have cost', async () => {
    const s = await hatchDisguised(dittoStore())
    const graduationTotal = PokemonBalance.graduationTotal('common')

    // One refresh short of the full line total: revealed, still being raised, still not in the dex.
    await s.update(obs(PokemonBalance.eggHatchThreshold + graduationTotal - 1))
    expect(s.snapshot().active?.dittoRevealed).toBe(true)
    expect(s.snapshot().dex).toHaveLength(0)

    await s.update(obs(PokemonBalance.eggHatchThreshold + graduationTotal))
    const after = s.snapshot()
    expect(after.active).toBeUndefined()
    expect(after.dex[0]?.finalID).toBe(132)
    // The impersonated line was never actually raised, so it must not bias future branches.
    expect(after.collectedFinals).toEqual(['132:132'])
  })
})

describe('celebration window', () => {
  // [trigger branch] The panel reads this live because `render` requests reuse a frozen
  // snapshot: trusting the snapshot's `levelUp` kept a sparkle parked on the companion for up
  // to a whole refresh interval after the window closed.
  it('opens on hatch and closes when the window elapses', async () => {
    let clock = 1_700_000_000_000
    const s = store({ now: () => clock })
    await s.update(obs(0))
    expect(s.isCelebrating()).toBe(false)

    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active).toBeDefined()
    expect(s.isCelebrating()).toBe(true)

    clock += 6_500 // past both event windows
    expect(s.isCelebrating()).toBe(false)
  })
})

describe('wild encounters', () => {
  const readyForOne = EncounterBalance.firstThreshold

  it('spawns an encounter once the usage has paid for it', async () => {
    const s = store()
    await s.update(obs(0))
    expect(s.snapshot().wild).toHaveLength(0)

    await s.update(obs(readyForOne))
    const after = s.snapshot()
    expect(after.wild).toHaveLength(1)
    expect(after.encountersSeen).toBe(1)
    expect(after.wild[0]!.speciesID).toBe(1) // the only species the stub index offers
    expect(after.wild[0]!.names).toEqual({ en: 'Wild1' })
  })

  // [trigger branch] Encounters arrive every 2.5M tokens and an event here means a native
  // toast. A common encounter must therefore never become an event — this is the user's own
  // constraint ("tampoco tenemos que saturar al usuario con toast") encoded as a test.
  it('never emits an event for an ordinary encounter', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(readyForOne))

    expect(s.snapshot().wild).toHaveLength(1) // it did spawn...
    expect(s.drainEvents()).toEqual([]) // ...silently
  })

  it('emits an event for a shiny, then holds the hour-long cooldown', async () => {
    let clock = 1_700_000_000_000
    // rng 0 makes every shiny roll hit (0 % 64 === 0) while still picking valid species.
    const s = store({ rng: () => 0, now: () => clock })
    await s.update(obs(0))
    await s.update(obs(readyForOne))
    expect(s.drainEvents().map((e) => e.kind)).toContain('wildAppeared')

    // A second shiny inside the hour: queued and badged, but no second interruption.
    clock += 30 * 60_000
    await s.update(obs(readyForOne + EncounterBalance.threshold))
    expect(s.drainEvents().map((e) => e.kind)).not.toContain('wildAppeared')

    // Past the hour the window reopens.
    clock += 31 * 60_000
    await s.update(obs(readyForOne + EncounterBalance.threshold * 2))
    expect(s.drainEvents().map((e) => e.kind)).toContain('wildAppeared')
  })

  // `tokendex.encounterNotifications: off` — even the shiny/legendary toast is opted out of,
  // while the queue and the badge still work.
  it('emits nothing at all when encounter toasts are disabled', async () => {
    const s = store({ rng: () => 0, encounterToastsEnabled: () => false })
    await s.update(obs(0))
    await s.update(obs(readyForOne))

    expect(s.snapshot().wild).toHaveLength(1) // the shiny still spawned
    expect(s.drainEvents()).toEqual([])
  })

  it('emits an event for a legendary even when it is not shiny', async () => {
    const s = store({
      provider: stubProvider({
        wildSpecies: async (id: number) => ({
          id,
          captureRate: 3,
          rarity: 'legendary' as const,
          names: { en: 'Mewtwo' },
        }),
      }),
    })
    await s.update(obs(0))
    await s.update(obs(readyForOne))

    const events = s.drainEvents()
    expect(events.map((e) => e.kind)).toContain('wildAppeared')
    expect(events[0]).toMatchObject({ name: 'Mewtwo', rarity: 'legendary' })
  })

  // [trigger branch] Usage banked while the queue was full used to refill every resolved
  // encounter on the very next scan: a heavy user's bank was permanently topped up, so the
  // waiting count never visibly dropped — reported as "catching doesn't reduce the wild
  // Pokémon waiting". A full queue pauses accrual instead, so a freed slot is earned back
  // with a fresh threshold of new spend, never from a bank.
  it('does not refill a resolved encounter from usage spent while the queue was full', async () => {
    const s = store()
    await s.update(obs(0))

    // Enough for the first (cheap) encounter plus a full queue's worth more.
    const fillAll = readyForOne + EncounterBalance.threshold * (EncounterBalance.maxQueue + 3)
    await s.update(obs(fillAll))
    expect(s.snapshot().wild).toHaveLength(EncounterBalance.maxQueue)

    // Keep spending while full: none of it accrues. What was already earned toward the next
    // encounter is *held* rather than rewound — zeroing it charged the player twice for the
    // slot they were about to free.
    const heldWhileFull = s.snapshot().encounterUsage
    const whileFull = fillAll + EncounterBalance.threshold * 4
    await s.update(obs(whileFull))
    expect(s.snapshot().encounterUsage).toBe(heldWhileFull)

    // Working through the queue visibly shrinks it — small further spend changes nothing.
    await s.runFrom(s.snapshot().wild[0]!.id)
    await s.update(obs(whileFull + 1_000))
    expect(s.snapshot().wild).toHaveLength(EncounterBalance.maxQueue - 1)

    // The freed slot is refilled only once a fresh threshold of new spend lands.
    await s.update(obs(whileFull + 1_000 + EncounterBalance.threshold))
    expect(s.snapshot().wild).toHaveLength(EncounterBalance.maxQueue)
  })

  // [trigger branch] The end-to-end shape of the bug this rule exists for: a queue nobody
  // tends is a permanent wall. Measured on a real save — twelve encounters inside 34 minutes,
  // then nothing at all for 118 hours across 561M tokens. Asserted through `update()` rather
  // than on the pure helper, because the freeze came from the *combination* of a full queue
  // and frozen accrual, and only the whole loop shows it.
  it('keeps producing encounters when a full queue is left untouched', async () => {
    let clock = 1_700_000_000_000
    const s = store({ now: () => clock })
    await s.update(obs(0))

    let spent = EncounterBalance.firstThreshold + EncounterBalance.threshold * 20
    await s.update(obs(spent))
    expect(s.snapshot().wild).toHaveLength(EncounterBalance.maxQueue)
    const original = s.snapshot().wild.map((e) => e.id)

    // A working day later, still without the player touching the queue.
    for (let hour = 0; hour < 8; hour++) {
      clock += 3_600_000
      spent += EncounterBalance.threshold
      await s.update(obs(spent))
    }

    const now = s.snapshot().wild
    expect(now.length).toBeGreaterThan(0) // the feature is alive, not frozen at a wall
    expect(now.map((e) => e.id)).not.toEqual(original) // and these are new Pokémon
    expect(s.snapshot().encountersSeen).toBeGreaterThan(EncounterBalance.maxQueue)
  })

  // Wild catches never enter `collectedFinals`, so the variety bias needs its own memory: a
  // species already caught wild (or already waiting in the queue) weighs half on the next roll.
  it('biases the next roll away from species already caught or queued', async () => {
    const twoSpecies = stubProvider({
      baseSpeciesIndex: async (): Promise<BaseSpecies[]> => [
        { id: 1, captureRate: 255 },
        { id: 2, captureRate: 255 },
      ],
    })
    // 200 % 510 lands in species 1's full weight (255), but past its halved weight (127).
    const s = store({ provider: twoSpecies, rng: () => 200 })
    await s.update(obs(0))
    await s.update(obs(readyForOne))
    expect(s.snapshot().wild[0]!.speciesID).toBe(1)

    const caught = await s.throwBallAt(s.snapshot().wild[0]!.id, 'pokeBall')
    expect(caught.kind).toBe('caught') // paid with a starter ball

    await s.update(obs(readyForOne + EncounterBalance.threshold))
    expect(s.snapshot().wild[0]!.speciesID).toBe(2)
  })

  it('starts a fresh save with a handful of Poké Balls', async () => {
    const s = store()
    await s.update(obs(0))
    expect(s.snapshot().inventory['pokeBall']).toBe(Pokeball.starterCount)
  })

  // [trigger branch] `creditDelta` routes a delta to exactly one of two destinations — the egg
  // or the current stage — and encounters must accrue in *both* cases. The delta here lands
  // while a Pokémon is already active, which is the half a fold into `creditDelta` would lose.
  // Accruing on the same update that hatches proves nothing: `active` is still undefined then.
  it('accrues encounters from a delta credited to an active Pokémon', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active).toBeDefined() // hatched: later deltas go to the stage, not the egg

    const seenAfterHatch = s.snapshot().encountersSeen
    const banked = s.snapshot().encounterUsage
    const toNext = EncounterBalance.threshold - banked

    await s.update(obs(PokemonBalance.eggHatchThreshold + toNext))
    expect(s.snapshot().encountersSeen).toBe(seenAfterHatch + 1)
  })

  // [trigger branch] The usage is spent by `payForEncounter` only after the fetch returns. An
  // offline spell must defer encounters, not lose the tokens that paid for them.
  it('keeps the usage banked when the species cannot be fetched', async () => {
    let clock = 1_700_000_000_000
    // Shared, so the recovered store reads exactly what the stalled one wrote.
    const filePath = tempFile()
    const s = store({
      filePath,
      now: () => clock,
      provider: stubProvider({
        wildSpecies: async () => {
          throw new Error('offline')
        },
      }),
    })
    await s.update(obs(0))
    await s.update(obs(readyForOne))

    const stalled = s.snapshot()
    expect(stalled.wild).toHaveLength(0)
    expect(stalled.encountersSeen).toBe(0)
    expect(stalled.encounterUsage).toBe(readyForOne) // banked, not burnt

    // Once the network is back the deferred encounter arrives, with no further usage credited.
    clock += 61_000
    const recovered = store({ filePath, now: () => clock })
    await recovered.update(obs(readyForOne))
    expect(recovered.snapshot().wild).toHaveLength(1)
    expect(recovered.snapshot().encounterUsage).toBe(0)
  })

  it('throws a ball, files the catch in the dex and clears the encounter', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(readyForOne))
    await s.mutate((tx) => tx.commit({ ...tx.state, inventory: { pokeBall: 1 } }))

    const encounterID = s.snapshot().wild[0]!.id
    const outcome = await s.throwBallAt(encounterID, 'pokeBall')

    expect(outcome.kind).toBe('caught') // the stub species has capture rate 255
    const after = s.snapshot()
    expect(after.wild).toHaveLength(0)
    expect(after.dex).toHaveLength(1)
    expect(after.dex[0]!.source).toBe('wild')
    expect(after.collectedFinals).toEqual([]) // a caught wild is not a completed line
    // No event either: the player just clicked the throw and is watching the animation — a
    // native toast on top would be the saturation the encounter design avoids.
    expect(s.drainEvents()).toEqual([])
  })

  it('reports an empty bag without touching the queue', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(readyForOne))
    // A fresh save carries starter balls; this test is about the bag being genuinely empty.
    await s.mutate((tx) => tx.commit({ ...tx.state, inventory: {} }))

    const outcome = await s.throwBallAt(s.snapshot().wild[0]!.id, 'pokeBall')
    expect(outcome).toEqual({ kind: 'noBall' })
    expect(s.snapshot().wild).toHaveLength(1)
  })

  it('discards an encounter when the player runs, spending nothing', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(readyForOne))
    await s.mutate((tx) => tx.commit({ ...tx.state, inventory: { pokeBall: 2 } }))

    await s.runFrom(s.snapshot().wild[0]!.id)
    expect(s.snapshot().wild).toHaveLength(0)
    expect(s.snapshot().inventory['pokeBall']).toBe(2)
    expect(s.snapshot().dex).toHaveLength(0)
  })

  it('stores a chosen trainer and falls back for one outside the roster', async () => {
    const s = store()
    await s.setTrainer('lyra')
    expect(s.snapshot().trainerID).toBe('lyra')

    await s.setTrainer('not-a-trainer')
    expect(s.snapshot().trainerID).toBe(DEFAULT_TRAINER_ID)
  })
})

describe('persistence', () => {
  it('round-trips through disk', async () => {
    const path = tempFile()
    const first = store({ filePath: path })
    await first.update(obs(0))
    await first.update(obs(3_000_000))

    const second = store({ filePath: path })
    await second.update(obs(3_000_000))
    expect(second.snapshot().eggUsage).toBe(3_000_000)
  })

  // A corrupt file must never be silently destroyed — the user may still want to send it in.
  it('backs a corrupt file up before starting fresh', async () => {
    const path = tempFile()
    writeFileSync(path, 'this is not json', 'utf8')
    const s = store({ filePath: path })
    await s.update(obs(0))
    expect(s.snapshot().dex).toEqual([])
    // The original survives beside it. The name is timestamped in local time, so it is found
    // by prefix rather than by hardcoding a timezone-dependent string.
    const dir = join(path, '..')
    const backup = readdirSync(dir).find((n) => n.startsWith(BACKUP_FILE_PREFIX))
    expect(backup, 'no backup was written').toBeDefined()
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe('this is not json')
  })

  it('sanitises a hand-edited save on load', async () => {
    const path = tempFile()
    writeFileSync(path, JSON.stringify({ usedSinceInstall: 1e30, eggTier: 'legendary' }), 'utf8')
    const s = store({ filePath: path })
    await s.update(obs(0))
    expect(s.snapshot().usedSinceInstall).toBe(1_000_000_000_000_000)
    expect(s.snapshot().eggTier).toBeUndefined() // unsatisfiable, would lock the egg forever
  })
})

// Earned legendaries: three days of work in a week, or another billion tokens of lifetime
// usage. The triggers are unit-tested in `companion-ledger`; what matters here is the wiring —
// the reward has to reach the queue as an ordinary wild Pokémon, cost nothing, and be deferred
// rather than lost when it cannot be delivered.
describe('earned legendary encounters', () => {
  /** An index a legendary can actually be drawn from: the flags are what express the tier. */
  const legendaryProvider = () =>
    stubProvider({
      baseSpeciesIndex: async (): Promise<BaseSpecies[]> => [
        { id: 1, captureRate: 255 },
        { id: 150, captureRate: 3, isLegendary: true },
      ],
      wildSpecies: async (id: number) => ({
        id,
        captureRate: id === 150 ? 3 : 255,
        rarity: id === 150 ? ('legendary' as const) : ('common' as const),
        names: { en: `Wild${id}` },
      }),
    })

  const legendaries = (s: CompanionStore) => s.snapshot().wild.filter((e) => e.rarity === 'legendary')

  /** Baseline, then one accruing refresh on each of three days. */
  async function workThreeDays(s: CompanionStore, from = 1_000): Promise<void> {
    await s.update(obs(0, '2026-08-17'))
    await s.update(obs(from, '2026-08-17'))
    await s.update(obs(from + 1_000, '2026-08-18'))
    await s.update(obs(from + 2_000, '2026-08-19'))
  }

  // The refresh that takes the install baseline grants nothing — it exists so that months of
  // prior usage are not counted — and a save seeded from an older aggregate-only ledger grants
  // nothing either. Neither is a day of work, so neither may start a streak: counting them
  // would let an install plus two days of real use pay out a day early.
  it('does not count the install baseline or a ledger seed as a day of work', async () => {
    const baseline = store({ provider: legendaryProvider() })
    await baseline.update(obs(9_000_000, '2026-08-17'))
    expect(baseline.snapshot().accrualDays).toEqual([])

    const path = tempFile()
    // An aggregate-only save: no `claimedTodayTokensByProvider` key at all.
    writeFileSync(path, JSON.stringify({ installBaselineSet: true, usedSinceInstall: 10 }), 'utf8')
    const seeded = store({ filePath: path, provider: legendaryProvider() })
    await seeded.update(obs(9_000_000, '2026-08-17'))
    expect(seeded.snapshot().accrualDays).toEqual([])
  })

  it('puts a legendary in the wild queue after three days of real accrual', async () => {
    const s = store({ provider: legendaryProvider() })
    await workThreeDays(s)

    expect(legendaries(s)).toHaveLength(1)
    expect(legendaries(s)[0]!.speciesID).toBe(150)
    expect(s.snapshot().owedLegendaryEncounters).toBe(0)
  })

  // The reward is a gift, so it spends no accumulated usage — and it must not consume the
  // cheap first-encounter threshold either, which would charge a new player 2.5M for the
  // privilege of having been given something.
  it('costs no usage and does not consume the cheap first encounter', async () => {
    const s = store({ provider: legendaryProvider() })
    await workThreeDays(s)

    expect(s.snapshot().encountersSeen).toBe(0)
    // 1k on the first day, then the whole of each new day's cumulative (2k, 3k) as the ledger
    // rolls over: every token still banked toward an ordinary spawn, none spent on the gift.
    expect(s.snapshot().encounterUsage).toBe(6_000)
  })

  // Two toasts, answering two different questions: why this happened, and who turned up. The
  // second is the ordinary legendary encounter toast, which the reward deliberately reuses.
  it('says why the legendary came, and lets the encounter announce itself', async () => {
    const s = store({ provider: legendaryProvider() })
    await workThreeDays(s)
    const kinds = s.drainEvents().map((e) => e.kind)
    expect(kinds).toContain('legendaryEarned')
    expect(kinds).toContain('wildAppeared')
  })

  // Refreshes land every minute; days are what count. Without the per-day guard a single
  // afternoon would look like a hundred days of work.
  it('counts a day once however many refreshes land in it', async () => {
    const s = store({ provider: legendaryProvider() })
    await s.update(obs(0, '2026-08-17'))
    for (let i = 1; i <= 40; i++) await s.update(obs(i * 1_000, '2026-08-17'))
    expect(legendaries(s)).toHaveLength(0)
    expect(s.snapshot().accrualDays).toEqual(['2026-08-17'])
  })

  // A full queue must not be made room in for the reward: with twelve legendaries waiting, the
  // one `enqueueEncounter` drops would itself be a legendary. Deferring costs nothing.
  it('holds the reward while the queue is full and delivers it when a slot frees', async () => {
    const s = store({ provider: legendaryProvider() })
    const fill =
      EncounterBalance.firstThreshold + EncounterBalance.threshold * (EncounterBalance.maxQueue + 2)
    await s.update(obs(0, '2026-08-17'))
    await s.update(obs(fill, '2026-08-17'))
    await s.update(obs(fill + 1_000, '2026-08-18'))
    await s.update(obs(fill + 2_000, '2026-08-19'))

    expect(s.snapshot().wild).toHaveLength(EncounterBalance.maxQueue)
    expect(legendaries(s)).toHaveLength(0)
    expect(s.snapshot().owedLegendaryEncounters).toBe(1) // owed, not lost

    await s.runFrom(s.snapshot().wild[0]!.id)
    await s.update(obs(fill + 3_000, '2026-08-19'))
    expect(legendaries(s)).toHaveLength(1)
    expect(s.snapshot().owedLegendaryEncounters).toBe(0)
  })

  // Both triggers can fire in one fold. Neither is dropped, and the queue does not receive a
  // pair of legendaries in the same second: the second entitlement is carried.
  it('delivers one legendary per refresh when two triggers fire together', async () => {
    const s = store({ provider: legendaryProvider() })
    await s.update(obs(0, '2026-08-17'))
    await s.update(obs(1_000, '2026-08-17'))
    await s.update(obs(2_000, '2026-08-18'))
    await s.update(obs(MilestoneBalance.tokens, '2026-08-19'))

    // One notification, not two: the fold owes two legendaries but announces them once.
    const events = s.drainEvents()
    const earned = events.filter((e) => e.kind === 'legendaryEarned')
    expect(earned).toEqual([
      { kind: 'legendaryEarned', via: 'both', days: 3, tokens: MilestoneBalance.tokens },
    ])
    expect(legendaries(s)).toHaveLength(1)
    expect(s.snapshot().owedLegendaryEncounters).toBe(1)
  })

  // The award guard has to survive a restart, or closing the window would be a way to re-earn
  // the same week's reward.
  it('does not award the same week again after a reload', async () => {
    const path = tempFile()
    const first = store({ filePath: path, provider: legendaryProvider() })
    await workThreeDays(first)
    expect(legendaries(first)).toHaveLength(1)

    const reloaded = store({ filePath: path, provider: legendaryProvider() })
    await reloaded.update(obs(4_000, '2026-08-19'))
    await reloaded.update(obs(5_000, '2026-08-20'))
    expect(legendaries(reloaded)).toHaveLength(1)
    expect(reloaded.snapshot().owedLegendaryEncounters).toBe(0)
  })

  // [trigger branch] Encounter ids are `time-species-encountersSeen`, and a granted legendary
  // deliberately leaves `encountersSeen` alone — so two grants of the same species inside one
  // clock tick used to share an id. The webview addresses encounters by id, so the second
  // throw would have resolved the first one.
  it('gives every granted legendary its own id', async () => {
    const s = store({ provider: legendaryProvider() })
    await workThreeDays(s)
    // A second window, so the streak pays out again with the clock standing still.
    for (const [i, day] of ['2026-08-24', '2026-08-25', '2026-08-26'].entries()) {
      await s.update(obs(4_000 + i * 1_000, day))
    }

    expect(legendaries(s)).toHaveLength(2)
    const ids = s.snapshot().wild.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // An index cached before the legendary flags existed cannot answer a legendary pool. Handing
  // over a common instead would be the dishonest failure; the entitlement waits for a refresh.
  it('defers the reward rather than paying it with an ordinary species', async () => {
    const s = store() // the default stub index carries no flags
    await workThreeDays(s)
    expect(legendaries(s)).toHaveLength(0)
    expect(s.snapshot().owedLegendaryEncounters).toBe(1)
  })
})

describe('display', () => {
  it('reports an egg before hatching and a mood after', async () => {
    const s = store()
    const inputs = {
      burnTier: 'normal' as const,
      limitWarning: false,
      hasUsageData: true,
      todayTokens: 10,
    }
    await s.update(obs(0))
    expect(s.displayState(inputs)).toBe('egg')

    await s.update(obs(PokemonBalance.eggHatchThreshold))
    // The hatch opens a celebration window.
    expect(s.displayState(inputs)).toBe('levelUp')
  })

  it('names the current Pokémon once the line is loaded', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.displayName()).toBe('Base1')
  })
})

/**
 * Two windows on one save — the property Stage 1 of `docs/multi-window.md` exists for.
 *
 * Every open VS Code window runs its own extension host, its own worker and its own
 * `CompanionStore` over the *same* `companion-state.json`. Two stores sharing one `filePath`
 * is exactly that situation, so the whole cross-window matrix is reachable here without
 * launching an editor.
 */
describe('two windows on one save', () => {
  function shared(): string {
    return tempFile()
  }

  /** Holds the save's lock the way another window would, so contention is deterministic. */
  async function holdLock(filePath: string): Promise<LockHandle> {
    const handle = await new FileLock({ path: lockPathFor(filePath) }).acquire(1_000)
    expect(handle, 'the fixture could not take the lock').toBeDefined()
    return handle!
  }

  /**
   * One observation, folded by both windows.
   *
   * The assertion is deliberately **not** on `usedSinceInstall` alone. That number converges
   * on its own (`docs/multi-window.md` §3.3): both windows diff the same cumulative
   * observation against copies that started equal, so both land on the same total whether or
   * not the fix is present — an assertion on it could never fail. What genuinely runs twice is
   * everything hanging off `delta > 0`, and the egg is the sharpest case: one egg must produce
   * one hatchling, one dex identity and one toast, however many windows are watching.
   */
  it('claims one delta once: the second window hatches nothing and announces nothing', async () => {
    const filePath = shared()
    // Different RNG per window, so a second hatch would visibly be a *different* Pokémon
    // rather than a coincidentally identical one.
    const a = store({ filePath, rng: () => 1 })
    const b = store({ filePath, rng: () => 7 })

    await a.update(obs(0))
    await b.update(obs(0)) // both windows take the same baseline

    await a.update(obs(PokemonBalance.eggHatchThreshold))
    const hatched = a.snapshot().active
    expect(hatched).toBeDefined()
    expect(a.drainEvents().map((e) => e.kind)).toContain('hatched')

    // The second window folds the *same* cumulative observation. Its ledger re-read from disk
    // has already claimed it, so `applyProviderLedger` answers delta = 0 and nothing fires.
    await b.update(obs(PokemonBalance.eggHatchThreshold))

    expect(b.drainEvents().map((e) => e.kind)).not.toContain('hatched')
    expect(b.snapshot().active?.baseID).toBe(hatched?.baseID)
    expect(b.snapshot().usedSinceInstall).toBe(a.snapshot().usedSinceInstall)
    // And the file still holds the first window's hatchling, not a second one written over it.
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { active?: { baseID: number } }
    expect(onDisk.active?.baseID).toBe(hatched?.baseID)
  })

  /**
   * The shop spends a shared resource, so a stale base is a refund. Window B used to write its
   * morning-old `spentTokens: 0` back and hand the balance to the user a second time — with the
   * item still in the bag, because the item was in A's write too.
   */
  it('sees a purchase made in the other window, with no double-spend', async () => {
    const filePath = shared()
    const a = store({ filePath })
    const b = store({ filePath })

    await a.update(obs(0))
    await b.update(obs(0))
    await a.update(obs(200_000_000)) // enough to afford something
    const earned = a.spendable()

    const bought = await a.mutate((tx) => {
      const next = buyItem(tx.state, 'pokeBall', 1)
      if (next !== undefined) tx.commit(next)
      return next !== undefined
    })
    expect(bought).toEqual({ committed: true, value: true })
    const spent = a.snapshot().spentTokens
    expect(spent).toBeGreaterThan(0)

    // B's next write. It re-reads first, so the debit is part of the state it folds into.
    await b.update(obs(200_000_000))

    expect(b.snapshot().spentTokens).toBe(spent)
    expect(b.spendable()).toBe(earned - spent)
    expect(b.snapshot().inventory['pokeBall']).toBe(a.snapshot().inventory['pokeBall'])
    // And A, on its next tick, still sees its own money gone rather than refunded.
    await a.update(obs(200_000_000))
    expect(a.snapshot().spentTokens).toBe(spent)
  })

  /**
   * A catch *removes* an element, which is the merge problem option (b) died on
   * (`docs/multi-window.md` §5(b)): a union of two queues resurrects what one of them caught.
   * Re-reading inside the lock sidesteps it — there is only ever one queue.
   */
  it('does not resurrect a Pokémon the other window caught', async () => {
    const filePath = shared()
    const a = store({ filePath })
    const b = store({ filePath })
    const readyForOne = EncounterBalance.firstThreshold

    await a.update(obs(0))
    await b.update(obs(0))
    await a.update(obs(readyForOne))
    expect(a.snapshot().wild).toHaveLength(1)

    const caughtID = a.snapshot().wild[0]!.id
    const outcome = await a.throwBallAt(caughtID, 'pokeBall')
    expect(outcome.kind).toBe('caught')
    expect(a.snapshot().wild).toHaveLength(0)
    expect(a.snapshot().dex).toHaveLength(1)

    // B's next write folds the same observation and must not put the queue back.
    await b.update(obs(readyForOne))
    expect(b.snapshot().wild.map((e) => e.id)).not.toContain(caughtID)
    expect(b.snapshot().dex).toHaveLength(1)

    // Nor may throwing at it again succeed: it is not in the queue the store re-reads.
    const second = await b.throwBallAt(caughtID, 'pokeBall')
    expect(second.kind).toBe('unknownEncounter')
  })

  /**
   * The contention policy, both halves of it (`docs/multi-window.md` §5(d)).
   *
   * They are asserted together because the *difference* is the decision: the same busy lock
   * must be a silent skip for accrual and a visible failure for an action.
   */
  it('skips an accrual that cannot take the lock, losing nothing', async () => {
    const filePath = shared()
    const s = store({ filePath, lockTimeoutMs: 40 })
    await s.update(obs(0))

    const other = await holdLock(filePath)
    try {
      await s.update(obs(3_000_000))
      // Nothing was written, and nothing was credited from a base we could not confirm.
      expect(s.snapshot().eggUsage).toBe(0)
    } finally {
      await other.release()
    }

    // The delta stayed unclaimed in the file's ledger, so the very next tick folds it whole.
    await s.update(obs(3_000_000))
    expect(s.snapshot().eggUsage).toBe(3_000_000)
  })

  it('fails a user action that cannot take the lock, rather than pretending it worked', async () => {
    const filePath = shared()
    const s = store({ filePath, lockTimeoutMs: 40 })
    await s.update(obs(0))
    await s.setTrainer('lyra')

    const other = await holdLock(filePath)
    try {
      await expect(s.setTrainer('ethan')).rejects.toBeInstanceOf(SaveBusyError)
      await expect(s.runFrom('whatever')).rejects.toBeInstanceOf(SaveBusyError)
      // `mutate` reports it rather than throwing, so the worker can localise one message for
      // every action instead of each site inventing its own.
      expect(await s.mutate((tx) => tx.commit({ ...tx.state, trainerID: 'ethan' }))).toEqual({
        committed: false,
      })
    } finally {
      await other.release()
    }

    // The save on disk is untouched — the failure was real, not cosmetic.
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { trainerID?: string }
    expect(onDisk.trainerID).toBe('lyra')
  })

  /**
   * The invariant the whole two-hold restructure of `update()` exists to keep: a PokéAPI round
   * trip can hang for seconds, and a lock held across one would stall every other window for
   * exactly that long.
   *
   * Asserted on the provider rather than intended in a comment. The lock file exists on disk
   * precisely while the lock is held, so every provider call checks for it as it runs.
   */
  it('never holds the lock across a PokéAPI call', async () => {
    const filePath = shared()
    const lockPath = lockPathFor(filePath)
    const heldDuring: string[] = []
    const watching = (label: string) => {
      if (existsSync(lockPath)) heldDuring.push(label)
    }
    const provider = stubProvider({
      line: async (baseID: number) => {
        watching('line')
        return makeEvoLine(baseID, node(baseID, [node(baseID + 1)]), 'common', {
          [baseID]: { en: `Base${baseID}` },
          [baseID + 1]: { en: `Evo${baseID}` },
        })
      },
      baseSpeciesIndex: async (): Promise<BaseSpecies[]> => {
        watching('baseSpeciesIndex')
        return [{ id: 1, captureRate: 255 }]
      },
      wildSpecies: async (id: number) => {
        watching('wildSpecies')
        return { id, captureRate: 255, rarity: 'common' as const, names: { en: `Wild${id}` } }
      },
    })

    const s = store({ filePath, provider })
    await s.update(obs(0))
    // A single fold that drives every network path at once: the pre-roll, the hatch, the line
    // load and a queue's worth of encounters.
    await s.update(obs(PokemonBalance.eggHatchThreshold / 2))
    await s.update(obs(PokemonBalance.eggHatchThreshold + EncounterBalance.firstThreshold))
    await s.update(obs(PokemonBalance.eggHatchThreshold * 4))

    expect(s.snapshot().active).toBeDefined() // the paths really did run
    expect(heldDuring).toEqual([])
  })
})

/**
 * `syncFromDisk` is the watcher's half of the cross-window story: the other window wrote, so
 * adopt what it wrote — and write nothing back.
 *
 * Not writing is the load-bearing half. `transact` writes on every hold, changed or not, so a
 * watch handler that answered a change with a mutation would hand the other window a change
 * to answer, and two windows would trade refreshes for ever at the debounce interval. That is
 * strictly worse than the two-minute staleness the watcher exists to remove.
 */
describe('adopting another window write without writing back', () => {
  it('sees a purchase the other window committed', async () => {
    const filePath = tempFile()
    const a = store({ filePath })
    const b = store({ filePath })
    await a.update(obs(0))
    await a.update(obs(PokemonBalance.eggHatchThreshold * 4))
    await b.syncFromDisk()

    const held = b.snapshot().inventory.pokeBall ?? 0
    const bought = await a.mutate((tx) => {
      const next = buyItem(tx.state, 'pokeBall', 1)
      if (next !== undefined) tx.commit(next)
      return next !== undefined
    })
    expect(bought).toMatchObject({ committed: true, value: true })
    expect(a.snapshot().inventory.pokeBall).toBe(held + 1)
    expect(b.snapshot().inventory.pokeBall ?? 0).toBe(held) // not yet: nothing has told it

    await b.syncFromDisk()
    expect(b.snapshot().inventory.pokeBall).toBe(a.snapshot().inventory.pokeBall)
    expect(b.spendable()).toBe(a.spendable())
  })

  // [trigger branch] The feedback loop, asserted on the file rather than on intent: the bytes
  // and the mtime both have to be untouched, because either one is an event the other window
  // would answer.
  it('leaves the file completely alone', async () => {
    const filePath = tempFile()
    const a = store({ filePath })
    await a.update(obs(0))
    await a.update(obs(PokemonBalance.eggHatchThreshold))

    const before = readFileSync(filePath, 'utf8')
    const stamp = statSync(filePath).mtimeMs
    const b = store({ filePath })
    await b.syncFromDisk()
    await b.syncFromDisk()

    expect(readFileSync(filePath, 'utf8')).toBe(before)
    expect(statSync(filePath).mtimeMs).toBe(stamp)
    expect(b.snapshot().active?.baseID).toBe(a.snapshot().active?.baseID) // it really did read
  })

  /**
   * [trigger branch] And it takes no lock. A watch event is most likely to arrive *while*
   * another window is mid-transaction — that write is what produced the event — so a sync that
   * queued behind the lock would be slowest exactly when it is needed, and one that reported
   * contention would drop the update entirely. Every writer publishes through
   * `atomicWriteFile`, so an unlocked read sees one writer's complete payload or the previous
   * one, never a torn mixture.
   */
  it('reads while another window holds the lock', async () => {
    const filePath = tempFile()
    const a = store({ filePath })
    const b = store({ filePath, lockTimeoutMs: 20 })
    await a.update(obs(0))
    // `b` reads the save once here, so its memoised `load()` can never be what picks up the
    // change below — only a genuine re-read can.
    await b.syncFromDisk()
    expect(b.snapshot().active).toBeUndefined()

    await a.update(obs(PokemonBalance.eggHatchThreshold))
    expect(a.snapshot().active).toBeDefined()

    const held = await new FileLock({ path: lockPathFor(filePath) }).acquire(1_000)
    expect(held, 'the fixture could not take the lock').toBeDefined()
    try {
      await b.syncFromDisk()
      expect(b.snapshot().active?.baseID).toBe(a.snapshot().active?.baseID)
    } finally {
      await held?.release()
    }
  })

  it('keeps what it holds when there is no save on disk at all', async () => {
    const s = store()
    await expect(s.syncFromDisk()).resolves.toBeUndefined()
    expect(s.snapshot().dex).toEqual([])
  })
})

/**
 * The mechanism, not the memory (`CLAUDE.md`).
 *
 * The defect Stage 1 fixes was not one bad line: it was a *shape* — `snapshot()`, transform,
 * write back — repeated at about a dozen call sites, each one a read-modify-write across a
 * boundary no lock covered. Wrapping the sites would have left the shape available to the next
 * feature, so the shape was removed instead: `CompanionStore` no longer offers any way to
 * publish a state except through `mutate`, and every internal write goes through `transact`.
 *
 * These assertions are what keeps that true. They read the source because the property is
 * about which code *can* be written, not about what a given call returns.
 */
describe('the save has exactly one writer', () => {
  const source = readFileSync(join(sourceRoot(), 'core/companion/store.ts'), 'utf8')

  it('offers no public way to replace or persist the state outside a transaction', () => {
    const surface = Object.getOwnPropertyNames(CompanionStore.prototype)
    expect(surface).not.toContain('replaceState')
    expect(surface).not.toContain('save')
    expect(surface).toContain('mutate')
  })

  // `atomicWriteFile` is the only call that publishes the save, and `transact` is the only
  // place the lock is held. One call site each keeps "every write is locked" checkable by
  // reading eight lines rather than the whole file.
  it('writes the save from exactly one place, inside the lock hold', () => {
    expect(source.match(/atomicWriteFile\(/g) ?? []).toHaveLength(1)
    const holds = source.match(/this\.write\(\)/g) ?? []
    expect(holds).toHaveLength(1)
    const transactBody = source.slice(
      source.indexOf('return this.lock.withLock('),
      source.indexOf('}, this.options.lockTimeoutMs'),
    )
    expect(transactBody).toContain('await this.reread()')
    expect(transactBody).toContain('await this.write()')
  })
})
