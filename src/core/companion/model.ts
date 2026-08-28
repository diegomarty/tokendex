/**
 * Companion domain model.
 *
 * Balance constants are calibrated against measured real usage (~253M tokens/day), so they
 * are copied verbatim rather than re-derived. The comments explaining *why* a number is what
 * it is are the valuable part — several encode balance traps that were found the hard way.
 */

// MARK: - Display state

/** Decided by usage and burn rate; drives sprite motion and the status phrase. */
export type CompanionStateKind = 'egg' | 'idle' | 'working' | 'focus' | 'tired' | 'sleep' | 'levelUp'

// MARK: - Language

export const APP_LANGUAGES = ['ko', 'en', 'ja', 'es'] as const
export type AppLanguage = (typeof APP_LANGUAGES)[number]

/** PokéAPI `language.name` candidates, first match wins. */
export function apiCodes(lang: AppLanguage): string[] {
  switch (lang) {
    case 'ko':
      return ['ko']
    case 'en':
      return ['en']
    case 'ja':
      return ['ja-Hrkt', 'ja']
    case 'es':
      return ['es']
  }
}

export function languageLabel(lang: AppLanguage): string {
  switch (lang) {
    case 'ko':
      return '한국어'
    case 'en':
      return 'English'
    case 'ja':
      return '日本語'
    case 'es':
      return 'Español'
  }
}

/** Picks this language's name from a `langCode -> name` map, falling back to English. */
export function resolveName(lang: AppLanguage, byLang: Record<string, string>): string | undefined {
  for (const code of apiCodes(lang)) {
    const name = byLang[code]
    if (name !== undefined) return name
  }
  return byLang['en']
}

/**
 * Default for a fresh install, inferred from the host language. Only ko/ja/es match; anything
 * else is English. Existing users keep whatever they saved — this is a global product, so
 * never force Korean.
 */
export function systemDefaultLanguage(hostLanguage?: string): AppLanguage {
  const raw = (hostLanguage ?? Intl.DateTimeFormat().resolvedOptions().locale).slice(0, 2).toLowerCase()
  if (raw === 'ko' || raw === 'ja' || raw === 'es') return raw
  return 'en'
}

// MARK: - Rarity

export const RARITIES = ['common', 'uncommon', 'rare', 'legendary'] as const
export type Rarity = (typeof RARITIES)[number]

/**
 * Rank used to compare two rarities. **Not for sorting lists** — the catch log is ordered by
 * time and the Pokédex by number; rarity is only a filter. Its one consumer is the premium
 * egg guarantee gate, so an inverted order would silently let a premium egg hatch below the
 * tier that was paid for.
 */
export function sortRank(rarity: Rarity): number {
  return RARITIES.indexOf(rarity)
}

/**
 * Capture-rate ceiling for this tier: at or below it, a species is this tier **or better**.
 * Single source of truth for both classification and the premium-egg candidate filter —
 * writing the threshold in two places lets one drift and silently break the guarantee.
 *
 * `undefined` = a tier capture_rate cannot express. Legendaries are decided by
 * `is_legendary`/`is_mythical`, flags the hatch candidate index does not carry, so a
 * legendary-only egg cannot exist (and is not sold). Conversely every legendary has
 * capture_rate <= 45, so they fall naturally inside the uncommon/rare egg filters.
 */
export function captureRateCeiling(rarity: Rarity): number | undefined {
  switch (rarity) {
    case 'rare':
      return 45
    case 'uncommon':
      return 120
    case 'common':
      return 255
    case 'legendary':
      return undefined
  }
}

/** Legendary always returns false — capture_rate cannot decide it. */
export function rarityIncludes(rarity: Rarity, capture: number): boolean {
  const ceiling = captureRateCeiling(rarity)
  return ceiling === undefined ? false : capture <= ceiling
}

export function rarityFrom(capture: number, isLegendary: boolean, isMythical: boolean): Rarity {
  if (isLegendary || isMythical) return 'legendary'
  if (rarityIncludes('rare', capture)) return 'rare'
  if (rarityIncludes('uncommon', capture)) return 'uncommon'
  return 'common'
}

