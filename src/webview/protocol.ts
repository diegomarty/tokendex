/**
 * The shape the webview renders.
 *
 * Every string here is already formatted and already localised. The webview cannot import the
 * core modules (different bundle, no Node), and even if it could, re-deriving a number there
 * would create a second source of truth that drifts.
 */

export interface PanelTotals {
  /** Compact, for the layout: `687M`. The same form the breakdown uses, so one screen never
   *  shows the same number two ways. */
  todayText: string
  /** Grouped, for the hover title: `687,029,678`. Nobody reads nine digits at a glance, but the
   *  exact value should still be one hover away. */
  todayExactText: string
  todayCostText: string
  monthText: string
  monthExactText: string
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

/** An official limit window as the panel draws it: a name, a percentage and a bar. */
export interface PanelLimit {
  label: string
  value: string
  percent: number
  severity: 'normal' | 'warn' | 'crit'
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

/** Tab labels. `dev` is a literal: that surface is developer-only and never localised. */
export interface PanelTabLabels {
  home: string
  shop: string
  bag: string
  dex: string
  settings: string
  dev: string
}

/** UI chrome labels, resolved once on the extension side. */
export interface PanelStrings {
  tabs: PanelTabLabels
  today: string
  month: string
  spendable: string
  limits: string
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

/**
 * One control in the Dev tab. The webview renders it and echoes the id back; it never knows
 * what the action does, which is what keeps the dev surface out of the shipped UI logic.
 */
export interface PanelDevControl {
  id: string
  label: string
  description: string
  input: 'button' | 'amount' | 'choice'
  prompt?: string
  defaultValue?: string
  options?: { value: string; label: string }[]
  /** Destructive: the host raises a native confirmation before dispatching. */
  destructive: boolean
}

/** Present only while `tokendex.devMode` is on. Absent = the tab is not even shown. */
export interface PanelDev {
  summary: { label: string; value: string }[]
  groups: { title: string; controls: PanelDevControl[] }[]
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
  /** Official limit windows, empty until a provider answers. */
  limits: PanelLimit[]
  /** Development surface, only when devMode is on. */
  dev?: PanelDev
  errors: string[]
}

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'buy'; id: string; title: string; priceText: string }
  | { type: 'use'; id: string }
  | { type: 'setLanguage'; language: string }
  | { type: 'exportSave' }
  | { type: 'importSave' }
  | { type: 'dev'; id: string; value?: string }
