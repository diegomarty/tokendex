import { describe, expect, it } from 'vitest'
import {
  PokemonBalance,
  RareCandy,
  freshCompanionState,
  freshSpeciesProgress,
  type CompanionState,
  type DexEntry,
  type MonState,
} from '../src/core/companion/model.js'
import {
  markSeen,
  rareCandyXP,
  registerShiny,
  registerXP,
  registrationPercent,
  reconcileShinies,
  retireCompanion,
  seedRegistry,
} from '../src/core/companion/registry.js'
import { decodeCompanionState, encodeCompanionState } from '../src/core/companion/persistence.js'

const mon = (over: Partial<MonState> = {}): MonState => ({
  baseID: 129,
  pathIDs: [129, 130],
  plannedPathIDs: [129, 130],
  stageIndex: 1,
  usedAtStage: 378_478_170,
  rarity: 'common',
  totalForms: 2,
  isShiny: false,
  dittoRevealed: false,
  ...over,
})

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

const graduated = (base: number, chain: number[], rarity: DexEntry['rarity'] = 'common'): DexEntry => ({
  id: `${base}-${chain[chain.length - 1]}-1`,
  baseID: base,
  finalID: chain[chain.length - 1]!,
  chainOrder: chain,
  rarity,
  isShiny: false,
})

const wild = (id: number): DexEntry => ({
  id: `wild-w${id}`,
  baseID: id,
  finalID: id,
  chainOrder: [id],
  rarity: 'common',
  isShiny: false,
  source: 'wild',
})

describe('registerXP', () => {
  // The stage thresholds of a line sum to its graduation total, so registering every form of
  // a line costs exactly what graduating it did — at the new scale.
  it('is the stage threshold inside the line, and the stages sum to the line', () => {
    const total = PokemonBalance.graduationTotal('common')
    const stages = [0, 1, 2].map((i) => registerXP('common', 3, i))
    expect(stages).toEqual([
      Math.round(total / 6),
      Math.round((total * 2) / 6),
      Math.round((total * 3) / 6),
    ])
    expect(stages.reduce((a, b) => a + b, 0)).toBe(total)
    expect(registerXP('legendary', 1, 0)).toBe(PokemonBalance.graduationTotal('legendary'))
  })

  it('prices a full Pokédex at one to two years for a hundred million a day', () => {
    // 328 lines in the gen 1–5 index: 175 common, 33 uncommon, 72 rare, 48 legendary.
    const lines = { common: 175, uncommon: 33, rare: 72, legendary: 48 } as const
    const total = (Object.keys(lines) as (keyof typeof lines)[]).reduce(
      (sum, r) => sum + lines[r] * PokemonBalance.graduationTotal(r),
      0,
    )
    const days = total / 100_000_000
    expect(days).toBeGreaterThan(365)
    expect(days).toBeLessThan(2 * 365)
  })
})

describe('registrationPercent', () => {
  it('clamps to 100 and reads zero before the threshold is known', () => {
    expect(registrationPercent({ ...freshSpeciesProgress(), xp: 5, threshold: 10 })).toBe(50)
    expect(registrationPercent({ ...freshSpeciesProgress(), xp: 50, threshold: 10 })).toBe(100)
    expect(registrationPercent({ ...freshSpeciesProgress(), xp: 50 })).toBe(0)
    // Registered is a flag: a registered species reads 100 whatever its xp says.
    expect(registrationPercent({ ...freshSpeciesProgress(), xp: 0, registered: true })).toBe(100)
  })
})

describe('rareCandyXP', () => {
  it('is a quarter of the current stage, whatever the stage', () => {
    for (const m of [mon(), mon({ rarity: 'legendary', totalForms: 1, stageIndex: 0 })]) {
      expect(rareCandyXP(m)).toBe(
        Math.round(
          RareCandy.stageShare * PokemonBalance.phaseThreshold(m.rarity, m.totalForms, m.stageIndex),
        ),
      )
    }
    expect(RareCandy.stageShare).toBe(0.25)
    expect(RareCandy.maxPerSpecies).toBe(2)
  })
})