// MARK: - Token economy

/**
 * Graduation total T is identical for a rarity regardless of how many evolution stages the
 * line has. For a line of k forms, growing the i-th form costs T*i / (k(k+1)/2), which sums
 * to exactly T while making later stages progressively more expensive.
 */
export const PokemonBalance = {
  /** Tokens that must be spent before an egg hatches — anticipation rather than instant. */
  eggHatchThreshold: 5_000_000,

  graduationTotal(rarity: Rarity): number {
    switch (rarity) {
      case 'common':
        return 750_000_000
      case 'uncommon':
        return 1_875_000_000
      case 'rare':
        return 3_000_000_000
      case 'legendary':
        return 6_000_000_000
    }
  },

  /** Tokens needed at `stageIndex` (0-based) to reach the next stage or graduate. */
  phaseThreshold(rarity: Rarity, totalForms: number, stageIndex: number): number {
    const k = Math.max(1, totalForms)
    const i = stageIndex + 1 // 1-based
    const total = PokemonBalance.graduationTotal(rarity)
    const denom = (k * (k + 1)) / 2
    return Math.round((total * i) / denom)
  },
} as const

// MARK: - Items

export const ITEM_KINDS = [
  'rareCandy',
  'mint',
  'shinyCharm',
  'pokeBall',
  'greatBall',
  'ultraBall',
  'masterBall',
] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

/**
 * The four throwable items, in ascending power. A separate union from `ItemKind` so a function
 * that resolves a capture cannot be handed a Rare Candy: `isBallKind` is the only way in.
 */
export const BALL_KINDS = ['pokeBall', 'greatBall', 'ultraBall', 'masterBall'] as const
export type BallKind = (typeof BALL_KINDS)[number]

export function isBallKind(kind: ItemKind): kind is BallKind {
  return (BALL_KINDS as readonly string[]).includes(kind)
}

/** Rare Candy balance. */
export const RareCandy = {
  /**
   * XP injected into the current Pokémon. Below the smallest evolution threshold (common,
   * single form, 125M) so one candy can never advance more than a single stage.
   */
  xp: 100_000_000,
  /** Granted when a weekly limit window hits 100% (session windows grant 1). */
  weeklyGrant: 5,
  /**
   * Shop price, 5x the XP it is worth. Tokens double as growth meter and shop wallet, so
   * pricing a candy at its XP value would make buying it free extra growth (spend 150M, grow
   * 250M). At 500M, earning that much passively already grows you 500M, so the candy is a
   * net +20% — and the free grant at 100% usage always stays the better deal.
   */
  price: 500_000_000,
} as const

/** Mint balance. */
export const Mint = {
  /**
   * Nature changes are purely cosmetic, so there is no balance basis — this is a "feel"
   * price. One fifth of a candy, cheap enough to reroll a nature until you like it. Grants
   * no growth, so no double-counting.
   */
  price: 100_000_000,
} as const

/** Shiny Charm balance — passive, bought once, never consumed. */
export const ShinyCharm = {
  /** Premium, because it upgrades luck for every future hatch (one rare graduation = 3B). */
  price: 3_000_000_000,
  /**
   * Shiny denominator while held: 1/64 -> 1/48 (+33%), an homage to the mainline Shiny Charm.
   * Doubling it (1/32) was too strong. Never retroactive — shininess is fixed at hatch.
   */
  shinyDenominator: 48,
} as const

/**
 * Pokéball balance — the only items bought to be *thrown*, at a wild encounter.
 *
 * Priced against the encounter rate rather than against the other items: one encounter costs
 * `EncounterBalance.threshold` (2.5M) of spend, so a Poké Ball at 5M means roughly two
 * encounters' worth of work per throw. That is a real cost without ever gating the feature —
 * whereas pricing balls next to a Mint (100M) would make the whole tab unreachable.
 *
 * The Master Ball is deliberately half a Shiny Charm: a legendary is ~3.6% per Poké Ball, so
 * the guaranteed catch has to be a decision, not a purchase.
 */
