/**
 * The shape the webview renders.
 *
 * Every string here is already formatted and already localised. The webview cannot import the
 * core modules (different bundle, no Node), and even if it could, re-deriving a number there
 * would create a second source of truth that drifts from upstream.
 */

export interface PanelTotals {
  todayText: string
  todayCostText: string
  monthText: string
  monthCostText: string
}

export interface PanelProvider {
  displayName: string
  todayText: string
  monthText: string
}

/** One slot of the evolution strip. `speciesID` is absent for a not-yet-revealed branch. */
export interface PanelLineItem {
  speciesID?: number
  state: 'done' | 'current' | 'future'
}

export interface PanelCompanion {
  name?: string
  speciesID?: number
  isShiny: boolean
  progress: number
  stageText?: string
  toNextText: string
  rarityText?: string
  natureText?: string
  line: PanelLineItem[]
}

export interface PanelShopItem {
  /** Opaque id echoed back with the action; the webview never interprets it. */
  id: string
  emoji: string
  title: string
  description: string
  priceText: string
  enabled: boolean
  owned: boolean
}

export interface PanelBagItem {
  id: string
  emoji: string
  title: string
  description: string
  count: number
  usable: boolean
  hint?: string
}

/** A species cell in the Pokédex grid. */
export interface PanelDexSpecies {
  id: number
  name: string
  isShiny: boolean
  /** Backed only by the Pokémon being raised, so not permanent yet. */
  isRaising: boolean
  rarityText: string
}

/** A row in the catch log. */
export interface PanelDexEntry {
  finalID: number
  name: string
  isShiny: boolean
  rarityText: string
  caughtText?: string
  /** The Pokémon currently being raised, pinned at the top. */
  isActive: boolean
}

/** UI chrome labels, resolved once on the extension side. */
export interface PanelStrings {
  today: string
  month: string
  spendable: string
  provider: string
  buy: string
  owned: string
  use: string
  empty: string
  bagEmpty: string
  dexEmpty: string
  dexEmptyHint: string
  segmentSpecies: string
  segmentLog: string
  raisingBadge: string
  confirmBuy: string
  exportSave: string
  importSave: string
  incubating: string
  language: string
  settingsHint: string
}

export interface PanelState {
  totals: PanelTotals
  providers: PanelProvider[]
  companion?: PanelCompanion
  spendableText: string
  shop: PanelShopItem[]
  bag: PanelBagItem[]
  /** Species grid. */
  dexSpecies: PanelDexSpecies[]
  /** Chronological catch log. */
  dexLog: PanelDexEntry[]
  language: string
  languages: { id: string; label: string }[]
  strings: PanelStrings
  errors: string[]
}

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'buy'; id: string; title: string; priceText: string }
  | { type: 'use'; id: string }
  | { type: 'setLanguage'; language: string }
  | { type: 'exportSave' }
  | { type: 'importSave' }
