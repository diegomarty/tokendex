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
  /** Tokens per minute over the trailing window, when there is recent activity. */
  burnText?: string
}

/** One slot of the evolution strip. `speciesID` is absent for a not-yet-revealed branch. */
export interface PanelLineItem {
  speciesID?: number
  state: 'done' | 'current' | 'future'
}

export interface PanelCompanion {
  /** A hatch/evolution/graduation just happened: the scene celebrates for a few seconds. */
  celebrating?: boolean
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
  /** Fallback glyph, shown when there is no sprite or it fails to load. */
  emoji: string
  /** PokéAPI item sprite filename (`poke-ball`); absent = the emoji is the icon. */
  sprite?: string
  title: string
  description: string
  priceText: string
  enabled: boolean
  owned: boolean
  /** Section the row renders under; titles come from `PanelStrings`. */
  group: 'balls' | 'items' | 'eggs'
}

export interface PanelBagItem {
  id: string
  emoji: string
  /** PokéAPI item sprite filename; absent = the emoji is the icon. */
  sprite?: string
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
  /** Caught from a wild encounter rather than raised to its final form. */
  isWild: boolean
}

/** One queued wild encounter, ready to draw. */
export interface PanelWildEncounter {
  /** Opaque id echoed back with a throw or a run; the webview never interprets it. */
  id: string
  speciesID: number
  name: string
  rarityText: string
  /** Style token (`common`...`legendary`), never shown as text — `rarityText` is the label. */
  rarity: string
  isShiny: boolean
  /** When it appeared, already formatted for the locale. */
  appearedText: string
  /**
   * Native-modal text asking to confirm letting this one go. Present only when the encounter
   * is worth the friction (rare, legendary or shiny); absent = Run needs no confirmation.
   */
  runConfirmText?: string
}

/** One ball in the scene's rack. */
export interface PanelBallOption {
  /** ItemKind slug echoed back with the throw. */
  kind: string
  name: string
  count: number
  /** PokéAPI item sprite filename (`poke-ball`); the webview builds the URL. */
  sprite: string
  /** Chance this ball catches the encounter on stage, formatted ("27%"). Absent = no stage. */
  oddsText?: string
}

/** The Wild tab: the encounter queue and everything the scene needs. */
export interface PanelWild {
  encounters: PanelWildEncounter[]
  /** Home's banner line: "3 wild Pokémon are waiting". */
  waitingText: string
  /** Shown when the queue is empty: "No wild Pokémon right now — 1.2M tokens to the next." */
  emptyText: string
  /** 0..100 toward the next encounter, for the empty state's bar. */
  progressPercent: number
  balls: PanelBallOption[]
  /** Shown under the ball rack when every count is zero. */
  noBallsText: string
}

/**
 * The outcome of one throw, delivered as its own message — never on `PanelState`, which is
 * replayed to any surface that opens later and would replay the animation with it.
 */
export interface PanelThrowResult {
  encounterID: string
  kind: 'caught' | 'broke' | 'fled' | 'noBall' | 'unknownEncounter'
  /** Wobbles the animation plays, 0..4. Decided by the core's dice, never re-rolled here. */
  shakes: number
  /** Pre-localised result line: "Gotcha! Pikachu was caught!". */
  resultText: string
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
  exportSave: string
  importSave: string
  incubating: string
  language: string
  /** The Run button in the wild scene. */
  run: string
  /** The trainer picker's label in Settings. */
  trainer: string
  /** Badge on a wild caught from an encounter, in the catch log. */
  wildBadge: string
  /** CTA under an empty ball rack, jumping to the shop. */
  getBalls: string
  /** The refresh-interval row in Settings. */
  refreshInterval: string
  /** Shop section titles. */
  shopBalls: string
  shopItems: string
  shopEggs: string
  /** Home's empty state when no AI CLI usage has been found yet. */
  noUsage: string
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
  /** The Wild tab. */
  wild: PanelWild
  /** The player's avatar: a Showdown trainer slug from the core's roster. */
  trainerID: string
  /** The whole roster, for the Settings picker. */
  trainers: string[]
  language: string
  languages: { id: string; label: string }[]
  strings: PanelStrings
  /** Official limit windows, empty until a provider answers. */
  limits: PanelLimit[]
  /** The refresh-interval picker; absent when the host did not say (the bench). */
  refresh?: { seconds: number; options: { seconds: number; label: string }[] }
  /** Development surface, only when devMode is on. */
  dev?: PanelDev
  errors: string[]
}

export type PanelMessage =
  | { type: 'ready' }
  /** `confirmLabel` is the localised Buy word for the native modal's button — display-only. */
  | { type: 'buy'; id: string; title: string; priceText: string; confirmLabel?: string }
  | { type: 'use'; id: string }
  | { type: 'setLanguage'; language: string }
  | { type: 'exportSave' }
  | { type: 'importSave' }
  | { type: 'dev'; id: string; value?: string }
  | { type: 'throw'; encounterID: string; ball: string }
  /** `confirmText`/`confirmLabel`: display-only modal copy, present when the core asked for it. */
  | { type: 'run'; encounterID: string; confirmText?: string; confirmLabel?: string }
  | { type: 'setRefreshInterval'; seconds: number }
  | { type: 'setTrainer'; trainerID: string }