export const Pokeball = {
  price: {
    pokeBall: 5_000_000,
    greatBall: 15_000_000,
    ultraBall: 40_000_000,
    masterBall: 1_500_000_000,
  } as Record<BallKind, number>,

  /**
   * Multiplier on the species capture rate. `Infinity` is not a magic number here: the Master
   * Ball's real behaviour *is* an unconditional catch, and expressing it as a multiplier keeps
   * `catchValue` a single formula instead of a formula plus a special case.
   */
  multiplier: {
    pokeBall: 1,
    greatBall: 1.5,
    ultraBall: 2,
    masterBall: Infinity,
  } as Record<BallKind, number>,

  /**
   * Bundle offered beside the single unit, at 9x the price for 10 balls. Buying ten balls one
   * native confirmation modal at a time is unusable, and the Master Ball is sold singly on
   * purpose — a ten-pack of guaranteed catches is not a thing worth pricing.
   */
  bundleSize: 10,
  bundleMultiplier: 9,

  /**
   * Poké Balls a fresh save starts with. The first encounter arrives at 500k tokens but a ball
   * costs 5M, so without these a new user meets their first wild Pokémon and can do nothing
   * about it for ~4.5M more tokens — turning the moment this feature exists for into a
   * frustration. Five is enough for the first few encounters, not enough to skip the shop.
   */
  starterCount: 5,
} as const

/** Fresh egg (reroll) balance — discards the current Pokémon and starts a new egg. */
export const FreshEgg = {
  /**
   * Premium reroll for a hatch you dislike. The discarded Pokémon does not graduate, it
   * simply disappears, so it never touches the Pokédex or the branch-diversity odds — as if
   * never drawn. The new egg must incubate from scratch (5M) and stage growth is lost, which
   * naturally suppresses spam farming.
   */
  price: 1_000_000_000,

  /**
   * Eggs sold in the shop: no guarantee, uncommon-or-better, rare-or-better. **No
   * legendary-only egg is sold** — the floor cannot be expressed via capture_rate, and the
   * top tier should not be a guaranteed purchase. Legendaries still appear inside the
   * uncommon/rare eggs at their natural weight (~10% for a rare egg).
   */
  shopTiers: [undefined, 'uncommon', 'rare'] as (Rarity | undefined)[],

  /**
   * Guaranteed-tier price. The multiplier reuses the **existing graduation table** rather
   * than inventing a constant (common 750M : uncommon 1.875B : rare 3B = 1 : 2.5 : 4).
   *
   * Pricing by probability ratio (uncommon 7.16% : rare 6.98% ~ 1 : 2.03) would be wrong:
   * two uncommon eggs would then beat one rare egg on every axis (1.039 rare-or-better and
   * 0.104 legendary vs 1.000 and 0.100), making the higher tier strictly inferior. On the
   * graduation ratio, the top tier costs 4.00B per rare-or-better against 4.81B for repeated
   * lower-tier buys.
   */
  price_(tier: Rarity | undefined): number {
    if (tier === undefined) return FreshEgg.price
    const multiplier = PokemonBalance.graduationTotal(tier) / PokemonBalance.graduationTotal('common')
    return Math.round(FreshEgg.price * multiplier)
  },
} as const

/** PokéAPI item sprite filename (.../sprites/items/{name}.png). */
export function itemSpriteName(kind: ItemKind): string | undefined {
  switch (kind) {
    case 'rareCandy':
      return 'rare-candy'
    case 'mint':
      return undefined // PokéAPI has no mint sprite (gen 8 item) -> emoji fallback
    case 'shinyCharm':
      return 'shiny-charm'
    case 'pokeBall':
      return 'poke-ball'
    case 'greatBall':
      return 'great-ball'
    case 'ultraBall':
      return 'ultra-ball'
    case 'masterBall':
      return 'master-ball'
  }
}

