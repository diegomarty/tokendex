/**
 * Shop, inventory and candy grants.
 *
 * All pure: each function takes state and returns new state plus what happened, so the
 * caller owns persistence and notifications. Interleaving side effects with the rules is
 * what leaves them without a reachable test.
 */

import {
  type CandyGrant,
  type CandyWindow,
  type CompanionState,
  FreshEgg,
  ITEM_KINDS,
  type ItemKind,
  NATURES,
  Pokeball,
  type PokemonNature,
  RareCandy,
  type Rarity,
  type ShopEntry,
  itemIsPassive,
  itemShopPrice,
  shopEntryPrice,
} from './model.js'
import type { RNG } from './growth.js'
import { spendableBalance } from './ledger.js'

// MARK: - Inventory

export function itemCount(state: CompanionState, kind: ItemKind): number {
  return state.inventory[kind] ?? 0
}

/** Passive, so any count above zero means owned — it lowers the shiny denominator. */
export function ownsShinyCharm(state: CompanionState): boolean {
  return itemCount(state, 'shinyCharm') > 0
}

/** Owned items for the bag, in declaration order. */
export function ownedItems(state: CompanionState): { kind: ItemKind; count: number }[] {
  return ITEM_KINDS.map((kind) => ({ kind, count: itemCount(state, kind) })).filter((i) => i.count > 0)
}

// MARK: - Shop

/** Passive items already bought sort to the bottom; eggs are instant actions, never "owned". */
function isPurchasedPassive(state: CompanionState, entry: ShopEntry): boolean {
  if (entry.kind !== 'item') return false
  return itemIsPassive(entry.item) && itemCount(state, entry.item) > 0
}

/**
 * Balls sold in tens as well as singly.
 *
 * Not the Master Ball: a ten-pack of guaranteed catches is not a thing worth pricing. Bundles
 * exist because every purchase raises a native confirmation modal, so buying ten balls one at a
 * time is ten modals — unusable, and the reason the shop grew a quantity at all.
 */
const BUNDLED_BALLS: readonly ItemKind[] = ['pokeBall', 'greatBall', 'ultraBall']

export function shopEntries(state: CompanionState): ShopEntry[] {
  const entries: ShopEntry[] = ITEM_KINDS.filter((k) => itemShopPrice(k) !== undefined).map((item) => ({
    kind: 'item',
    item,
  }))
  entries.push(
    ...BUNDLED_BALLS.map((item) => ({ kind: 'item' as const, item, quantity: Pokeball.bundleSize })),
  )
  // Eggs are only offered while there is a Pokémon to discard.
  if (state.active !== undefined) {
    entries.push(...FreshEgg.shopTiers.map((tier) => ({ kind: 'egg' as const, tier })))
  }
  return entries.sort((a, b) => {
    const aDone = isPurchasedPassive(state, a)
    const bDone = isPurchasedPassive(state, b)
    if (aDone !== bDone) return aDone ? 1 : -1
    return shopEntryPrice(a) - shopEntryPrice(b)
  })
}

/** What a row costs, so the gate and the purchase can never disagree about the bundle discount. */
export function itemPurchasePrice(kind: ItemKind, quantity = 1): number | undefined {
  if (itemShopPrice(kind) === undefined) return undefined
  return shopEntryPrice({ kind: 'item', item: kind, quantity: Math.max(1, Math.floor(quantity)) })
}

export function canBuyItem(state: CompanionState, kind: ItemKind, quantity = 1): boolean {
  const price = itemPurchasePrice(kind, quantity)
  if (price === undefined) return false
  if (itemIsPassive(kind) && itemCount(state, kind) > 0) return false // passives are bought once
  // A passive is held, not stocked: a bundle of Shiny Charms is meaningless and must not be a
  // way to pay the bundle discount for one.
  if (itemIsPassive(kind) && quantity > 1) return false
  return spendableBalance(state) >= price
}

/**
 * Buys `quantity` of an item: the wallet pays, the inventory gains them. `usedSinceInstall`
 * (growth and statistics) is untouched — only the spend ledger moves, so buying never rewinds
 * growth.
 */
export function buyItem(state: CompanionState, kind: ItemKind, quantity = 1): CompanionState | undefined {
  const count = Math.max(1, Math.floor(quantity))
  if (!canBuyItem(state, kind, count)) return undefined
  const price = itemPurchasePrice(kind, count)!
  return {
    ...state,
    spentTokens: state.spentTokens + price,
    inventory: { ...state.inventory, [kind]: itemCount(state, kind) + count },
  }
}

// MARK: - Eggs

/** The floor the current egg guarantees. Absent while a Pokémon is active. */
export function eggGuarantee(state: CompanionState): Rarity | undefined {
  return state.active === undefined ? state.eggTier : undefined
}

/**
 * An egg may only be bought while there is a Pokémon to discard.
 *
 * The sold-tier check comes first and is deliberately enforced here rather than at the call
 * site: buying an unsatisfiable guarantee (legendary, which capture_rate cannot express)
 * leaves both roll paths with zero candidates, so the egg never hatches, the guarantee is
 * never consumed, and buying another egg is blocked by the active-Pokémon gate — the tokens
 * would be gone with no way back.
 */
export function canBuyEgg(state: CompanionState, tier: Rarity | undefined): boolean {
  if (!FreshEgg.shopTiers.includes(tier)) return false
  return state.active !== undefined && spendableBalance(state) >= FreshEgg.price_(tier)
}

