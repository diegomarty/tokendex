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
  EGG_STOCK_MAX,
  FreshEgg,
  ITEM_KINDS,
  type ItemKind,
  NATURES,
  Pokeball,
  type PokemonNature,
  RareCandy,
  type Rarity,
  type ShopEntry,
  type SpeciesProgress,
  itemIsBundled,
  itemIsPassive,
  itemShopPrice,
  shopEntryPrice,
  currentSpeciesID,
} from './model.js'
import type { RNG } from './growth.js'
import { progressOf, registerShiny, shinyTarget } from './registry.js'
import { EconomyBalance } from './economy.js'
import { spendableBalance } from './ledger.js'
import { eggOnStage, isFreshGame } from './eggs.js'

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

export function shopEntries(state: CompanionState): ShopEntry[] {
  const entries: ShopEntry[] = ITEM_KINDS.filter((k) => itemShopPrice(k) !== undefined).map((item) => ({
    kind: 'item',
    item,
  }))
  entries.push(
    // Ten-packs exist because every purchase raises a native confirmation modal, so buying ten
    // balls one at a time is ten modals. `itemIsBundled` is the one list of what comes in packs.
    ...ITEM_KINDS.filter(itemIsBundled).map((item) => ({
      kind: 'item' as const,
      item,
      quantity: Pokeball.bundleSize,
    })),
  )
  // The egg itself and its guarantees, once the game has begun; `canBuyEgg` says which can be
  // bought now (a guarantee needs an egg incubating, the egg needs room in the stock).
  if (!isFreshGame(state)) {
    entries.push(...[undefined, ...FreshEgg.shopTiers].map((tier) => ({ kind: 'egg' as const, tier })))
  }
  return entries.sort((a, b) => {
    const aDone = isPurchasedPassive(state, a)
    const bDone = isPurchasedPassive(state, b)
    if (aDone !== bDone) return aDone ? 1 : -1
    return shopEntryPrice(a) - shopEntryPrice(b)
  })
}

/**
 * Whether the host raises its native modal before this purchase. A single ball or berry — the
 * small change bought mid-encounter, the things sold in packs — goes straight through; a pack,
 * an egg (it sends the current Pokémon off), anything sold only singly, and the Master Ball still
 * ask. Decided here and asked by the host, never by the webview that sent the click.
 */
