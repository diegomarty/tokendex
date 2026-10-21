import { describe, expect, it } from 'vitest'
import {
  canIncubate,
  eggIsPaused,
  eggOnStage,
  grantDailyEgg,
  incubateEgg,
  isFreshGame,
  setEggAside,
} from '../src/core/companion/eggs.js'
import {
  EGG_STOCK_MAX,
  type CompanionState,
  type MonState,
  freshCompanionState,
} from '../src/core/companion/model.js'

const mon: MonState = {
  baseID: 1,
  pathIDs: [1],
  plannedPathIDs: [1, 2],
  stageIndex: 0,
  usedAtStage: 0,
  rarity: 'common',
  totalForms: 2,
  isShiny: false,
  dittoRevealed: false,
}
const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

describe('the daily egg', () => {
  // [trigger branch] Once per day, and the cap: `<=` would grant a fourth.
  it('grants one egg a day, up to three', () => {
    let s = state()
    s = grantDailyEgg(s, '2026-10-20')
    expect(s.eggStock).toEqual({ count: 1, lastGrantDay: '2026-10-20' })
    expect(grantDailyEgg(s, '2026-10-20')).toBe(s)
    s = grantDailyEgg(grantDailyEgg(grantDailyEgg(s, '2026-10-21'), '2026-10-22'), '2026-10-23')
    expect(s.eggStock.count).toBe(EGG_STOCK_MAX)
  })
})

describe('incubating', () => {
  it('spends one egg from the stock and puts it on the stage', () => {
    const s = state({ active: mon, eggStock: { count: 2 } })
    const { state: next, outcome } = incubateEgg(s)
    expect(outcome).toBe('started')
    expect(next.active).toBeUndefined()
    expect(next.eggStock.count).toBe(1)
    expect(next.eggUsage).toBe(0)
    expect(next.eggTier).toBeUndefined()
    expect(next.pendingHatchID).toBeUndefined()
  })

  // [trigger branch] A paused egg is resumed, not replaced: the stock is untouched and the
  // usage and the guarantee it had come back with it.
  it('resumes a paused egg without spending the stock', () => {
    const s = state({ active: mon, eggStock: { count: 1 }, eggUsage: 3_000_000, eggTier: 'rare' })
    // A guarantee alone is enough to make it worth resuming: it was paid for.
    expect(eggIsPaused(state({ active: mon, eggTier: 'rare' }))).toBe(true)
    expect(eggIsPaused(s)).toBe(true)
    const { state: next, outcome } = incubateEgg(s)
    expect(outcome).toBe('resumed')
    expect(next.active).toBeUndefined()
    expect(next.eggStock.count).toBe(1)
    expect(next.eggUsage).toBe(3_000_000)
    expect(next.eggTier).toBe('rare')
  })

  it('refuses with no eggs, and while one is already on the stage', () => {
    expect(incubateEgg(state({ active: mon })).outcome).toBe('noEggs')
    expect(canIncubate(state({ active: mon }))).toBe(false)
    expect(incubateEgg(state({ eggStock: { count: 2 } })).outcome).toBe('alreadyIncubating')
  })
})

describe('a new game', () => {
  const seeded = {
    1: { xp: 0, unlocked: true, seen: false, registered: false, caught: 0, candiesUsed: 0 },
  }

  // [trigger branch] Each condition alone ends it — a guarantee bought before the starter
  // would otherwise sit on an egg that never existed.
  it('is fresh only with nothing obtained and no egg under way', () => {
    expect(isFreshGame(state())).toBe(true)
    const seen = {
      16: { xp: 0, unlocked: false, seen: true, registered: false, caught: 0, candiesUsed: 0 },
    }
    expect(isFreshGame(state({ species: seen }))).toBe(true)
    expect(isFreshGame(state({ species: seeded }))).toBe(false)
    expect(isFreshGame(state({ active: mon }))).toBe(false)
    expect(isFreshGame(state({ eggUsage: 1 }))).toBe(false)
    expect(isFreshGame(state({ pendingHatchID: 4 }))).toBe(false)
    expect(isFreshGame(state({ eggTier: 'rare' }))).toBe(false)
  })

  it('has no egg on stage before the starter', () => {
    expect(eggOnStage(state())).toBe(false)
    expect(eggOnStage(state({ species: seeded }))).toBe(true)
  })
})

describe('setting an egg aside', () => {
  const seeded = {
    1: { xp: 0, unlocked: true, seen: false, registered: false, caught: 0, candiesUsed: 0 },
  }

  // [trigger branch] Started from the stock and set aside before it earned anything: the egg
  // goes back, it is not lost.
  it('returns an egg with no progress to the stock', () => {
    const started = incubateEgg(state({ species: seeded, active: mon, eggStock: { count: 1 } })).state
    expect(started.eggStock.count).toBe(0)
    expect(setEggAside(started).eggStock.count).toBe(1)
  })

  it('keeps an egg with progress, and leaves the stock alone', () => {
    const s = state({ species: seeded, eggUsage: 5, eggStock: { count: 1 } })
    expect(setEggAside(s)).toBe(s)
    const guaranteed = state({ species: seeded, eggTier: 'rare', eggStock: { count: 1 } })
    expect(setEggAside(guaranteed)).toBe(guaranteed)
  })

  it('never fills the stock past its capacity, and does nothing on a new game', () => {
    const full = state({ species: seeded, eggStock: { count: EGG_STOCK_MAX } })
    expect(setEggAside(full).eggStock.count).toBe(EGG_STOCK_MAX)
    const fresh = state()
    expect(setEggAside(fresh)).toBe(fresh)
  })
})
