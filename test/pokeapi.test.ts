import { describe, expect, it } from 'vitest'
import { chooseBaseFromIndex, chooseBaseViaREST, type BaseSpecies } from '../src/core/pokeapi.js'

// Selection logic ported from `CompanionStore.chooseBase` / `chooseBaseViaREST`.

const index: BaseSpecies[] = [
  { id: 1, captureRate: 45 }, // rare
  { id: 10, captureRate: 255 }, // common
  { id: 50, captureRate: 120 }, // uncommon
]

const rng = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

describe('chooseBaseFromIndex', () => {
  it('picks from the whole pool without a guarantee', () => {
    expect(chooseBaseFromIndex(index, undefined, new Set(), rng(0))).toBe(1)
  })

  // The capture-rate ceiling IS the rarity floor, so a rare guarantee also admits legendary.
  it('narrows the pool to the guaranteed tier or better', () => {
    for (let r = 0; r < 200; r++) {
      const picked = chooseBaseFromIndex(index, 'rare', new Set(), rng(r))
      expect(picked).toBe(1) // only the capture_rate 45 entry qualifies
    }
  })

  it('admits uncommon-or-better for an uncommon guarantee', () => {
    const picks = new Set<number | undefined>()
    for (let r = 0; r < 400; r++) picks.add(chooseBaseFromIndex(index, 'uncommon', new Set(), rng(r)))
    expect(picks).toEqual(new Set([1, 50]))
  })

  // Falling back to the full pool would silently break a guarantee that was paid for; keeping
  // the egg lets the next tick retry.
  it('returns undefined rather than breaking an unsatisfiable guarantee', () => {
    const commonOnly: BaseSpecies[] = [{ id: 10, captureRate: 255 }]
    expect(chooseBaseFromIndex(commonOnly, 'rare', new Set(), rng(0))).toBeUndefined()
  })

  it('halves the weight of an already-collected line without excluding it', () => {
    const two: BaseSpecies[] = [{ id: 1, captureRate: 100 }, { id: 2, captureRate: 100 }]
    const collected = new Set(['1:3'])
    // Weights become 50 and 100, total 150: r<50 picks 1, r>=50 picks 2.
    expect(chooseBaseFromIndex(two, undefined, collected, rng(49))).toBe(1)
    expect(chooseBaseFromIndex(two, undefined, collected, rng(50))).toBe(2)
    // Still reachable, just rarer.
    expect(chooseBaseFromIndex(two, undefined, collected, rng(0))).toBe(1)
  })

  it('never weighs an entry at zero', () => {
    const tiny: BaseSpecies[] = [{ id: 7, captureRate: 1 }]
    expect(chooseBaseFromIndex(tiny, undefined, new Set(['7:7']), rng(0))).toBe(7)
  })
})

describe('chooseBaseViaREST', () => {
  const provider = (bases: Record<number, BaseSpecies | undefined>) => ({
    baseSpecies: async (id: number) => bases[id],
  })

  it('rejects non-base species and keeps sampling', async () => {
    const p = provider({ 5: undefined, 9: { id: 9, captureRate: 200 } })
    expect(await chooseBaseViaREST(p, undefined, rng(4, 8))).toBe(9)
  })

  // [trigger branch] Leaving the guarantee out of this path would break it silently exactly
  // when the GraphQL index is down — the one moment it is hardest to notice.
  it('enforces the guarantee on the fallback path too', async () => {
    const p = provider({ 9: { id: 9, captureRate: 200 }, 3: { id: 3, captureRate: 20 } })
    expect(await chooseBaseViaREST(p, 'rare', rng(8, 2))).toBe(3) // skips the common one
  })

  it('keeps the egg when the network is down rather than consuming the purchase', async () => {
    const failing = {
      baseSpecies: async () => {
        throw new Error('offline')
      },
    }
    expect(await chooseBaseViaREST(failing, undefined, rng(0))).toBeUndefined()
  })

  it('gives up after the attempt budget', async () => {
    const p = provider({})
    expect(await chooseBaseViaREST(p, undefined, rng(0), 3)).toBeUndefined()
  })
})