/** Fallback while the sprite loads, or when there is none. */
export function itemEmoji(kind: ItemKind): string {
  switch (kind) {
    case 'rareCandy':
      return '🍬'
    case 'mint':
      return '🌿'
    case 'shinyCharm':
      return '✨'
    case 'pokeBall':
    case 'greatBall':
    case 'ultraBall':
    case 'masterBall':
      return '⚪'
  }
}

/**
 * `undefined` would make the item **free**: `shopEntryPrice` falls back to 0. Every kind must
 * therefore be answered here, and `test/companion-shop.test.ts` walks `ITEM_KINDS` to prove it —
 * a new item added without a price is the mistake that guard exists to stop.
 */
export function itemShopPrice(kind: ItemKind): number | undefined {
  switch (kind) {
    case 'rareCandy':
      return RareCandy.price
    case 'mint':
      return Mint.price
    case 'shinyCharm':
      return ShinyCharm.price
    case 'pokeBall':
    case 'greatBall':
    case 'ultraBall':
    case 'masterBall':
      return Pokeball.price[kind]
  }
}

/** Passive items are held, not consumed: bought once, shown in the bag as "active". */
export function itemIsPassive(kind: ItemKind): boolean {
  return kind === 'shinyCharm'
}

// MARK: - Shop

export type ShopEntry =
  /** `quantity` absent means one; a bundle row carries its size and pays `bundleMultiplier`. */
  { kind: 'item'; item: ItemKind; quantity?: number } | { kind: 'egg'; tier: Rarity | undefined }

export function shopEntryQuantity(entry: ShopEntry): number {
  return entry.kind === 'item' ? (entry.quantity ?? 1) : 1
}

export function shopEntryPrice(entry: ShopEntry): number {
  if (entry.kind === 'egg') return FreshEgg.price_(entry.tier)
  const unit = itemShopPrice(entry.item) ?? 0
  const quantity = entry.quantity ?? 1
  if (quantity <= 1) return unit
  // Per-unit discount rather than a flat bundle price, so the two constants stay independent:
  // changing `bundleSize` alone must not silently change what a bundle costs per ball.
  return Math.round((unit * quantity * Pokeball.bundleMultiplier) / Pokeball.bundleSize)
}

// MARK: - Candy grants

export type WindowClass = 'session' | 'weekly'

/** One provider-agnostic limit window, produced by the usage layer. */
export interface CandyWindow {
  /** Stable identifier for tier tracking — never a volatile field such as `resets_at`. */
  key: string
  /** Display name, so a notification can say why the candy arrived. */
  name: string
  kind: WindowClass
  /** 0..100+ */
  utilization: number
}

/** One grant decision, kept pure and separate from the side effects (inventory, toast). */
export interface CandyGrant {
  windowKey: string
  windowName: string
  count: number
}

// MARK: - Sprite availability

/**
 * Still-sprite URL for one species — the 96px PNG, not the animated GIF.
 *
 * The status bar tooltip is the one *core* consumer of a sprite URL (Markdown can embed an
 * image where a StatusBarItem cannot). It mirrors `spriteURL(id, shiny, false)` in
 * `src/webview/sprite.ts`, which cannot be imported across the bundle boundary;
 * `test/sprite.test.ts` pins the two together, the same arrangement `ANIMATED_SPECIES_MAX`
 * already lives under.
 */
export function stillSpriteURL(speciesID: number, shiny: boolean): string {
  const base = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'
  return `${base}/${shiny ? 'shiny/' : ''}${speciesID}.png`
}

/** PokéAPI's Gen-V animated assets only exist for national dex #1...649. */
export const ANIMATED_SPECIES_MAX = 649
export function hasAnimatedSprite(speciesID: number): boolean {
  return speciesID >= 1 && speciesID <= ANIMATED_SPECIES_MAX
}

// MARK: - Evolution tree

export interface EvoNode {
  speciesID: number
  children: EvoNode[]
}

/** Longest path length (number of forms). Branches are usually the same depth. */
export function evoDepth(node: EvoNode): number {
  return 1 + Math.max(0, ...node.children.map(evoDepth))
}

