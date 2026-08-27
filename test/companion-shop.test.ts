import { describe, expect, it } from 'vitest'
import {
  buyEgg,
  buyItem,
  canBuyEgg,
  canBuyItem,
  canUseMint,
  canUseRareCandy,
  consumeRareCandy,
  evaluateCandyGrants,
  grantCandies,
  itemCount,
  ownedItems,
  ownsShinyCharm,
  shopEntries,
  useMint,
} from '../src/core/companion/shop.js'
import {
  burnTierFor,
  computeDisplayState,
  eggProgress,
  eggReadyToHatch,
  rollDittoDisguise,
  rollShiny,
} from '../src/core/companion/display.js'
import {
  type CandyWindow,
  type CompanionState,
  FreshEgg,
  ITEM_KINDS,
  Mint,
  Pokeball,
  PokemonBalance,
  RareCandy,
  ShinyCharm,
  freshCompanionState,
  itemShopPrice,
  shopEntryPrice,
  type MonState,
} from '../src/core/companion/model.js'

const mon = (over: Partial<MonState> = {}): MonState => ({
  baseID: 1,
  pathIDs: [1],
  plannedPathIDs: [1],
  stageIndex: 0,
  usedAtStage: 0,
  rarity: 'common',
  totalForms: 1,
  isShiny: false,
  dittoRevealed: false,
  ...over,
})

function state(over: Partial<CompanionState> = {}): CompanionState {
  return { ...freshCompanionState('en'), installBaselineSet: true, ...over }
}

const rich = (extra = 0) => state({ usedSinceInstall: 10_000_000_000 + extra, active: mon() })

describe('shop listing', () => {
  it('offers eggs only while there is a Pokémon to discard', () => {
    expect(shopEntries(state()).some((e) => e.kind === 'egg')).toBe(false)
    expect(shopEntries(state({ active: mon() })).some((e) => e.kind === 'egg')).toBe(true)
  })

  it('sorts by price', () => {
    const entries = shopEntries(state({ active: mon() }))
    const prices = entries.map((e) => shopEntryPrice(e))
    expect(prices).toEqual([...prices].sort((a, b) => a - b))

    const first = entries[0]
    expect(first?.kind === 'item' && first.item === 'pokeBall').toBe(true) // cheapest at 5M
  })

  it('offers a ten-pack of every ball except the Master Ball', () => {
    const bundles = shopEntries(state())
      .filter((e) => e.kind === 'item' && (e.quantity ?? 1) > 1)
      .map((e) => (e.kind === 'item' ? e.item : undefined))

    expect(bundles).toEqual(['pokeBall', 'greatBall', 'ultraBall'])
  })

  // `shopEntryPrice` falls back to 0 when a kind has no price, so an item added without one is
  // silently **free**. This walks the whole enum so the next kind cannot land that way.
  it('prices every item kind', () => {
    for (const kind of ITEM_KINDS) {
      expect(itemShopPrice(kind), `${kind} has no price and would be free`).toBeGreaterThan(0)
    }
  })

  it('sinks an already-bought passive to the bottom', () => {
    const owned = state({ active: mon(), inventory: { shinyCharm: 1 } })
    const entries = shopEntries(owned)
    const last = entries[entries.length - 1]
    expect(last?.kind === 'item' && last.item === 'shinyCharm').toBe(true)
  })
})

