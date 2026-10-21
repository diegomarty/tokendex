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
  /** 0..100 of this species' registration bar; 100 once registered. Absent for an egg. */
  registrationPercent?: number
  /** 0..100 the EXP bar is filled: the stage meter, or the egg toward its hatch. */
  expPercent: number
  /** What it has of what the stage costs: "4.2M / 16.7M". Absent before the starter. */
  expText?: string
  /** What is left — "12.5M to go" — or the registered word once there is nothing left. */
  expLeftText?: string
}

/** An official limit window as the panel draws it: a name, a percentage and a bar. */
export interface PanelLimit {
  label: string
  value: string
  percent: number
  severity: 'normal' | 'warn' | 'crit'
}

/**
 * One price a shop row can be bought at.
 *
 * A row carries more than one when the same thing is sold in more than one quantity — a ball
 * and its ten-pack are one product, and used to be two cards whose descriptions said the same
 * sentence twice. Everything here is decided and formatted in the core: the webview picks no
 * price, computes no discount and builds no label.
 */
export interface PanelShopAction {
  /** Opaque id echoed back with the action; the webview never interprets it. */
  id: string
  /** Visible text on the button: the Buy word, or the quantity when the row offers a choice. */
  text: string
  /**
   * Accessible name. Two buttons reading "Buy" on one row are a coin toss to a screen reader,
   * which announces a button by its own name and not by the card around it.
   */
  label: string
  /** What the host's native confirmation names — `Poké Ball`, or `Poké Ball ×10`. */
  confirmTitle: string
  priceText: string
  /** The same price in tokens: what a group's "from" summary is the least of. Never shown as is. */
  price: number
  /** The saving this quantity gives, already formatted (`−10%`). Absent when there is none. */
  saveText?: string
  enabled: boolean
}

export interface PanelShopItem {
  /** Opaque row id; the actions carry the ids that are echoed back. */
  id: string
  /** Fallback glyph, shown when there is no sprite or it fails to load. */
  emoji: string
  /** PokéAPI item sprite filename (`poke-ball`); absent = the emoji is the icon. */
  sprite?: string
  title: string
  /** Absent when the name, the sprite and the section heading already say it. */
  description?: string
  /**
   * A figure that separates this row from its neighbours at a glance (`1.5×`), where a
   * sentence saying the same thing would be three lines of prose differing in one character.
   */
  stat?: string
  /** What `stat` means, in words, for a screen reader and for a hover. */
  statLabel?: string
  /** Every price this row is sold at, cheapest first. Never empty. */
  actions: PanelShopAction[]
  owned: boolean
  /** Section the row renders under; titles come from `PanelStrings`. */
  group: 'balls' | 'berries' | 'items' | 'eggs'
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
  /** The bag pocket it lives in, as in the games. Decided by the core from the item kind. */
  pocket: 'balls' | 'berries' | 'items'
}

/** A species cell in the Pokédex grid. */
export interface PanelDexSpecies {
  id: number
  name: string
  isShiny: boolean
  /** Backed only by the Pokémon being raised, so not permanent yet. */
  isRaising: boolean
  rarityText: string
  /** Style token (`common`…`legendary`), never shown as text — `rarityText` is the label. */
  rarity: string
  /** The registry's state, two axes: how far the species is, and its shiny form. */
  status: 'seen' | 'unlocked' | 'registered'
  shiny: 'none' | 'unlocked' | 'registered'
  /** 0..100 of the registration bar. */
  percent: number
  /** Localised "45% registered" / "Registered" line. */
  percentText: string
  /** Can be chosen as the companion (unlocked, and not already on stage). */
  canChoose: boolean
  /** 0 common … 3 legendary: what the Pokédex's rarity sort orders by. */
  rarityRank: number
  isCompanion: boolean
  /**
   * The shiny bar, once the species is registered (before that there is none to fill). Absent
   * for a species not registered.
   */
  shinyBar?: PanelShinyBar
  /** A lure on this species can be bought (seen, not obtained, not legendary). */
  lure?: PanelLureOffer
}