/**
 * Buys an egg: discards the active Pokémon and restarts incubation from zero.
 *
 * Mirrors only graduation's egg reset. `dex` and `collectedFinals` are untouched, so the
 * discarded Pokémon counts as never drawn — and stage growth is lost, which is the real cost.
 *
 * No species is rolled here. Rolling needs the network, so doing it at purchase time would
 * burn the tokens offline for nothing. Only the guarantee is written to state; the prefetch
 * and hatch paths read it and roll.
 */
export function buyEgg(state: CompanionState, tier: Rarity | undefined): CompanionState | undefined {
  if (!canBuyEgg(state, tier)) return undefined
  const next: CompanionState = {
    ...state,
    spentTokens: state.spentTokens + FreshEgg.price_(tier),
    eggUsage: 0,
    inventory: { ...state.inventory },
  }
  delete next.active // discarded, not graduated
  delete next.pendingHatchID // reroll from scratch under the new guarantee
  if (tier === undefined) delete next.eggTier
  else next.eggTier = tier
  return next
}

// MARK: - Using items

export type CandyUseResult = 'evolved' | 'graduated' | 'progressed' | 'unavailable'

/**
 * Rare Candy needs the evolution line loaded. Without it (just after restart, or offline) the
 * XP would accrue without ever evolving, which reads as the candy having done nothing.
 */
export function canUseRareCandy(state: CompanionState, lineLoaded: boolean): boolean {
  return state.active !== undefined && lineLoaded && itemCount(state, 'rareCandy') > 0
}

/** Consumes one candy. The caller then applies `RareCandy.xp` through the growth path. */
export function consumeRareCandy(state: CompanionState): CompanionState | undefined {
  if (state.active === undefined || itemCount(state, 'rareCandy') <= 0) return undefined
  return {
    ...state,
    inventory: { ...state.inventory, rareCandy: itemCount(state, 'rareCandy') - 1 },
  }
}

/**
 * Mint only touches `MonState.nature`, so unlike the candy it does not need the line loaded
 * and works right after a restart or offline.
 */
export function canUseMint(state: CompanionState): boolean {
  return state.active !== undefined && itemCount(state, 'mint') > 0
}

/**
 * Uses one mint: the nature becomes a random one **different from the current**, so it always
 * visibly changes. Growth, shininess, species and statistics are all untouched.
 */
export function useMint(
  state: CompanionState,
  rng: RNG,
): { state: CompanionState; nature: PokemonNature } | undefined {
  if (!canUseMint(state) || state.active === undefined) return undefined
  const current = state.active.nature
  // With no nature saved (an older Pokémon) the pool is all 25.
  const pool = NATURES.filter((n) => n !== current)
  const nature = pool[rng() % pool.length]!
  return {
    state: {
      ...state,
      inventory: { ...state.inventory, mint: itemCount(state, 'mint') - 1 },
      active: { ...state.active, nature },
    },
    nature,
  }
}

// MARK: - Candy grants from limit windows

/**
 * Edge-triggered decision: a candy is granted only the moment a window newly crosses 100%.
 *
 * - Below 100% the window is removed from the map, re-arming it.
 * - A window already granted (tier >= 1) is not granted again.
 * - session windows grant 1, weekly windows grant `RareCandy.weeklyGrant`.
 *
 * Pure, and separate from the side effects, so both directions are testable.
 */
export function evaluateCandyGrants(
  windows: CandyWindow[],
  grantTier: Record<string, number>,
): { grants: CandyGrant[]; grantTier: Record<string, number> } {
  const next = { ...grantTier }
  const grants: CandyGrant[] = []
  for (const window of windows) {
    if (window.utilization < 100) {
      delete next[window.key] // re-arm
      continue
    }
    if ((next[window.key] ?? 0) >= 1) continue
    next[window.key] = 1
    grants.push({
      windowKey: window.key,
      windowName: window.name,
      count: window.kind === 'weekly' ? RareCandy.weeklyGrant : 1,
    })
  }
  return { grants, grantTier: next }
}

export interface GrantOutcome {
  state: CompanionState
  grants: CandyGrant[]
  /** True when the ledger changed and the caller should persist. */
  changed: boolean
}

/**
 * Applies grants to the inventory.
 *
 * First run seeds the tiers of windows already at 100% **without granting**, so updating the
 * extension does not retroactively pay out. With limits not yet loaded, both seeding and
 * granting wait for the next refresh.
 *
 * Re-arming must be persisted even when nothing was granted: otherwise a restart leaves a
 * stale tier=1 and the next genuine crossing is mistaken for "already granted".
 */
export function grantCandies(
  state: CompanionState,
  windows: CandyWindow[],
  limitsReady: boolean,
): GrantOutcome {
  if (!limitsReady) return { state, grants: [], changed: false }

  if (!state.candyFeatureSeeded) {
    const seeded = { ...state.candyGrantTier }
    for (const window of windows) if (window.utilization >= 100) seeded[window.key] = 1
    return {
      state: { ...state, candyGrantTier: seeded, candyFeatureSeeded: true },
      grants: [],
      changed: true,
    }
  }

  const { grants, grantTier } = evaluateCandyGrants(windows, state.candyGrantTier)
  const inventory = { ...state.inventory }
  for (const grant of grants) {
    inventory['rareCandy'] = (inventory['rareCandy'] ?? 0) + grant.count
  }
  const changed = grants.length > 0 || JSON.stringify(grantTier) !== JSON.stringify(state.candyGrantTier)
  return { state: { ...state, candyGrantTier: grantTier, inventory }, grants, changed }
}