describe('buying items', () => {
  it('needs the balance, and moves only the spend ledger', () => {
    const poor = state({ usedSinceInstall: 10 })
    expect(canBuyItem(poor, 'rareCandy')).toBe(false)
    expect(buyItem(poor, 'rareCandy')).toBeUndefined()

    const before = state({ usedSinceInstall: RareCandy.price })
    const after = buyItem(before, 'rareCandy')!
    expect(after.spentTokens).toBe(RareCandy.price)
    expect(after.usedSinceInstall).toBe(before.usedSinceInstall) // growth never rewinds
    expect(itemCount(after, 'rareCandy')).toBe(1)
  })

  it('sells a passive only once', () => {
    const owned = state({ usedSinceInstall: 10_000_000_000, inventory: { shinyCharm: 1 } })
    expect(canBuyItem(owned, 'shinyCharm')).toBe(false)
    expect(buyItem(owned, 'shinyCharm')).toBeUndefined()
  })

  it('charges the bundle discount and stocks the whole bundle', () => {
    const unit = Pokeball.price.pokeBall
    const before = state({ usedSinceInstall: 10_000_000_000 })
    const after = buyItem(before, 'pokeBall', Pokeball.bundleSize)!

    expect(after.spentTokens).toBe(unit * Pokeball.bundleMultiplier)
    // On top of the starter balls a fresh save carries.
    expect(itemCount(after, 'pokeBall')).toBe(itemCount(before, 'pokeBall') + Pokeball.bundleSize)
    // Cheaper per ball than buying them one at a time, which is the whole point of the row.
    expect(after.spentTokens).toBeLessThan(unit * Pokeball.bundleSize)
  })

  it('checks the balance against the bundle price, not the unit price', () => {
    const enoughForOne = state({ usedSinceInstall: Pokeball.price.pokeBall })
    expect(canBuyItem(enoughForOne, 'pokeBall')).toBe(true)
    expect(canBuyItem(enoughForOne, 'pokeBall', Pokeball.bundleSize)).toBe(false)
    expect(buyItem(enoughForOne, 'pokeBall', Pokeball.bundleSize)).toBeUndefined()
  })

  // A passive is held, not stocked; a ten-pack would just be the bundle discount on one charm.
  // The wallet has to cover ten charms outright, or this passes on affordability instead of on
  // the rule it is meant to pin.
  it('refuses a bundle of a passive item', () => {
    const flush = state({ usedSinceInstall: ShinyCharm.price * 20 })
    expect(canBuyItem(flush, 'shinyCharm')).toBe(true)
    expect(canBuyItem(flush, 'shinyCharm', Pokeball.bundleSize)).toBe(false)
    expect(buyItem(flush, 'shinyCharm', Pokeball.bundleSize)).toBeUndefined()
  })

  it('treats a nonsense quantity as one', () => {
    const flush = state({ usedSinceInstall: 10_000_000_000, inventory: {} })
    expect(buyItem(flush, 'pokeBall', 0)?.inventory['pokeBall']).toBe(1)
    expect(buyItem(flush, 'pokeBall', -5)?.inventory['pokeBall']).toBe(1)
  })

  it('reports ownership of the shiny charm', () => {
    expect(ownsShinyCharm(state())).toBe(false)
    expect(ownsShinyCharm(state({ inventory: { shinyCharm: 1 } }))).toBe(true)
  })

  it('lists only owned items in the bag', () => {
    expect(ownedItems(state({ inventory: { mint: 2, rareCandy: 0 } }))).toEqual(
      [
        { kind: 'rareCandy', count: 0 },
        { kind: 'mint', count: 2 },
      ].filter((i) => i.count > 0),
    )
  })
})

describe('buying eggs', () => {
  it('requires a Pokémon to discard', () => {
    expect(canBuyEgg(state({ usedSinceInstall: 10_000_000_000 }), undefined)).toBe(false)
    expect(canBuyEgg(rich(), undefined)).toBe(true)
  })

  // Buying an unsatisfiable guarantee would leave both roll paths with zero candidates: the
  // egg never hatches, the guarantee is never consumed, and another egg cannot be bought.
  // The tokens would simply be gone.
  it('refuses a tier that is not sold, so tokens cannot vanish', () => {
    expect(canBuyEgg(rich(), 'legendary')).toBe(false)
    expect(buyEgg(rich(), 'legendary')).toBeUndefined()
  })

  it('discards the Pokémon without touching the dex or the odds', () => {
    const before = rich()
    before.dex = [
      { id: 'x', baseID: 1, finalID: 3, chainOrder: [1, 2, 3], rarity: 'rare', isShiny: false },
    ]
    before.collectedFinals = ['1:3']
    const after = buyEgg(before, undefined)!
    expect(after.active).toBeUndefined()
    expect(after.eggUsage).toBe(0) // incubates from scratch
    expect(after.dex).toHaveLength(1) // as if never drawn
    expect(after.collectedFinals).toEqual(['1:3'])
    expect(after.spentTokens).toBe(FreshEgg.price)
  })

  it('records the guarantee so an offline roll can honour it later', () => {
    const after = buyEgg(rich(), 'rare')!
    expect(after.eggTier).toBe('rare')
    expect(after.pendingHatchID).toBeUndefined() // rerolled under the new guarantee
    expect(after.spentTokens).toBe(FreshEgg.price_('rare'))
  })
})