export function evoNodeWithID(node: EvoNode, id: number): EvoNode | undefined {
  if (node.speciesID === id) return node
  for (const child of node.children) {
    const found = evoNodeWithID(child, id)
    if (found !== undefined) return found
  }
  return undefined
}

/** Every final species reachable from this node. */
export function evoFinalIDs(node: EvoNode): number[] {
  return node.children.length === 0 ? [node.speciesID] : node.children.flatMap(evoFinalIDs)
}

/** Keeps only species that have a GIF asset, cutting the chain below an unsupported one. */
export function keepingAnimatedSprites(node: EvoNode): EvoNode | undefined {
  if (!hasAnimatedSprite(node.speciesID)) return undefined
  return {
    speciesID: node.speciesID,
    children: node.children.map(keepingAnimatedSprites).filter((n): n is EvoNode => n !== undefined),
  }
}

export type EvoLineItemContent = { kind: 'species'; id: number } | { kind: 'mystery' }
export type EvoLineItemState = 'done' | 'current' | 'future'
export interface EvoLineItem {
  content: EvoLineItemContent
  state: EvoLineItemState
}

/** Line information fixed at hatch: tree, rarity and multilingual names. */
export interface EvoLine {
  baseID: number
  tree: EvoNode
  rarity: Rarity
  /** speciesID -> (langCode -> name) */
  names: Record<number, Record<string, string>>
}

export function makeEvoLine(
  baseID: number,
  tree: EvoNode,
  rarity: Rarity,
  names: Record<number, Record<string, string>>,
): EvoLine {
  return {
    baseID,
    tree: keepingAnimatedSprites(tree) ?? { speciesID: baseID, children: [] },
    rarity,
    names,
  }
}

export function totalForms(line: EvoLine): number {
  return evoDepth(line.tree)
}

export function localizedName(line: EvoLine, id: number, lang: AppLanguage): string {
  return resolveName(lang, line.names[id] ?? {}) ?? `#${id}`
}

// MARK: - Nature

export const NATURES = [
  'hardy',
  'lonely',
  'brave',
  'adamant',
  'naughty',
  'bold',
  'docile',
  'relaxed',
  'impish',
  'lax',
  'timid',
  'hasty',
  'serious',
  'jolly',
  'naive',
  'modest',
  'mild',
  'quiet',
  'bashful',
  'rash',
  'calm',
  'gentle',
  'sassy',
  'careful',
  'quirky',
] as const
export type PokemonNature = (typeof NATURES)[number]

/** Official mainline translations, in AppLanguage order: ko, en, ja, es. */
const NATURE_NAMES: Record<PokemonNature, [string, string, string, string]> = {
  hardy: ['노력', 'Hardy', 'がんばりや', 'Fuerte'],
  lonely: ['외로움', 'Lonely', 'さみしがり', 'Huraña'],
  brave: ['용감', 'Brave', 'ゆうかん', 'Audaz'],
  adamant: ['고집', 'Adamant', 'いじっぱり', 'Firme'],
  naughty: ['개구쟁이', 'Naughty', 'やんちゃ', 'Pícara'],
  bold: ['대담', 'Bold', 'ずぶとい', 'Osada'],
  docile: ['온순', 'Docile', 'すなお', 'Dócil'],
  relaxed: ['무사태평', 'Relaxed', 'のんき', 'Plácida'],
  impish: ['장난꾸러기', 'Impish', 'わんぱく', 'Agitada'],
  lax: ['촐랑', 'Lax', 'のうてんき', 'Floja'],
  timid: ['겁쟁이', 'Timid', 'おくびょう', 'Miedosa'],
  hasty: ['성급', 'Hasty', 'せっかち', 'Activa'],
  serious: ['성실', 'Serious', 'まじめ', 'Seria'],
  jolly: ['명랑', 'Jolly', 'ようき', 'Alegre'],
  naive: ['천진난만', 'Naive', 'むじゃき', 'Ingenua'],
  modest: ['조심', 'Modest', 'ひかえめ', 'Modesta'],
  mild: ['의젓', 'Mild', 'おっとり', 'Afable'],
  quiet: ['냉정', 'Quiet', 'れいせい', 'Mansa'],
  bashful: ['수줍음', 'Bashful', 'てれや', 'Tímida'],
  rash: ['덜렁', 'Rash', 'うっかりや', 'Alocada'],
  calm: ['차분', 'Calm', 'おだやか', 'Serena'],
  gentle: ['얌전', 'Gentle', 'おとなしい', 'Amable'],
  sassy: ['건방', 'Sassy', 'なまいき', 'Grosera'],
  careful: ['신중', 'Careful', 'しんちょう', 'Cauta'],
  quirky: ['변덕', 'Quirky', 'きまぐれ', 'Rara'],
}

