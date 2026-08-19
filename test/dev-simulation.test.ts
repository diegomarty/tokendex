import { describe, expect, it } from 'vitest'
import {
  addOffset,
  applyDevOffsets,
  clearOffsets,
  freshDevState,
  grantItem,
  setDittoDisguise,
  setEggTier,
  setShiny,
  tokensToGraduation,
  tokensToMilestone,
  parseAmount,
} from '../src/core/dev/simulation.js'
import { PokemonBalance, freshCompanionState, type CompanionState, type MonState } from '../src/core/companion/model.js'

const mon = (over: Partial<MonState> = {}): MonState => ({
  baseID: 1, pathIDs: [1], plannedPathIDs: [1, 2], stageIndex: 0, usedAtStage: 0,
  rarity: 'common', totalForms: 2, isShiny: false, dittoRevealed: false, ...over,
})

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'), ...over,
})

describe('offsets ride on top of reality', () => {
  // Adding rather than replacing means real usage keeps flowing while a simulation runs.
  it('adds to what was really observed', () => {
    const dev = addOffset(freshDevState(), 'claude_code', 500)
    expect(applyDevOffsets({ claude_code: 100, codex: 7 }, dev)).toEqual({
      claude_code: 600,
      codex: 7,
    })
  })

  it('introduces a provider that reported nothing', () => {
    const dev = addOffset(freshDevState(), 'codex', 42)
    expect(applyDevOffsets({}, dev)).toEqual({ codex: 42 })
  })

  it('accumulates across calls', () => {
    let dev = addOffset(freshDevState(), 'claude_code', 100)
    dev = addOffset(dev, 'claude_code', 50)
    expect(applyDevOffsets({}, dev)).toEqual({ claude_code: 150 })
  })

  it('leaves the observation untouched once cleared', () => {
    const dev = clearOffsets(addOffset(freshDevState(), 'claude_code', 999))
    expect(applyDevOffsets({ claude_code: 10 }, dev)).toEqual({ claude_code: 10 })
  })
})

describe('milestone amounts are computed, not hard-coded', () => {
  // A fixed "add 250M" stops meaning anything the moment a rare line hatches.
  it('targets the hatch threshold while still an egg', () => {
    const result = tokensToMilestone(state({ eggUsage: 1_000_000 }))
    expect(result.label).toBe('hatch')
    expect(result.amount).toBe(PokemonBalance.eggHatchThreshold - 1_000_000)
  })

  it('targets the next evolution mid-line', () => {
    const result = tokensToMilestone(state({ active: mon({ usedAtStage: 10 }) }))
    expect(result.label).toBe('evolution')
    expect(result.amount).toBe(PokemonBalance.phaseThreshold('common', 2, 0) - 10)
  })

  it('targets graduation on the final form', () => {
    expect(tokensToMilestone(state({ active: mon({ stageIndex: 1, pathIDs: [1, 2] }) })).label).toBe(
      'graduation',
    )
  })

  it('scales with rarity rather than assuming common', () => {
    const common = tokensToMilestone(state({ active: mon({ rarity: 'common' }) })).amount
    const rare = tokensToMilestone(state({ active: mon({ rarity: 'rare' }) })).amount
    expect(rare).toBeGreaterThan(common)
  })

  it('sums every remaining stage for a full graduation', () => {
    const total = tokensToGraduation(state({ active: mon({ stageIndex: 0, usedAtStage: 0 }) }))
    expect(total).toBe(
      PokemonBalance.phaseThreshold('common', 2, 0) + PokemonBalance.phaseThreshold('common', 2, 1),
    )
  })

  it('never asks for zero, which would do nothing at all', () => {
    const done = state({ active: mon({ usedAtStage: 10 ** 12 }) })
    expect(tokensToMilestone(done).amount).toBeGreaterThan(0)
    expect(tokensToGraduation(done)).toBeGreaterThan(0)
  })
})

describe('direct pokes', () => {
  it('grants items without going through the shop', () => {
    const after = grantItem(state({ inventory: { mint: 1 } }), 'mint', 4)
    expect(after.inventory['mint']).toBe(5)
  })

  it('never drives a count below zero', () => {
    expect(grantItem(state({ inventory: { mint: 1 } }), 'mint', -9).inventory['mint']).toBe(0)
  })

  it('sets and clears shininess', () => {
    const on = setShiny(state({ active: mon() }), true)
    expect(on.active?.isShiny).toBe(true)
    expect(setShiny(on, false).active?.isShiny).toBe(false)
  })

  it('is a no-op with no active Pokémon', () => {
    const egg = state()
    expect(setShiny(egg, true)).toEqual(egg)
    expect(setDittoDisguise(egg, true)).toEqual(egg)
  })

  it('arms a Ditto disguise unrevealed, so the reveal can still fire', () => {
    const after = setDittoDisguise(state({ active: mon({ dittoRevealed: true }) }), true)
    expect(after.active?.dittoDisguise).toBe(132)
    expect(after.active?.dittoRevealed).toBe(false)
  })

  it('sets and removes an egg guarantee', () => {
    expect(setEggTier(state(), 'rare').eggTier).toBe('rare')
    expect(setEggTier(state({ eggTier: 'rare' }), undefined).eggTier).toBeUndefined()
  })
})

describe('parseAmount', () => {
  // Typing ten zeros by hand invites a wrong order of magnitude.
  it('accepts K/M/B suffixes', () => {
    expect(parseAmount('1500')).toBe(1500)
    expect(parseAmount('250M')).toBe(250_000_000)
    expect(parseAmount('1.5b')).toBe(1_500_000_000)
    expect(parseAmount(' 3 k ')).toBe(3000)
  })

  it('rejects nonsense so the input box can complain', () => {
    expect(Number.isNaN(parseAmount('lots'))).toBe(true)
    expect(Number.isNaN(parseAmount(''))).toBe(true)
    expect(Number.isNaN(parseAmount('5x'))).toBe(true)
  })
})