describe('using items', () => {
  // Without the line loaded the XP would accrue but never evolve, reading as "nothing happened".
  it('gates the candy on the line being loaded', () => {
    const withCandy = state({ active: mon(), inventory: { rareCandy: 1 } })
    expect(canUseRareCandy(withCandy, false)).toBe(false)
    expect(canUseRareCandy(withCandy, true)).toBe(true)
    expect(canUseRareCandy(state({ inventory: { rareCandy: 1 } }), true)).toBe(false)
  })

  it('consumes exactly one candy', () => {
    const after = consumeRareCandy(state({ active: mon(), inventory: { rareCandy: 2 } }))!
    expect(itemCount(after, 'rareCandy')).toBe(1)
  })

  // Mint touches only the nature, so unlike the candy it works offline and after a restart.
  it('does not gate the mint on the line', () => {
    expect(canUseMint(state({ active: mon(), inventory: { mint: 1 } }))).toBe(true)
  })

  it('always changes the nature to a different one', () => {
    const before = state({ active: mon({ nature: 'hardy' }), inventory: { mint: 1 } })
    for (let i = 0; i < 25; i++) {
      const result = useMint(before, () => i)!
      expect(result.nature).not.toBe('hardy')
    }
  })

  it('consumes the mint and stores the new nature', () => {
    const result = useMint(state({ active: mon({ nature: 'hardy' }), inventory: { mint: 1 } }), () => 0)!
    expect(itemCount(result.state, 'mint')).toBe(0)
    expect(result.state.active?.nature).toBe(result.nature)
  })

  it('prices the mint well below a candy so rerolling stays light', () => {
    expect(Mint.price).toBeLessThan(RareCandy.price)
  })
})

describe('candy grants', () => {
  const window = (over: Partial<CandyWindow> = {}): CandyWindow => ({
    key: 'w1',
    name: '5h',
    kind: 'session',
    utilization: 100,
    ...over,
  })

  it('grants once when a window newly crosses 100%', () => {
    const first = evaluateCandyGrants([window()], {})
    expect(first.grants).toEqual([{ windowKey: 'w1', windowName: '5h', count: 1 }])
    // Already granted, so nothing the second time.
    expect(evaluateCandyGrants([window()], first.grantTier).grants).toEqual([])
  })

  it('grants more for a weekly window', () => {
    expect(evaluateCandyGrants([window({ kind: 'weekly' })], {}).grants[0]?.count).toBe(
      RareCandy.weeklyGrant,
    )
  })

  // Re-arming must persist: a stale tier=1 after a restart makes the next genuine crossing
  // look like "already granted", losing the grant entirely.
  it('re-arms when the window falls back below 100%', () => {
    const granted = evaluateCandyGrants([window()], {}).grantTier
    const rearmed = evaluateCandyGrants([window({ utilization: 42 })], granted)
    expect(rearmed.grantTier['w1']).toBeUndefined()
    expect(evaluateCandyGrants([window()], rearmed.grantTier).grants).toHaveLength(1)
  })

  it('waits when limits are not loaded yet', () => {
    const result = grantCandies(state(), [window()], false)
    expect(result.changed).toBe(false)
    expect(result.state.candyFeatureSeeded).toBe(false)
  })

  // Updating the extension must not retroactively pay out for windows already at 100%.
  it('seeds on the first run without granting', () => {
    const result = grantCandies(state(), [window()], true)
    expect(result.grants).toEqual([])
    expect(result.state.candyFeatureSeeded).toBe(true)
    expect(itemCount(result.state, 'rareCandy')).toBe(0)
  })

  it('grants from the second run onward', () => {
    const seeded = grantCandies(state(), [window({ utilization: 10 })], true).state
    const granted = grantCandies(seeded, [window()], true)
    expect(granted.grants).toHaveLength(1)
    expect(itemCount(granted.state, 'rareCandy')).toBe(1)
  })

  it('reports a change on re-arm even with no grant, so it gets persisted', () => {
    const seeded = grantCandies(state(), [window()], true).state
    const rearmed = grantCandies(seeded, [window({ utilization: 5 })], true)
    expect(rearmed.grants).toEqual([])
    expect(rearmed.changed).toBe(true)
  })
})

