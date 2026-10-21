import { describe, expect, it } from 'vitest'
import { MEDALS, awardMedals, medalProgress } from '../src/core/companion/medals.js'
import { REGIONS, regionOf, regionProgress } from '../src/core/companion/regions.js'
import {
  freshCompanionState,
  freshSpeciesProgress,
  type CompanionState,
  type SpeciesProgress,
} from '../src/core/companion/model.js'

const registered = (over: Partial<SpeciesProgress> = {}): SpeciesProgress => ({
  ...freshSpeciesProgress(),
  unlocked: true,
  registered: true,
  ...over,
})
const withRegistered = (ids: number[], over: Partial<SpeciesProgress> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  species: Object.fromEntries(ids.map((id) => [id, registered(over)])),
})
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('regions', () => {
  it('splits the 649 into the five generations, with no gap and no overlap', () => {
    const ids = REGIONS.flatMap((r) => range(r.from, r.to))
    expect(ids).toEqual(range(1, 649))
    expect(regionOf(151)?.id).toBe('kanto')
    expect(regionOf(152)?.id).toBe('johto')
    expect(regionOf(650)).toBeUndefined()
  })

  it('counts what is registered in each region', () => {
    const progress = regionProgress(withRegistered([1, 2, 152]))
    expect(progress.find((r) => r.id === 'kanto')).toMatchObject({ registered: 2, total: 151 })
    expect(progress.find((r) => r.id === 'johto')).toMatchObject({ registered: 1, total: 100 })
  })
})

describe('medals', () => {
  // Every medal reads the registry, so its progress is a fact about the save, not a counter.
  it('measures each medal against the save', () => {
    const s = withRegistered(range(1, 12))
    expect(medalProgress(s, 'registered-10')).toEqual({ current: 12, target: 10 })
    expect(medalProgress(s, 'registered-50')).toEqual({ current: 12, target: 50 })
    expect(medalProgress(withRegistered([1], { shinyRegistered: true }), 'shiny-1')).toEqual({
      current: 1,
      target: 1,
    })
    expect(medalProgress(withRegistered([1], { caught: 7 }), 'caught-10')).toEqual({
      current: 7,
      target: 10,
    })
    expect(medalProgress(withRegistered(range(1, 151)), 'region-kanto')).toEqual({
      current: 151,
      target: 151,
    })
  })

  it('has a unique id for every medal', () => {
    const ids = MEDALS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // [trigger branch] Awarded once: what is newly met is announced, and never again.
  it('awards what is newly met, once', () => {
    const seeded = { ...withRegistered([1]), medalsSeeded: true, medals: [] as string[] }
    const first = awardMedals(seeded)
    expect(first.newly).toEqual(['registered-1'])
    expect(first.state.medals).toEqual(['registered-1'])
    expect(awardMedals(first.state).newly).toEqual([])
  })

  // [trigger branch] A save from before medals already meets some: they are given silently,
  // or the first refresh after the update would bury the player in toasts.
  it('gives an older save what it already meets, silently', () => {
    const old = withRegistered(range(1, 12))
    const seeded = awardMedals(old)
    expect(seeded.newly).toEqual([])
    expect(seeded.state.medals).toEqual(expect.arrayContaining(['registered-1', 'registered-10']))
    expect(seeded.state.medalsSeeded).toBe(true)
  })
})