describe('seedRegistry', () => {
  // Everything at 0%: flags and zeros only, so the seed needs no threshold, no line and no
  // network, and can never register or shiny a species retroactively.
  it('unlocks every species the save already had, at zero', () => {
    const seeded = seedRegistry(
      state({
        dex: [graduated(1, [1, 2, 3]), wild(10), wild(129)],
        collectedFinals: ['1:3'],
        active: mon(),
      }),
    )
    const ids = Object.keys(seeded.species)
      .map(Number)
      .sort((a, b) => a - b)
    expect(ids).toEqual([1, 2, 3, 10, 129, 130])
    for (const id of ids) {
      expect(seeded.species[id]).toMatchObject({ unlocked: true, xp: 0, registered: false })
      expect(seeded.species[id]!.threshold).toBeUndefined()
    }
  })

  // [trigger branch] The companion's progress restarts: 378M at the old scale is an hour at the
  // new one, not worth a conversion that would otherwise graduate it on the first fold.
  it('resets the companion’s stage progress', () => {
    const seeded = seedRegistry(state({ active: mon() }))
    expect(seeded.active?.usedAtStage).toBe(0)
    expect(seeded.active?.pathIDs).toEqual([129, 130])
  })

  it('leaves the wallet and the history alone', () => {
    const before = state({ usedSinceInstall: 4_429_449_978, spentTokens: 765_000_000, dex: [wild(10)] })
    const seeded = seedRegistry(before)
    expect(seeded.usedSinceInstall).toBe(before.usedSinceInstall)
    expect(seeded.spentTokens).toBe(before.spentTokens)
    expect(seeded.dex).toEqual(before.dex)
  })
})

describe('registering a shiny', () => {
  const charmander = mon({
    baseID: 4,
    pathIDs: [4],
    plannedPathIDs: [4, 5],
    stageIndex: 0,
    totalForms: 2,
  })
  const owned = { 4: { ...freshSpeciesProgress(), unlocked: true, lineRarity: 'rare' as const } }

  // [trigger branch] The one path every shiny registration takes: the flags, the bar full, and
  // the companion on stage wearing it when it is that species.
  it('registers the shiny and dresses the companion that is that species', () => {
    const next = registerShiny(state({ active: charmander, species: owned }), 4)
    expect(next.species[4]).toMatchObject({
      shinyRegistered: true,
      shinyUnlocked: true,
      shinyXP: 8 * PokemonBalance.graduationTotal('rare'),
    })
    expect(next.active?.isShiny).toBe(true)
  })

  it('leaves a companion of another species as it is', () => {
    const next = registerShiny(state({ active: mon(), species: owned }), 4)
    expect(next.active?.isShiny).toBe(false)
  })

  // [trigger branch] A Ditto in disguise is not the species it shows: dressing it would leak the
  // disguise and leave Ditto shiny without a registered shiny of its own.
  it('never dresses a Ditto in disguise', () => {
    const disguised = { ...charmander, dittoDisguise: 4 }
    expect(registerShiny(state({ active: disguised, species: owned }), 4).active?.isShiny).toBe(false)
  })
})

describe('marking a species seen', () => {
  // [trigger branch] Seen with its place in the line (an index with forms): the Pokédex knows its
  // line and rarity from then on — what a lure is priced by — without it being obtained.
  it('records where a seen species sits in its line, without unlocking it', () => {
    const line = { baseID: 4, stageIndex: 1, totalForms: 3, rarity: 'rare' as const }
    const seen = markSeen(state(), 5, line)
    expect(seen.species[5]).toMatchObject({
      seen: true,
      unlocked: false,
      baseID: 4,
      stageIndex: 1,
      totalForms: 3,
      lineRarity: 'rare',
    })
    expect(markSeen(seen, 5, line)).toBe(seen)
    expect(markSeen(state(), 5).species[5]?.lineRarity).toBeUndefined()
  })
})