export function natureName(nature: PokemonNature, lang: AppLanguage): string {
  const names = NATURE_NAMES[nature]
  return names[APP_LANGUAGES.indexOf(lang)] ?? names[1]
}

// MARK: - Odds

export const PokemonOdds = {
  /** Shiny denominator 1/64. The mainline 1/4096 would never be seen at desktop-app scale. */
  shinyDenominator: 64,
  /** Ditto disguise, 1/128, and only for common lines with 2+ forms. */
  dittoDisguiseDenominator: 128,
  /** Ditto's species id — reveal only, excluded from the normal hatch pool. */
  dittoSpeciesID: 132,
} as const

// MARK: - Persisted state

export interface MonState {
  baseID: number
  /** The evolution path actually taken, reflecting branch choices. */
  pathIDs: number[]
  /** The full path chosen up front. */
  plannedPathIDs: number[]
  stageIndex: number
  usedAtStage: number
  rarity: Rarity
  totalForms: number
  /** Fixed at hatch, kept through evolution. */
  isShiny: boolean
  nature?: PokemonNature
  /** undefined = ordinary. Set = really a Ditto, disguised as this species. */
  dittoDisguise?: number
  dittoRevealed: boolean
}

/** Falls back to `baseID` when `pathIDs` is empty (corrupt save) — this is read every render. */
export function currentSpeciesID(mon: MonState): number {
  if (mon.pathIDs.length === 0) return mon.baseID
  return mon.pathIDs[Math.min(mon.stageIndex, mon.pathIDs.length - 1)] ?? mon.baseID
}

export interface DexEntry {
  id: string
  baseID: number
  finalID: number
  /** First to final species id. */
  chainOrder: number[]
  rarity: Rarity
  /** Epoch milliseconds. */
  caughtAt?: number
  isShiny: boolean
  nature?: PokemonNature
  /**
   * Per-species multilingual names, saved at graduation so the Pokédex renders names without
   * a network call and follows a language switch. Older saves lack it; the view backfills.
   */
  names?: Record<number, Record<string, string>>
  /**
   * How the entry was obtained. Absent means raised to its final form — the original and still
   * the default, so old saves need no migration. `'wild'` is a single species caught from an
   * encounter, which is why such an entry never touches `collectedFinals`: that set steers
   * evolution-branch diversity and a one-species catch is not a completed line.
   */
  source?: 'wild'
}

/**
 * A wild Pokémon that has appeared and not yet been resolved.
 *
 * Persisted, so the queue survives a restart — including `throws`, or closing the window would
 * be a free way to reset flee pressure.
 */
export interface WildEncounter {
  /**
   * Stable id echoed back by the UI. The webview is a separate bundle and may be stale after an
   * update, so it is never trusted: an unknown id fails closed rather than hitting the queue.
   */
  id: string
  speciesID: number
  /**
   * 3 (Mewtwo-class) to 255 (Caterpie-class). With the ball, the only input to the catch
   * formula — stored on the encounter so resolving a throw needs no network.
   */
  captureRate: number
  rarity: Rarity
  isShiny: boolean
  /** Epoch milliseconds. */
  appearedAt: number
  /** Balls already thrown at it. Drives escalating flee pressure. */
  throws: number
  /** langCode -> name, so the tab renders and follows a language switch offline. */
  names?: Record<string, string>
}