describe('display state', () => {
  const inputs = {
    burnTier: 'normal' as const,
    limitWarning: false,
    hasUsageData: true,
    todayTokens: 100,
    eventActive: false,
  }

  it('shows an egg when there is no Pokémon', () => {
    expect(computeDisplayState(state(), inputs)).toBe('egg')
  })

  it('prioritises a celebration over everything else', () => {
    expect(
      computeDisplayState(state({ active: mon() }), {
        ...inputs,
        eventActive: true,
        limitWarning: true,
      }),
    ).toBe('levelUp')
  })

  it('shows tired on a limit warning', () => {
    expect(computeDisplayState(state({ active: mon() }), { ...inputs, limitWarning: true })).toBe('tired')
  })

  it('sleeps with no data or no usage today', () => {
    expect(computeDisplayState(state({ active: mon() }), { ...inputs, hasUsageData: false })).toBe(
      'sleep',
    )
    expect(computeDisplayState(state({ active: mon() }), { ...inputs, todayTokens: 0 })).toBe('sleep')
  })

  it('maps the burn tiers', () => {
    const s = state({ active: mon() })
    expect(computeDisplayState(s, { ...inputs, burnTier: 'idle' })).toBe('idle')
    expect(computeDisplayState(s, { ...inputs, burnTier: 'normal' })).toBe('working')
    expect(computeDisplayState(s, { ...inputs, burnTier: 'fast' })).toBe('focus')
    expect(computeDisplayState(s, { ...inputs, burnTier: 'blazing' })).toBe('focus')
  })
})

describe('egg and hatch rolls', () => {
  it('tracks incubation progress', () => {
    expect(eggProgress(state({ eggUsage: 0 }))).toBe(0)
    expect(eggProgress(state({ eggUsage: PokemonBalance.eggHatchThreshold / 2 }))).toBeCloseTo(0.5, 5)
    expect(eggProgress(state({ eggUsage: PokemonBalance.eggHatchThreshold * 3 }))).toBe(1)
    expect(eggReadyToHatch(state({ eggUsage: PokemonBalance.eggHatchThreshold }))).toBe(true)
  })

  it('uses a better shiny denominator while the charm is held', () => {
    const plain = state()
    const charmed = state({ inventory: { shinyCharm: 1 } })
    // A value that hits under the charm's denominator but not the base one.
    expect(rollShiny(plain, () => ShinyCharm.shinyDenominator)).toBe(false)
    expect(rollShiny(charmed, () => ShinyCharm.shinyDenominator)).toBe(true)
  })

  // The reveal fires at a first evolution threshold, so a single-form line has nowhere to
  // spring it — a disguise there would never be revealed.
  it('disguises a Ditto only on a common line with two or more forms', () => {
    expect(rollDittoDisguise('common', 2, true, () => 0)).toBe(true)
    expect(rollDittoDisguise('common', 1, true, () => 0)).toBe(false)
    expect(rollDittoDisguise('rare', 3, true, () => 0)).toBe(false)
    expect(rollDittoDisguise('common', 2, false, () => 0)).toBe(false)
  })
})

describe('burnTierFor', () => {
  // Ported thresholds, pinned at their boundaries: these decide which of the seven status bar
  // icons the user sees, and an off-by-one here shows up as a companion that never wakes up.
  it.each([
    [0, 'idle'],
    [1_000, 'idle'],
    [1_001, 'normal'],
    [99_999, 'normal'],
    [100_000, 'fast'],
    [399_999, 'fast'],
    [400_000, 'blazing'],
    [5_000_000, 'blazing'],
  ])('tiers %i tokens/min as %s', (burn, tier) => {
    expect(burnTierFor(burn as number)).toBe(tier)
  })

  // [trigger branch] A finished session keeps reporting a trickle for the rest of its 5-hour
  // window. Without the floor that reads as work, and the companion never sleeps.
  it('treats a trailing trickle as idle', () => {
    expect(burnTierFor(600)).toBe('idle')
  })
})
