import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEV_GROUPS, DEV_SCENARIOS, devScenarioByID, devSummary } from '../src/core/dev/scenarios.js'
import { freshDevState } from '../src/core/dev/simulation.js'
import { freshCompanionState } from '../src/core/companion/model.js'

// The scenario table is a contract with two surfaces: the panel's Dev tab renders it and echoes
// back an id, and the quick pick drives the same entries. These tests pin the parts of that
// contract that break silently — an id nobody can dispatch, a group nothing renders, an amount
// that reaches the ledger as NaN.

describe('table integrity', () => {
  it('has unique, resolvable ids', () => {
    const ids = DEV_SCENARIOS.map((scenario) => scenario.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(devScenarioByID(id)?.id).toBe(id)
  })

  it('does not resolve an unknown id', () => {
    // The webview is a separate bundle: after an update it may send an id that no longer exists,
    // and the host must fail closed rather than dispatch something else.
    expect(devScenarioByID('nope')).toBeUndefined()
    expect(devScenarioByID('')).toBeUndefined()
  })

  it('puts every scenario in a rendered group', () => {
    // A scenario whose group is not in DEV_GROUPS exists but is invisible in both surfaces.
    const groups = new Set(DEV_GROUPS.map((group) => group.id))
    for (const scenario of DEV_SCENARIOS) expect(groups.has(scenario.group)).toBe(true)
  })

  it('gives every group at least one scenario', () => {
    for (const group of DEV_GROUPS) {
      expect(DEV_SCENARIOS.some((scenario) => scenario.group === group.id)).toBe(true)
    }
  })

  it('builds an action for every scenario from its own default input', () => {
    for (const scenario of DEV_SCENARIOS) {
      const value = scenario.input.kind === 'none' ? '' : scenario.input.defaultValue
      expect(scenario.build(value), scenario.id).toBeDefined()
    }
  })
})

describe('amount inputs', () => {
  const addTokens = devScenarioByID('add-tokens')!

  it('accepts plain numbers and K/M/B suffixes', () => {
    expect(addTokens.build('1500')).toEqual({
      action: 'devAddTokens',
      provider: 'claude_code',
      amount: 1500,
    })
    expect(addTokens.build('250M')).toMatchObject({ amount: 250_000_000 })
    expect(addTokens.build('1.5B')).toMatchObject({ amount: 1_500_000_000 })
  })

  // [trigger branch] Each of these used to reach `addOffset` as NaN or as a no-op, and a NaN
  // offset poisons the ledger for the rest of the session — the totals never recover because the
  // baseline itself becomes NaN.
  it.each(['', '   ', 'abc', '0', '-5', '5X', '1,5M'])('refuses %o', (raw) => {
    expect(addTokens.build(raw)).toBeUndefined()
  })

  it('refuses a bad count for an item grant too', () => {
    const candy = devScenarioByID('grant-rareCandy')!
    expect(candy.build('5')).toEqual({ action: 'devGrantItem', item: 'rareCandy', count: 5 })
    expect(candy.build('abc')).toBeUndefined()
  })
})

describe('egg tier', () => {
  const eggTier = devScenarioByID('egg-tier')!

  it('offers only the tiers the shop sells', () => {
    const values = eggTier.input.kind === 'choice' ? eggTier.input.options.map((o) => o.value) : []
    expect(values).toEqual(['none', 'uncommon', 'rare'])
  })

  it('never produces a legendary guarantee', () => {
    // capture_rate cannot express legendary, so both roll paths find zero candidates: the egg
    // never hatches, the guarantee is never consumed, and buying another is gated behind having
    // an active Pokémon. Anything unexpected must degrade to "no guarantee".
    expect(eggTier.build('legendary')).toEqual({ action: 'devSetEggTier' })
    expect(eggTier.build('none')).toEqual({ action: 'devSetEggTier' })
    expect(eggTier.build('rare')).toEqual({ action: 'devSetEggTier', tier: 'rare' })
  })
})

describe('destructive scenarios', () => {
  it('gates the reset behind a confirmation', () => {
    // `confirm` is what makes the host raise a native modal; without it the Pokédex would be one
    // stray click away from deletion.
    expect(devScenarioByID('reset-save')?.confirm).toBeTruthy()
  })

  it('leaves the harmless ones unconfirmed', () => {
    expect(devScenarioByID('add-tokens')?.confirm).toBeUndefined()
    expect(devScenarioByID('to-milestone')?.confirm).toBeUndefined()
  })
})

describe('devSummary', () => {
  it('reports an egg and no offsets on a fresh state', () => {
    const rows = devSummary(freshCompanionState('en'), freshDevState())
    const map = new Map(rows.map((row) => [row.label, row.value]))
    expect(map.get('Companion')).toContain('egg')
    expect(map.get('Synthetic offsets')).toBe('none')
    // Absent, not "none": a date override changes what every later refresh means, so it is only
    // ever shown when it is actually set.
    expect(map.has('Date override')).toBe(false)
  })

  it('names the synthetic offsets and the date override once set', () => {
    const dev = {
      ...freshDevState(),
      offsetByProvider: { claude_code: 120_000_000 },
      dateOverride: '2099-01-07',
    }
    const rows = devSummary(freshCompanionState('en'), dev)
    const map = new Map(rows.map((row) => [row.label, row.value]))
    expect(map.get('Synthetic offsets')).toBe('claude_code +120M')
    expect(map.get('Date override')).toBe('2099-01-07')
  })
})

/**
 * Mechanical guard on the wiring, not the rules.
 *
 * Everything else here checks what the table *produces*; this checks that the worker actually
 * *handles* it. The two live in different bundles and the panel dispatches by string, so a
 * renamed action fails at runtime with a silent no-op — the button appears to work and nothing
 * happens. Reading the source is the cheapest way to make that impossible.
 */
describe('every action the table can produce has a handler', () => {
  it('matches the worker switch', () => {
    const worker = readFileSync(join(process.cwd(), 'src/worker/scanWorker.ts'), 'utf8')
    const handled = new Set(
      [...worker.matchAll(/case '(dev[A-Za-z]+)':/g)].map((match) => match[1] as string),
    )

    const produced = new Set<string>()
    for (const scenario of DEV_SCENARIOS) {
      const value = scenario.input.kind === 'none' ? '' : scenario.input.defaultValue
      const action = scenario.build(value)
      if (action !== undefined) produced.add(action.action)
      // A choice scenario reaches a different action shape per option, so every branch counts.
      if (scenario.input.kind === 'choice') {
        for (const option of scenario.input.options) {
          const built = scenario.build(option.value)
          if (built !== undefined) produced.add(built.action)
        }
      }
    }

    expect(produced.size).toBeGreaterThan(0)
    expect([...produced].filter((action) => !handled.has(action))).toEqual([])
  })
})
