import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompanionStore } from '../src/core/companion/store.js'
import { PokemonBalance, makeEvoLine, type EvoNode } from '../src/core/companion/model.js'
import type { BaseSpecies, PokeProviding } from '../src/core/pokeapi.js'
import { BACKUP_FILE_PREFIX } from '../src/core/companion/saveTransfer.js'
import { EncounterBalance } from '../src/core/companion/encounters.js'
import { Pokeball } from '../src/core/companion/model.js'
import { DEFAULT_TRAINER_ID } from '../src/core/companion/trainers.js'

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

  it('consumes the egg guarantee exactly at hatch', async () => {
    const s = store()
    await s.update(obs(0))
    s.replaceState({ ...s.snapshot(), eggTier: 'common', pendingHatchID: 1 })
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

  // [trigger branch] Minting into a full queue pays the threshold and lets the cap drop an
  // encounter nobody saw — possibly the newcomer itself, right after announcing it. A full
  // queue banks the usage instead; clearing a slot is what releases the spawn.
  it('banks encounters while the queue is full and releases them as it empties', async () => {
    const s = store()
    await s.update(obs(0))

    // Enough for the first (cheap) encounter plus a full queue's worth more.
    const fillAll = readyForOne + EncounterBalance.threshold * (EncounterBalance.maxQueue + 3)
    await s.update(obs(fillAll))
    expect(s.snapshot().wild).toHaveLength(EncounterBalance.maxQueue)
    const bankedSeen = s.snapshot().encountersSeen
    expect(bankedSeen).toBe(EncounterBalance.maxQueue) // the surplus was not paid for

    // Nothing new accrues, but working through the queue releases a banked spawn.
    await s.runFrom(s.snapshot().wild[0]!.id)
    await s.update(obs(fillAll))
    expect(s.snapshot().wild).toHaveLength(EncounterBalance.maxQueue)
    expect(s.snapshot().encountersSeen).toBe(bankedSeen + 1)
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
    s.replaceState({ ...s.snapshot(), inventory: { pokeBall: 1 } })

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
    s.replaceState({ ...s.snapshot(), inventory: {} })

    const outcome = await s.throwBallAt(s.snapshot().wild[0]!.id, 'pokeBall')
    expect(outcome).toEqual({ kind: 'noBall' })
    expect(s.snapshot().wild).toHaveLength(1)
  })

  it('discards an encounter when the player runs, spending nothing', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(readyForOne))
    s.replaceState({ ...s.snapshot(), inventory: { pokeBall: 2 } })

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
    await first.save()

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