/** The Pokédex detail's lure button. Everything decided and formatted in the core. */
export interface PanelLureOffer {
  /** Button text: "Lure · 24 h". */
  text: string
  priceText: string
  /** Accessible name: "Lure Charmander for 24 hours, 150M tokens". */
  label: string
  /** Native modal title; says so when it replaces the lure running. */
  confirmTitle: string
  /** False when the wallet is short; the button shows, greyed, with the price. */
  enabled: boolean
}

/** The PC box: what the companion can be switched to, in the order to offer it. */
export interface PanelPCBox {
  /** "PC box" — also the open button's accessible name. */
  title: string
  items: PanelPCBoxItem[]
  /** Shown when there is nothing else to switch to. */
  emptyText: string
  /** The box's name search: placeholder (the Pokédex's own). */
  searchPlaceholder: string
  /** Its sorts, the first the default (the order `items` comes in): progress, number, rarity. */
  sorts: { id: 'progress' | 'number' | 'rarity'; label: string }[]
}

export interface PanelPCBoxItem {
  id: number
  name: string
  isShiny: boolean
  /** Style token (`common`…`legendary`). */
  rarity: string
  percent: number
  /** "45% registered" / "Registered". */
  percentText: string
  registered: boolean
  /** 0 common … 3 legendary: what the rarity sort orders by. */
  rarityRank: number
}

/** The lid: usage folded in, expanded on click to the counter; three lights for the limits. */
export interface PanelLid {
  /** "Today 253M · This month 4.8B". */
  usageText: string
  /** "Today 253M", for a sidebar of 300 px or less. */
  usageShortText: string
  /** One per light, left to right: the first three official limits' severity; `off` without one. */
  lights: ('off' | 'ok' | 'warn' | 'crit')[]
  /**
   * The expanded lid's screen (Diego): today and this month side by side, each with its tokens,
   * the exact count for the hover, and its cost — the line above, opened, never repeated.
   */
  columns: { label: string; tokensText: string; exactText: string; costText: string }[]
  /** Accessible name of the lid's toggle: "Usage details". */
  toggleLabel: string
}

/** One of Home's drawers. Everything formatted in the core; open/closed is view state. */
export interface PanelDrawer {
  /** Which detail it opens; also a style token. */
  id: 'incubator' | 'challenges' | 'trail' | 'wild' | 'finds' | 'streak'
  /** "Incubator". */
  title: string
  /** The one line shown folded: "Egg at 40% · 2 in stock". */
  summary: string
  /** Something waits on the player (an egg to incubate, a challenge done, a trail running out). */
  attention: boolean
}

/** The challenges board on Home. Everything formatted in the core. */
export interface PanelChallenges {
  /** "Challenges". */
  heading: string
  items: PanelChallenge[]
}

export interface PanelChallenge {
  id: string
  /** Style token: `day` or `week`. Never shown as text — `periodText` is the label. */
  period: string
  periodText: string
  /** "Catch a Fire-type Pokémon". */
  text: string
  /** "1 / 3". */
  progressText: string
  /** 0..100. */
  percent: number
  done: boolean
  /** "+5M". */
  rewardText: string
}

/** The medal catalogue, in its order. */
export interface PanelMedals {
  earned: number
  total: number
  /** Section heading with the count: "Medals (4 / 23)". */
  headingText: string
  items: PanelMedal[]
}

export interface PanelMedal {
  id: string
  name: string
  description: string
  earned: boolean
  /** "37 / 50" — or the same at the target once earned. */
  progressText: string
  /** 0..100. */
  percent: number
}

/** One region of the Pokédex: registered of its size. */
export interface PanelRegion {
  /** Style token and filter key (`kanto`…), never shown as text. */
  id: string
  name: string
  registered: number
  total: number
  percent: number
  /** "37 / 151". */
  progressText: string
  /** First and last Pokédex number, for the filter. */
  from: number
  to: number
}

/** The lure running, for Home: "Luring Charmander · 5 h left". */
export interface PanelLure {
  speciesID: number
  text: string
}