// Code review 9.12 #4. Switching away from a Ditto still in disguise used to record it as the
// species it showed: a shiny disguise left that species shiny, a Pokémon the player never had,
// and the Ditto itself was gone. Leaving the stage reveals it instead, as growing would have.
describe('retiring a Ditto in disguise', () => {
  const disguised = (over: Partial<MonState> = {}) =>
    mon({
      baseID: 4,
      pathIDs: [4],
      plannedPathIDs: [4, 5, 6],
      stageIndex: 0,
      usedAtStage: 30,
      dittoDisguise: 132,
      disguiseUnlocked: true,
      isShiny: true,
      nature: 'bold',
      ...over,
    })

  it('gives the life to Ditto, never the shiny or the nature to the species it showed', () => {
    const before = state({
      active: disguised(),
      species: { 4: { ...freshSpeciesProgress(), unlocked: true, xp: 30 } },
    })
    const after = retireCompanion(before)
    expect(after.species[4]).toMatchObject({ unlocked: false, xp: 0 })
    expect(after.species[4]?.shinyUnlocked ?? false).toBe(false)
    expect(after.species[4]?.companionShiny ?? false).toBe(false)
    expect(after.species[132]).toMatchObject({
      unlocked: true,
      xp: 30,
      shinyRegistered: true,
      companionShiny: true,
      nature: 'bold',
    })
  })

  it('keeps a species that was owned before the disguise hatched', () => {
    const before = state({
      active: disguised({ disguiseUnlocked: false, isShiny: false }),
      species: { 4: { ...freshSpeciesProgress(), unlocked: true, xp: 42 } },
    })
    const after = retireCompanion(before)
    expect(after.species[4]).toMatchObject({ unlocked: true, xp: 12 })
    expect(after.species[132]).toMatchObject({ unlocked: true, xp: 30 })
  })
})

// Diego's shiny Vulpix: caught before the shiny bar existed, its Pokédex entry is shiny but the
// registry never recorded it, so the Shinydex left it out and its count read 0. A shiny obtained
// has its bar full (C5): reading the save puts every shiny the Pokédex holds into the registry.
describe('a shiny the Pokédex holds and the registry missed', () => {
  it('is registered when the save is read', () => {
    const shinyEntry: DexEntry = { ...graduated(37, [37]), isShiny: true }
    const raw = JSON.parse(
      encodeCompanionState(
        state({
          dex: [shinyEntry, graduated(4, [4, 5])],
          species: {
            37: { ...freshSpeciesProgress(), unlocked: true, lineRarity: 'uncommon' },
            4: { ...freshSpeciesProgress(), unlocked: true },
            5: { ...freshSpeciesProgress(), unlocked: true },
          },
        }),
      ),
    )
    const read = decodeCompanionState(raw)
    expect(read.species[37]).toMatchObject({ shinyUnlocked: true, shinyRegistered: true })
    expect(read.species[4]?.shinyRegistered ?? false).toBe(false)
    // Already consistent: the very same registry, nothing to rewrite.
    expect(reconcileShinies(read)).toBe(read)
  })
})

// Code review (high): a shiny obtained but not registered showed in the Shinydex with an empty
// gold bar — the panel builds the bar for registered shinies only. Under C5 there is no such
// state: a shiny obtained has its bar full. Retiring a shiny companion and reading an older save
// both register it.
describe('a shiny obtained is a shiny registered', () => {
  it('registers the shiny of a shiny companion that leaves the stage', () => {
    const before = state({
      active: mon({ pathIDs: [129], stageIndex: 0, isShiny: true }),
      species: { 129: { ...freshSpeciesProgress(), unlocked: true, lineRarity: 'common' } },
    })
    expect(retireCompanion(before).species[129]).toMatchObject({
      shinyUnlocked: true,
      shinyRegistered: true,
      companionShiny: true,
    })
  })

  it('registers, when the save is read, a shiny an older build left only obtained', () => {
    const raw = JSON.parse(
      encodeCompanionState(
        state({ species: { 7: { ...freshSpeciesProgress(), unlocked: true, shinyUnlocked: true } } }),
      ),
    )
    expect(decodeCompanionState(raw).species[7]).toMatchObject({ shinyRegistered: true })
  })
})