/**
 * Version of the persisted `CompanionState` shape.
 *
 * Lenient decoding absorbs *missing* fields, but it cannot express "this field changed
 * meaning" — the day a migration is needed, this number is what it branches on, and adding it
 * then would be too late: every save in the wild would already be indistinguishable. History:
 * 1 = pre-versioning saves (the field is absent), 2 = the field exists.
 */
export const COMPANION_STATE_SCHEMA = 2

export interface CompanionState {
  /** See `COMPANION_STATE_SCHEMA`. Absent on disk = 1. */
  saveSchema: number
  /** Tokens are only counted from install onwards. */
  installBaselineSet: boolean
  usedSinceInstall: number
  /**
   * Ledger of tokens spent in the shop. Spendable balance = usedSinceInstall - spentTokens.
   * The growth meter (usedSinceInstall) is immutable; a purchase only raises this, so buying
   * never rewinds growth.
   */
  spentTokens: number
  /** Tokens spent since the current egg appeared (incubation). Reset per egg. */
  eggUsage: number
  /**
   * Guaranteed floor for the current egg. **Must persist** — the species cannot be decided
   * at purchase time (rolling needs the network), so the guarantee is written to state and
   * read by the roll. Consumed (set to undefined) at hatch or graduation.
   */
  eggTier?: Rarity
  /** Species pre-rolled while still an egg, removing network latency at the hatch moment. */
  pendingHatchID?: number
  /**
   * Per-provider baseline for today's accrual.
   *
   * `undefined` means an older save that only had the aggregate value has not been seeded
   * from a first valid snapshot yet. The first update stores the current values as a baseline
   * only and does **not** retroactively grant past usage. An empty map is a different, normal
   * state (already seeded, no provider reported today), so the two must stay distinguishable.
   */
  claimedTodayTokensByProvider?: Record<string, number>
  lastDate: string
  /** The current Pokémon; absent means an egg. */
  active?: MonState
  dex: DexEntry[]
  /** Owned (base, final) pairs, for branch diversity. */
  collectedFinals: string[]
  language: AppLanguage
  /** ItemKind -> count */
  inventory: Record<string, number>
  /** Candy grant edge state (window key -> granted tier). Persisted to stop infinite regrants. */
  candyGrantTier: Record<string, number>
  /** First-run seed done, blocking retroactive grants for windows already at 100%. */
  candyFeatureSeeded: boolean
  /**
   * Tokens accrued toward the next wild encounter.
   *
   * Independent of `eggUsage` and `active.usedAtStage` on purpose: an encounter must accrue
   * whether you are incubating an egg or raising a Pokémon, so it cannot ride on either.
   * Carries its remainder across a spawn — never reset, or usage is silently lost.
   */
  encounterUsage: number
  /** Unresolved encounters, oldest first. */
  wild: WildEncounter[]
  /** Lifetime encounters spawned, so the cheaper first-encounter threshold applies exactly once. */
  encountersSeen: number
  /** Pokémon Showdown trainer slug. Absent = the roster default. */
  trainerID?: string
  /** Epoch ms of the last encounter toast, for the one-per-hour cap. */
  lastEncounterToastAt?: number
}

export function freshCompanionState(hostLanguage?: string): CompanionState {
  return {
    saveSchema: COMPANION_STATE_SCHEMA,
    installBaselineSet: false,
    usedSinceInstall: 0,
    spentTokens: 0,
    eggUsage: 0,
    lastDate: '',
    dex: [],
    collectedFinals: [],
    language: systemDefaultLanguage(hostLanguage),
    // See `Pokeball.starterCount`: without these, the first encounter (500k tokens) arrives
    // ~4.5M tokens before the player can afford their first ball.
    inventory: { pokeBall: Pokeball.starterCount },
    candyGrantTier: {},
    candyFeatureSeeded: false,
    encounterUsage: 0,
    wild: [],
    encountersSeen: 0,
  }
}