export function purchaseNeedsConfirmation(entry: ShopEntry): boolean {
  if (entry.kind === 'egg') return true
  if ((entry.quantity ?? 1) !== 1) return true
  return !itemIsBundled(entry.item) || entry.item === 'masterBall'
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
 * What the shop sells is the **guarantee** on the egg incubating now — eggs themselves arrive
 * one a day, free. So it needs an egg on the stage (no companion) and the balance.
 *
 * The sold-tier check comes first and is deliberately enforced here rather than at the call
 * site: buying an unsatisfiable guarantee (legendary, which capture_rate cannot express)
 * leaves both roll paths with zero candidates, so the egg never hatches and the guarantee is
 * never consumed — the tokens would be gone with no way back.
 */
export function canBuyEgg(state: CompanionState, tier: Rarity | undefined): boolean {
  // No tier is the egg itself, for the stock (Diego): once the game has begun, while there is room.
  if (tier === undefined) {
    return (
      !isFreshGame(state) &&
      state.eggStock.count < EGG_STOCK_MAX &&
      spendableBalance(state) >= FreshEgg.price
    )
  }
  if (!FreshEgg.shopTiers.includes(tier)) return false
  return eggOnStage(state) && spendableBalance(state) >= FreshEgg.price_(tier)
}

/**
 * Writes the guarantee onto the egg incubating. Nothing is discarded and the incubation keeps
 * its progress; the species pre-rolled before the purchase goes, so the guarantee can be
 * honoured by the next roll.
 *
 * No species is rolled here. Rolling needs the network, so doing it at purchase time would
 * burn the tokens offline for nothing. Only the guarantee is written to state; the prefetch
 * and hatch paths read it and roll.
 */
export function buyEgg(state: CompanionState, tier: Rarity | undefined): CompanionState | undefined {
  if (!canBuyEgg(state, tier)) return undefined
  // The egg itself goes to the stock, where the free daily ones wait; nothing on stage changes.
  if (tier === undefined) {
    return {
      ...state,
      spentTokens: state.spentTokens + FreshEgg.price,
      eggStock: { ...state.eggStock, count: state.eggStock.count + 1 },
    }
  }
  const next: CompanionState = {
    ...state,
    spentTokens: state.spentTokens + FreshEgg.price_(tier),
    inventory: { ...state.inventory },
  }
  delete next.pendingHatchID // reroll under the new guarantee
  if (tier === undefined) delete next.eggTier
  else next.eggTier = tier
  return next
}

// MARK: - Using items

export type CandyUseResult = 'evolved' | 'graduated' | 'progressed' | 'unavailable'

/**
 * Whether the species on stage can still take a candy: `RareCandy.maxPerSpecies` each, counted
 * on the form itself, so evolving into the next form renews the allowance.
 */
export function candyRoomLeft(state: CompanionState): boolean {
  if (state.active === undefined) return false
  return progressOf(state, currentSpeciesID(state.active)).candiesUsed < RareCandy.maxPerSpecies
}

/**
 * Rare Candy needs the evolution line loaded. Without it (just after restart, or offline) the
 * XP would accrue without ever evolving, which reads as the candy having done nothing. And the
 * species on stage must have room left under its cap.
 */
export function canUseRareCandy(state: CompanionState, lineLoaded: boolean): boolean {
  return lineLoaded && itemCount(state, 'rareCandy') > 0 && candyRoomLeft(state)
}

/**
 * Consumes one candy and counts it against the species on stage. The caller then applies
 * `rareCandyXP` through the growth path.
 */
export function consumeRareCandy(state: CompanionState): CompanionState | undefined {
  if (state.active === undefined || itemCount(state, 'rareCandy') <= 0 || !candyRoomLeft(state))
    return undefined
  const speciesID = currentSpeciesID(state.active)
  // Only the count moves; whether the species is unlocked is the growth path's business.
  const progress = progressOf(state, speciesID)
  return {
    ...state,
    inventory: { ...state.inventory, rareCandy: itemCount(state, 'rareCandy') - 1 },
    species: { ...state.species, [speciesID]: { ...progress, candiesUsed: progress.candiesUsed + 1 } },
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

// MARK: - The shiny boost

/**
 * Tokens the wallet can still put into a species' shiny bar, 1:1 (C5): the species registered
 * with its line's rarity known and its shiny not yet registered; then at most
 * `EconomyBalance.shinyBoostShare` of the bar over all purchases, never past what is left of it,
 * never past the wallet. 0 = nothing to sell.
 */
export function shinyBoostRoom(state: CompanionState, speciesID: number): number {
  const p = progressOf(state, speciesID)
  if (!p.registered || p.shinyRegistered === true || p.lineRarity === undefined) return 0
  const left = shinyTarget(p.lineRarity) - (p.shinyXP ?? 0)
  return Math.max(0, Math.min(shinyBoostCapLeft(state, speciesID), left, spendableBalance(state)))
}

/**
 * What is left of the boost cap for a species — `shinyBoostShare` of its bar, less what was
 * bought. The one statement of the cap: `shinyBoostRoom` and the panel's "why not" both read it.
 * 0 without the line's rarity.
 */
export function shinyBoostCapLeft(state: CompanionState, speciesID: number): number {
  const p = progressOf(state, speciesID)
  if (p.lineRarity === undefined) return 0
  const cap = Math.floor(EconomyBalance.shinyBoostShare * shinyTarget(p.lineRarity))
  return Math.max(0, cap - (p.shinyBoosted ?? 0))
}

/**
 * What the Pokédex offers to buy: a tenth of the bar, and all that can be bought — one figure
 * when the two coincide or the tenth no longer fits. Empty when nothing can be.
 */
export function shinyBoostOffers(state: CompanionState, speciesID: number): number[] {
  const room = shinyBoostRoom(state, speciesID)
  if (room <= 0) return []
  // A positive room means the rarity is known (`shinyBoostRoom` returns 0 without it).
  const tenth = Math.round(shinyTarget(progressOf(state, speciesID).lineRarity!) / 10)
  return tenth < room ? [tenth, room] : [room]
}

/**
 * Buys `amount` of a species' shiny bar. Charged to `spentTokens`, counted in `shinyBoosted`;
 * filling the bar registers the shiny, and the companion wears it if it is that species.
 * `undefined` when the amount is not a positive whole number within `shinyBoostRoom`.
 */
export function boostShiny(
  state: CompanionState,
  speciesID: number,
  amount: number,
): CompanionState | undefined {
  if (!Number.isInteger(amount) || amount <= 0 || amount > shinyBoostRoom(state, speciesID))
    return undefined
  const p = progressOf(state, speciesID)
  const shinyXP = (p.shinyXP ?? 0) + amount
  const out: CompanionState = {
    ...state,
    spentTokens: state.spentTokens + amount,
    species: {
      ...state.species,
      [speciesID]: { ...p, shinyXP, shinyBoosted: (p.shinyBoosted ?? 0) + amount },
    },
  }
  // Filling the bar registers the shiny through the one path (`registerShiny`).
  return shinyXP >= shinyTarget(p.lineRarity!) ? registerShiny(out, speciesID) : out
}

// MARK: - The lure

/**
 * What a lure on this species costs, or `undefined` when it cannot be lured: it must have been
 * seen (its line and rarity known from the encounter), not yet obtained, and of a line that is
 * not legendary — those have their own roads.
 */
export function lurePrice(state: CompanionState, speciesID: number): number | undefined {
  const p = progressOf(state, speciesID)
  if (!p.seen || p.unlocked || p.lineRarity === undefined) return undefined
  if (p.baseID === undefined || p.stageIndex === undefined) return undefined
  // The one already lured: buying it again would only restart its clock at full price.
  if (state.lure?.speciesID === speciesID) return undefined
  return EconomyBalance.lure.price[p.lineRarity]
}

/**
 * Buys a day aimed at `speciesID`, charged to `spentTokens`. One lure at a time: a new one
 * replaces the one running (the confirmation says so). `undefined` when it cannot be lured or
 * the wallet is short.
 */
export function setLure(
  state: CompanionState,
  speciesID: number,
  now: number,
): CompanionState | undefined {
  const price = lurePrice(state, speciesID)
  if (price === undefined || spendableBalance(state) < price) return undefined
  const p = progressOf(state, speciesID)
  return {
    ...state,
    spentTokens: state.spentTokens + price,
    lure: {
      speciesID,
      baseID: p.baseID!,
      stageIndex: p.stageIndex!,
      until: now + EconomyBalance.lure.durationMs,
    },
  }
}