/** A registered species' shiny bar: how full, the sentence, and what the wallet can buy. */
export interface PanelShinyBar {
  /** 0..100. */
  percent: number
  /** "Shiny 12% · 192M / 1.6B" or "Shiny registered". */
  text: string
  /** Boost buttons: a tenth of the bar, and the most that can be bought. Empty = none to sell. */
  boosts: PanelShinyBoost[]
  /** Why there is nothing to buy, when `boosts` is empty and the shiny is not registered. */
  boostHint?: string
}

/** One boost button. Everything decided and formatted in the core. */
export interface PanelShinyBoost {
  /** Tokens it buys, 1:1 into the bar. Echoed back; the host re-checks it against the room. */
  amount: number
  /** Visible text: "+160M". */
  text: string
  /** Accessible name: "Boost shiny Charizard by 160M tokens". */
  label: string
  /** Native modal title and price: "Shiny Charizard — 160M". */
  confirmTitle: string
  priceText: string
}

/** The Pokédex's counts: owned (the collection), registered (the completion) and the total. */
export interface PanelDexSummary {
  owned: number
  registered: number
  total: number
  /** 0..100 of the completion bar. */
  percent: number
  /** "5 / 649". */
  progressText: string
  /** The two segment labels with their counts: "Collection (8)", "Catch log (3)". */
  speciesSegmentText: string
  logSegmentText: string
  /** The five regions' registration, in Pokédex order. */
  regions: PanelRegion[]
  /** The grid's sorts, its default first: number, progress, rarity (the PC box's, reordered). */
  sorts: { id: 'progress' | 'number' | 'rarity'; label: string }[]
  /** The Shinydex: shinies registered, "3 / 649", and its segment label "Shinydex (3)". */
  shinyRegistered: number
  /** 0..100 of the Shinydex, rounded as `percent` is. */
  shinyPercent: number
  shinyProgressText: string
  shinySegmentText: string
}

/** A starter offered on first run. */
export interface PanelStarter {
  id: number
  name: string
  /** Style tokens (`fire`, `water`…), never shown as text. */
  types: string[]
}

/** The egg stock: one free egg a day, up to three, and the one incubating if any. */
export interface PanelEggs {
  count: number
  max: number
  /** Localised "2 eggs in stock" line. */
  stockText: string
  /** Localised label of the incubate / resume button; absent when nothing can be incubated. */
  incubateText?: string
  /** An egg is paused (a companion was chosen while one incubated). */
  paused: boolean
  /** With the stock empty: how the next egg arrives. Absent while there are eggs. */
  emptyText?: string
}

/** A row in the catch log. */
export interface PanelDexEntry {
  finalID: number
  name: string
  isShiny: boolean
  /** Style token (`common`…`legendary`), never shown as text — `rarityText` is the label. */
  rarity: string
  rarityText: string
  caughtText?: string
  /** The Pokémon currently being raised, pinned at the top. */
  isActive: boolean
  /** Caught from a wild encounter rather than raised to its final form. */
  isWild: boolean
}

/**
 * One rarity chip over the catch log.
 *
 * The log is ordered by time because it is a record, so rarity stopped being its sort key —
 * narrowing is what replaces it. Counts come from the core: the webview shows what it is given.
 */
export interface PanelDexFilter {
  /** `all`, or a rarity token matching `PanelDexEntry.rarity`. */
  id: string
  label: string
  count: number
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
  /**
   * Style token for the scenery it is met in: its primary type (`fire`, `water`…), or its rarity
   * when the type is unknown. Never shown as text.
   */
  terrain: string
  isShiny: boolean
  /** When it appeared, already formatted for the locale. */
  appearedText: string
  /**
   * Native-modal text asking to confirm letting this one go. Present only when the encounter
   * is worth the friction (rare, legendary or shiny); absent = Run needs no confirmation.
   */
  runConfirmText?: string
  /** Nature and standout traits: "Adamant · fierce · skittish". Absent when there is none. */
  temperamentText?: string
  /** Anger, nerves and trust, as bars. Already measured and labelled by the core. */
  meters: PanelMoodMeter[]
  /** What a miss risks: "If it breaks free: flee 16% · attack 5%". */
  riskText: string
  /** The same risk in parts: the heading, then one part per reaction, each with its glyph key. */
  risk: { heading: string; items: { key: 'flee' | 'attack'; text: string }[] }
  /** A Razz Berry is waiting to boost the next ball. */
  primedText?: string
  /** It has taken tokens, and catching it gets them back. */
  stolenText?: string
  /**
   * The same two facts as short status chips on its plate, the way the games show a status
   * condition: `text` is the chip, `title` the sentence behind it. `key` is a style token.
   */
  statuses: { key: 'primed' | 'stolen'; text: string; title: string }[]
  /**
   * Present when the species is already obtained: the plate shows a Poké Ball, as the games
   * mark what you have caught. The text is its tooltip and accessible name.
   */
  ownedText?: string
}

/** One mood bar. `tone` is a style token, never text — `label` is what is read. */
export interface PanelMoodMeter {
  key: 'anger' | 'nervousness' | 'trust'
  label: string
  /** 0..100. */
  percent: number
  tone: 'low' | 'mid' | 'high'
}

/** One berry that can be offered to the encounter on stage. */
export interface PanelBerryOption {
  /** BerryKind slug echoed back with the feed. */
  kind: string
  name: string
  count: number
  sprite: string
  /** What it does, for the button's tooltip and accessible name. */
  effectText: string
}

/** An item lying in the wild area, picked up with a click. */
export interface PanelFind {
  id: string
  name: string
  count: number
  sprite?: string
  emoji: string
  /** Style token, like the encounters'. */
  rarity: string
  rarityText: string
  /** The button's accessible name: "Pick up Poké Ball". */
  label: string
}

/** A legendary that got away and can still be tracked back. */
export interface PanelTrail {
  id: string
  speciesID: number
  name: string
  isShiny: boolean
  expiresText: string
  /** The button: "Track · 100M". */
  trackText: string
  priceText: string
  /** Native confirmation copy, like a purchase's. */
  confirmTitle: string
  confirmLabel: string
  enabled: boolean
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

/**
 * One day of the streak window, as a style token: `off` (no usage that day), `on` (usage
 * accrued) and `award` (the day this window's legendary was earned). Never shown as text —
 * `PanelStreak.text` is the label, and the webview must not translate a token into words.
 */
export type PanelStreakDay = 'off' | 'on' | 'award'

/**
 * The rolling streak window, drawn as one dot per day beside the encounter bar.
 *
 * Everything here is decided in the core: which days count, how wide the window is, whether it
 * has already paid out, and what the row says. The webview draws `days` and prints `text` —
 * it never counts a day, compares a date, or builds a sentence.
 */
export interface PanelStreak {
  /** One entry per day of the window, oldest first, ending today. */
  days: PanelStreakDay[]
  /** Short line beside the dots: "2 of 3 days", or "Legendary earned" once it has fired. */
  text: string
  /** Accessible name for the row, since the dots themselves say nothing to a screen reader. */
  label: string
  /** `aria-valuenow` / `aria-valuemax`: days accrued against days needed. */
  value: number
  max: number
  /** True once this window's legendary is earned — the row greys out until the window clears. */
  earned: boolean
}

/** The Wild tab: the encounter queue and everything the scene needs. */
export interface PanelWild {
  encounters: PanelWildEncounter[]
  /** Home's banner line: "3 wild Pokémon are waiting". */
  waitingText: string
  /** How many wait behind the one on stage, short enough for a menu cell: "+2 waiting". */
  moreText?: string
  /** Label on the progress bar toward the next encounter: "1.2M to the next encounter". */
  nextText: string
  /** 0..100 toward the next encounter, the bar that label sits on. */
  progressPercent: number
  /** The streak row under that bar. */
  streak: PanelStreak
  balls: PanelBallOption[]
  /** Shown under the ball rack when every count is zero. */
  noBallsText: string
  /** The berry row beside the balls, with its heading. Only berries the bag holds. */
  berries: PanelBerryOption[]
  finds: PanelFind[]
  /** Heading over the finds strip; absent when there are none. */
  findsText?: string
  collectAllText: string
  trail: PanelTrail[]
  trailTitle: string
}

/**
 * The outcome of one turn — a throw or a berry — delivered as its own message, never on
 * `PanelState`, which is replayed to any surface that opens later and would replay the animation
 * with it.
 */
export interface PanelEncounterResult {
  encounterID: string
  kind: 'caught' | 'broke' | 'fled' | 'fed' | 'noItem' | 'unknownEncounter'
  /** Wobbles the animation plays, 0..4. Decided by the core's dice, never re-rolled here. */
  shakes: number
  /** Pre-localised result line: "Gotcha! Pikachu was caught!". */
  resultText: string
  /** Which animation to play: a ball arc, a berry toss, or none (nothing was used). */
  animation: 'throw' | 'feed' | 'none'
  /** It struck back this turn — the scene flashes. */
  attacked: boolean
  /**
   * A catch's news for the scene's banner, like a level-up: new to the Pokédex with its share,
   * or a duplicate with its reward. Present only on a catch.
   */
  catchNews?: {
    isNew: boolean
    headline: string
    detail: string
    /**
     * A first catch's bar, for the banner's reveal: the species (its sprite) and its registration
     * before and after the catch, 0..100. Absent on a duplicate.
     */
    registration?: { speciesID: number; fromPercent: number; toPercent: number }
  }
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

/** An empty view: what it is, and how it fills. */
export interface PanelEmpty {
  title: string
  hint: string
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
  segmentSpecies: string
  segmentLog: string
  raisingBadge: string
  exportSave: string
  importSave: string
  incubating: string
  /** The Pokédex detail's button that makes an unlocked species the companion. */
  chooseCompanion: string
  /** Badge on the species that is the companion right now. */
  companionBadge: string
  /** The first-run starter screen's title and the line under it. */
  starterTitle: string
  starterPrompt: string
  language: string
  /** The Run button in the wild scene. */
  run: string
  /** The battle menu's Pokémon button: opens the companion's Pokédex entry. */
  pokemonMenu: string
  /** Empty states, each a title and the line saying how it fills (plan 08 §7). */
  emptyCollection: PanelEmpty
  emptyShinydex: PanelEmpty
  emptyLog: PanelEmpty
  emptyBag: PanelEmpty & { action: string }
  /** The trainer picker's label in Settings. */
  trainer: string
  /** Settings: the finished-companion toggle's label, and the sentence under it. */
  keepCompleted: string
  keepCompletedHint: string
  /** Badge on a wild caught from an encounter, in the catch log. */
  wildBadge: string
  /** CTA under an empty ball rack, jumping to the shop. */
  getBalls: string
  /** The refresh-interval row in Settings. */
  refreshInterval: string
  /** Shop section titles. */
  shopBalls: string
  shopBerries: string
  /** The battle menu: its prompt, the two item commands and the way back from either. */
  commandPrompt: string
  commandBalls: string
  commandBack: string
  shopItems: string
  shopEggs: string
  /** The one line all three eggs share, under the Eggs heading rather than on every card. */
  shopEggsNote: string
  /** Home's empty state when no AI CLI usage has been found yet. */
  noUsage: string
  /** Pokédex browsing: the search field, the owned-only toggle and their empty state. */
  dexSearch: string
  dexOwnedOnly: string
  dexNoMatches: string
  /** Accessible name of the detail card's dismiss button, which is an icon. */
  close: string
  /** Heading over save export/import in Settings. */
  saveSection: string
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

export interface PanelWalletChange {
  id: number
  /** Signed and formatted: `+12.3M`, `−4M`. */
  text: string
  kind: 'gain' | 'loss'
}

export interface PanelState {
  totals: PanelTotals
  providers: PanelProvider[]
  companion?: PanelCompanion
  /** Present on first run only: the game wants a starter before anything else. */
  starters?: PanelStarter[]
  eggs: PanelEggs
  /** The Pokédex's counts, already formatted: the webview paints them and never counts its list. */
  dexSummary: PanelDexSummary
  spendableText: string
  /**
   * How the spendable balance moved since the previous panel this host built — tokens earned, a
   * purchase, an attack. `id` is unique per change, so a panel re-sent with the same change (a
   * view reopened, a language switch) never plays it twice.
   */
  walletChange?: PanelWalletChange
  shop: PanelShopItem[]
  bag: PanelBagItem[]
  /** Species grid. */
  dexSpecies: PanelDexSpecies[]
  /** Chronological catch log. */
  dexLog: PanelDexEntry[]
  /** Rarity chips over the catch log, counts included. */
  dexLogFilters: PanelDexFilter[]
  /** The Wild tab. */
  wild: PanelWild
  /**
   * Settings: a companion whose last bar is full stays on stage (`true`) instead of moving on to
   * an obtained species still unregistered (`false`, the default).
   */
  keepCompletedCompanion: boolean
  /** The lure running, if any. */
  lure?: PanelLure
  /** Medals: the catalogue with what is earned, and the count. */
  medals: PanelMedals
  /** Today's and this week's challenges, for Home. Absent before the first fold of a day. */
  challenges?: PanelChallenges
  /**
   * Home's drawers, in order: one summary line each, opened in place to the detail the panel
   * already carries (`eggs`, `challenges`, `wild.trail`, `wild`/`lure`, `wild.streak`, the usage
   * totals). Plan 08 §8. A drawer with nothing to say is absent, never empty.
   */
  drawers: PanelDrawer[]
  /**
   * The PC box (Diego): the quick switch from the battle plate — every obtained species but the
   * one on stage, unfinished first. Picking one posts `setCompanion`.
   */
  pcBox: PanelPCBox
  /** The shop's drawers (Diego): each group with something in it, its title and a summary line. */
  shopGroups: { id: PanelShopItem['group']; title: string; summary: string }[]
  /** The lid (Diego): usage folded into it, and its three lights reading the official limits. */
  lid: PanelLid
  /** The player's avatar: a Showdown trainer slug from the core's roster. */
  trainerID: string
  /** The whole roster, for the Settings picker. */
  trainers: string[]
  language: string
  languages: { id: string; label: string }[]
  strings: PanelStrings
  /** Official limit windows, empty until a provider answers. */
  limits: PanelLimit[]
  /** The refresh-interval picker; absent until a request carries the host's setting. */
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
  | { type: 'feed'; encounterID: string; berry: string }
  | { type: 'collect'; findID: string }
  | { type: 'collectAll' }
  /** Spends tokens, so the host confirms natively with this display-only copy, like `buy`. */
  | { type: 'track'; trailID: string; title: string; priceText: string; confirmLabel?: string }
  /** `confirmText`/`confirmLabel`: display-only modal copy, present when the core asked for it. */
  | { type: 'run'; encounterID: string; confirmText?: string; confirmLabel?: string }
  | { type: 'setRefreshInterval'; seconds: number }
  | { type: 'setTrainer'; trainerID: string }
  | { type: 'setKeepCompleted'; keep: boolean }
  /** `title`/`priceText`/`confirmLabel` only label the native confirmation modal. */
  | { type: 'setLure'; speciesID: number; title: string; priceText: string; confirmLabel?: string }
  | {
      type: 'boostShiny'
      speciesID: number
      amount: number
      title: string
      priceText: string
      confirmLabel?: string
    }
  /** Choose an unlocked species (by id) as the companion; the core refuses anything else. */
  | { type: 'setCompanion'; speciesID: number }
  | { type: 'chooseStarter'; speciesID: number }
  /** Incubate an egg from the stock, or resume the paused one. */
  | { type: 'incubateEgg' }
  /**
   * Reveal the full panel. Sent by the compact card, which has no tab strip of its own: it can
   * show that wild Pokémon are waiting but cannot resolve them, so the row that says so has to
   * lead somewhere.
   */
  | { type: 'openPanel' }

/**
 * One piece of the game's news (plan 08 §7): what the store announced, for the panel to show
 * with the catch's card. Sent as `{ type: 'news', items }` only to surfaces on screen; the host
 * toasts the same headline when none is.
 */
export interface PanelNews {
  /** Style token: hatched, evolved, graduated, shiny, companion, ditto, candy, wild, legendary, medal, challenge, info. */
  kind: string
  speciesID?: number
  isShiny: boolean
  /** The toast's own sentence, localised. */
  headline: string
  /** A second line: on an evolution, the form it registered on the way. */
  detail?: string
}
