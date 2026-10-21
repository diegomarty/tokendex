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
 * time and the Pokédex by number; rarity is only a filter.
 *
 * Its consumers all decide "is this one worth more than that one": the premium egg guarantee
 * gate (an inverted order would silently let a premium egg hatch below the tier that was paid
 * for), the queue's overflow rule, and how long a wild Pokémon waits before wandering off.
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
 * `is_legendary`/`is_mythical`, which capture_rate cannot stand in for: every legendary has
 * capture_rate <= 45, but so do plenty of ordinary rares. Those two flags now ride on
 * `BaseSpecies`, so a legendary-only *pool* is expressible — `meetsRarityFloor` is the one
 * that can express it, and the guaranteed-legendary encounter is built on it. A legendary
 * **egg** is still not sold: that is a product decision, no longer a missing-data one.
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

/**
 * Whether a species is `floor` **or better** — the rarity filter every candidate pool uses.
 *
 * One rule for all four tiers, including the one `rarityIncludes` cannot answer: it is
 * `rarityFrom` compared on `sortRank`, so "rare or better" still contains legendary (as it
 * always did, since every legendary has capture_rate <= 45) and "legendary" now means exactly
 * the flagged species rather than the empty set. Identical to the old capture-rate filter for
 * common/uncommon/rare, so no pool changes shape by adopting it.
 *
 * The flags are optional because an index cached by an older version predates them. Missing
 * reads as "not legendary", which keeps the other three tiers exactly right and makes the
 * legendary pool empty rather than wrong — a reward that waits for a fresh index instead of
 * quietly handing out a Caterpie.
 */
export function meetsRarityFloor(
  floor: Rarity,
  capture: number,
  isLegendary = false,
  isMythical = false,
): boolean {
  return sortRank(rarityFrom(capture, isLegendary, isMythical)) >= sortRank(floor)
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

  /**
   * Tokens a whole line costs, which is also the sum of its stage thresholds. One fifteenth of
   * what it was (750M / 1.875B / 3B / 6B): with registration per species, the Pokédex is 328
   * lines, and at the old scale completing it cost 697B — nineteen years for someone using
   * 100M tokens a day. At this scale it is 46.5B, one to two years, and the ratios between
   * rarities (1 : 2.5 : 4 : 8) are unchanged, so everything derived from them is too.
   */
  graduationTotal(rarity: Rarity): number {
    switch (rarity) {
      case 'common':
        return 50_000_000
      case 'uncommon':
        return 125_000_000
      case 'rare':
        return 200_000_000
      case 'legendary':
        return 400_000_000
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
  'oranBerry',
  'nanabBerry',
  'razzBerry',
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

/**
 * Items offered to a wild Pokémon instead of thrown at it. Their own union for the same reason
 * as `BALL_KINDS`: the feeding rule cannot be handed a Master Ball, and the host validates a slug
 * from the webview against this list before it reaches the store.
 */
export const BERRY_KINDS = ['oranBerry', 'nanabBerry', 'razzBerry'] as const
export type BerryKind = (typeof BERRY_KINDS)[number]

export function isBerryKind(kind: string): kind is BerryKind {
  return (BERRY_KINDS as readonly string[]).includes(kind)
}

/**
 * Berry balance — the skill path for hard targets.
 *
 * Priced like a Poké Ball's little sibling: a berry is a turn spent *not* throwing, so it must be
 * cheaper than the ball it saves, and calming a legendary takes several. Berries change mood only
 * — the numbers they move live in `encounters.ts`, next to the rules that read them.
 */
export const Berry = {
  price: {
    oranBerry: 3_000_000,
    nanabBerry: 3_000_000,
    razzBerry: 8_000_000,
  } as Record<BerryKind, number>,
} as const

/**
 * Whether the shop also sells this item as a ten-pack. Balls and berries are bought by the
 * handful; the Master Ball is sold singly on purpose (see `Pokeball.bundleSize`). The **only**
 * answer to that question — the shop rows and the host's purchase check both read it, so the two
 * cannot disagree about which packs exist.
 */
export function itemIsBundled(kind: ItemKind): boolean {
  return kind === 'pokeBall' || kind === 'greatBall' || kind === 'ultraBall' || isBerryKind(kind)
}

/** Rare Candy balance. */
export const RareCandy = {
  /**
   * What one candy is worth: this share of the *current stage's* threshold, never a fixed
   * figure. A fixed 100M was two whole common lines at the registration scale and nothing at
   * all against a legendary; a share is worth the same at any scale and can never register a
   * species on its own. See `rareCandyXP` in `registry.ts`.
   */
  stageShare: 0.25,
  /**
   * How many candies one species will take, ever. Two cover half a stage at most, so the
   * weekly grant of five cannot turn registration into a purchase.
   */
  maxPerSpecies: 2,
  /** Granted when a weekly limit window hits 100% (session windows grant 1). */
  weeklyGrant: 5,
  /**
   * Shop price. Tokens double as growth meter and shop wallet, so a candy priced at its XP
   * value would be free extra growth; the price is deliberately far above what a candy is
   * worth at any stage, and the free grant at 100% usage always stays the better deal.
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
 * `EncounterBalance.threshold` (2M) of spend, so a Poké Ball at 5M means roughly two
 * encounters' worth of work per throw. That is a real cost without ever gating the feature —
 * whereas pricing balls next to a Mint (100M) would make the whole tab unreachable.
 *
 * The Master Ball is deliberately half a Shiny Charm: a legendary is ~3% per Poké Ball (13% over a whole encounter), so
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
    case 'oranBerry':
      return 'oran-berry'
    case 'nanabBerry':
      return 'nanab-berry'
    case 'razzBerry':
      return 'razz-berry'
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
    case 'oranBerry':
    case 'nanabBerry':
    case 'razzBerry':
      return '🫐'
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
    case 'oranBerry':
    case 'nanabBerry':
    case 'razzBerry':
      return Berry.price[kind]
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

// MARK: - Type

/** The eighteen elemental types, as PokéAPI spells them. A wild encounter's terrain follows them. */
export const POKEMON_TYPES = [
  'normal',
  'fire',
  'water',
  'electric',
  'grass',
  'ice',
  'fighting',
  'poison',
  'ground',
  'flying',
  'psychic',
  'bug',
  'rock',
  'ghost',
  'dragon',
  'dark',
  'steel',
  'fairy',
] as const
export type PokemonType = (typeof POKEMON_TYPES)[number]

export const isPokemonType = (v: unknown): v is PokemonType =>
  typeof v === 'string' && (POKEMON_TYPES as readonly string[]).includes(v)

/** A Pokémon has one type or two; anything else in a save is read as no types at all. */
export function pokemonTypes(value: unknown): PokemonType[] | undefined {
  if (!Array.isArray(value)) return undefined
  const types = [...new Set(value.filter(isPokemonType))].slice(0, 2)
  return types.length > 0 ? types : undefined
}

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

export type BattleStat = 'attack' | 'defense' | 'specialAttack' | 'specialDefense' | 'speed'

/**
 * The mainline nature effect: one stat ×1.1, another ×0.9, or neither for the five neutral ones.
 * A `Record` over every nature, so a nature added without an effect fails to compile rather than
 * quietly behaving as neutral.
 */
export const NATURE_STAT_EFFECT: Record<PokemonNature, { up?: BattleStat; down?: BattleStat }> = {
  hardy: {},
  lonely: { up: 'attack', down: 'defense' },
  brave: { up: 'attack', down: 'speed' },
  adamant: { up: 'attack', down: 'specialAttack' },
  naughty: { up: 'attack', down: 'specialDefense' },
  bold: { up: 'defense', down: 'attack' },
  docile: {},
  relaxed: { up: 'defense', down: 'speed' },
  impish: { up: 'defense', down: 'specialAttack' },
  lax: { up: 'defense', down: 'specialDefense' },
  timid: { up: 'speed', down: 'attack' },
  hasty: { up: 'speed', down: 'defense' },
  serious: {},
  jolly: { up: 'speed', down: 'specialAttack' },
  naive: { up: 'speed', down: 'specialDefense' },
  modest: { up: 'specialAttack', down: 'attack' },
  mild: { up: 'specialAttack', down: 'defense' },
  quiet: { up: 'specialAttack', down: 'speed' },
  bashful: {},
  rash: { up: 'specialAttack', down: 'specialDefense' },
  calm: { up: 'specialDefense', down: 'attack' },
  gentle: { up: 'specialDefense', down: 'defense' },
  sassy: { up: 'specialDefense', down: 'speed' },
  careful: { up: 'specialDefense', down: 'specialAttack' },
  quirky: {},
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
  /**
   * The player put this one on stage by hand while its form was already registered — to raise
   * its shiny bar, say. The move-on rule leaves it alone; evolving into a new form clears it.
   */
  chosenWhenRegistered?: boolean
}

/**
 * One species' place in the player's Pokédex: how far it is registered, and what it has been
 * through. Keyed by species id in `CompanionState.species`.
 *
 * `xp` is the experience the companion earned *as* this species; it fills up to `threshold`,
 * the stage threshold of this species inside its line (`phaseThreshold`). The threshold needs
 * the evolution line, which is network, so it is fixed the first time the species gains xp with
 * its line loaded and left undefined before that: until then xp accrues raw, the percentage is
 * clamped and nothing is ever marked registered. The Pokédex states are the **flags**, never
 * derived from xp, so a merge or a migration can only add to them.
 */
export interface SpeciesProgress {
  /** Experience earned as this species. Integer; raw until `threshold` is known. */
  xp: number
  /** Ever obtained: hatched, caught, evolved into, or chosen as a starter. */
  unlocked: boolean
  /** Ever met in the wild. */
  seen: boolean
  /** The bar was filled once. Only ever set, never cleared. */
  registered: boolean
  /** Wild catches of this species. */
  caught: number
  /** Rare Candies fed to this species, against `RareCandy.maxPerSpecies`. */
  candiesUsed: number
  /** `registerXP` of this species, fixed once its line was seen. */
  threshold?: number
  /**
   * Where the species sits in its line, fixed with `threshold`: the base to ask the line for and
   * the stage that prices it. What lets the species be chosen as the companion without guessing.
   */
  baseID?: number
  stageIndex?: number
  totalForms?: number
  /** Rarity of the *line*, which prices registration; the encounter's own rarity is separate. */
  lineRarity?: Rarity
  /** A share of registration owed (a catch before the line loaded), applied with `threshold`. */
  pendingShare?: number
  /** Experience toward the shiny form, fed only once registered. */
  shinyXP?: number
  /** The shiny form was obtained — caught, hatched or raised — even before its bar fills. */
  shinyUnlocked?: boolean
  shinyRegistered?: boolean
  /**
   * The nature it had when it last left the stage, so choosing it again brings back the same
   * Pokémon — a Mint bought for it is not rolled away by a switch.
   */
  nature?: PokemonNature
  /**
   * The companion raised as this species was shiny when it left the stage. Separate from
   * `shinyUnlocked`: catching a shiny obtains the shiny form for the collection, it does not
   * turn the Pokémon you raised shiny.
   */
  companionShiny?: boolean
}

export interface EggStock {
  count: number
  /** `yyyy-MM-dd` of the last grant; absent before the first. */
  lastGrantDay?: string
}

/** Eggs the stock holds at most. */
export const EGG_STOCK_MAX = 3

export function freshSpeciesProgress(): SpeciesProgress {
  return { xp: 0, unlocked: false, seen: false, registered: false, caught: 0, candiesUsed: 0 }
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
  /** Rolled at spawn. Shapes the temperament and is shown beside the name. */
  nature?: PokemonNature
  /**
   * Fixed at spawn from the species' base stats and the nature. Absent on an encounter from
   * before temperaments existed, which reads as neutral (`temperamentOf`).
   */
  temperament?: Temperament
  /**
   * How it feels about *you*, right now. Persisted for the same reason `throws` is: closing the
   * window must not be a free way to calm an angry Pokémon down. Absent reads as the initial mood
   * for its temperament (`moodOf`) — an old encounter is never replayed into a worse mood.
   */
  mood?: Mood
  /** A Razz Berry was eaten and the next ball is easier. Consumed by exactly one throw. */
  primed?: boolean
  /** Tokens this encounter has taken in attacks. Paid back if it is caught. */
  stolen?: number
  /** How many times the player paid to track this Pokémon back after it got away. */
  trackedCount?: number
  /**
   * Its types, primary first, from `/pokemon/{id}`. Only the scenery reads them — the terrain it
   * is met on. Absent when that request failed or on an encounter from before types were kept,
   * which is met on the terrain of its rarity instead.
   */
  types?: PokemonType[]
}

/**
 * A wild Pokémon's character, 0–100 each. Derived once, at spawn, from data that is fetched
 * then — so every rule that reads it resolves with no network, under the save's lock.
 */
export interface Temperament {
  /** From attack against defence: how easily it gets angry, and how hard it hits back. */
  aggression: number
  /** From speed: how easily it gets nervous. */
  skittishness: number
  /** From base happiness: how much a berry does for it. */
  appetite: number
}

/** The live state of one encounter, 0–100 each. */
export interface Mood {
  /** Lowers the catch value; drives attacks. */
  anger: number
  /** Drives fleeing. */
  nervousness: number
  /** Built by feeding; raises the catch value. */
  trust: number
}

/**
 * An item lying in the wild queue. Picked up with a click, no roll: the intermediate reward
 * between two Pokémon, so a long session with nothing rare still pays something out.
 */
export interface WildFind {
  id: string
  item: ItemKind
  count: number
  rarity: Rarity
  /** Epoch milliseconds. Finds wander off on the same clock as Pokémon. */
  appearedAt: number
}

/**
 * A legendary that got away, kept long enough to be tracked back for a price. Carries everything
 * needed to put the *same* Pokémon back in the queue without the network.
 */
export interface TrailEntry {
  /** The encounter it was. */
  id: string
  speciesID: number
  captureRate: number
  isShiny: boolean
  names?: Record<string, string>
  nature?: PokemonNature
  temperament?: Temperament
  types?: PokemonType[]
  /** Times already tracked; prices the next track and ends the trail at the limit. */
  trackedCount: number
  /** Epoch milliseconds: when it fled or wandered off. The trail goes cold from here. */
  lostAt: number
}

/**
 * Version of the persisted `CompanionState` shape.
 *
 * Lenient decoding absorbs *missing* fields, but it cannot express "this field changed
 * meaning" — the day a migration is needed, this number is what it branches on, and adding it
 * then would be too late: every save in the wild would already be indistinguishable. History:
 * 1 = pre-versioning saves (the field is absent), 2 = the field exists.
 *
 * Not bumped for sync (`usedByDevice`, `revision`) nor for the encounter overhaul (mood,
 * temperament, finds, the legendary trail): every one of those is additive, decodes to a default
 * when absent, and changes the meaning of nothing already on disk.
 */
export const COMPANION_STATE_SCHEMA = 2

export interface CompanionState {
  /** See `COMPANION_STATE_SCHEMA`. Absent on disk = 1. */
  saveSchema: number
  /** Tokens are only counted from install onwards. */
  installBaselineSet: boolean
  usedSinceInstall: number
  /**
   * Ledger of tokens spent in the shop. Spendable balance = usedSinceInstall + earnedTokens −
   * spentTokens (`spendableBalance`, the one definition).
   * The growth meter (usedSinceInstall) is immutable; a purchase only raises this, so buying
   * never rewinds growth.
   */
  spentTokens: number
  /**
   * Tokens the game paid out — a duplicate catch, for instance. Grow-only, like `spentTokens`:
   * the wallet is `usedSinceInstall + earnedTokens − spentTokens`, and a payout is never a
   * negative spend, because `spentTokens` is clamped at zero and would swallow it.
   */
  earnedTokens: number
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
  /**
   * Lifetime encounters **paid for out of usage**, so the cheaper first-encounter threshold
   * applies exactly once.
   *
   * A granted legendary does not count: it spends no `encounterUsage`, so counting it would
   * quietly consume a new player's cheap first encounter and charge them the full threshold for a
   * gift they were given.
   */
  encountersSeen: number
  /** Pokémon Showdown trainer slug. Absent = the roster default. */
  trainerID?: string
  /**
   * A setting: a companion whose last bar is full stays on stage (its tokens wait for the shiny
   * bar) instead of moving on to an obtained species still unregistered. Absent = move on, the
   * default Diego chose.
   */
  keepCompletedCompanion?: boolean
  /** Epoch ms of the last encounter toast, for the one-per-hour cap. */
  lastEncounterToastAt?: number
  /**
   * Local `yyyy-MM-dd` days on which usage was actually **accrued** — not days the editor was
   * open. Written by `noteAccrualDay`, which dedupes and prunes to `StreakBalance.windowDays`,
   * so this array is bounded on disk and a day counts once however many refreshes land in it.
   *
   * Absent in an older save, which decodes to an empty array: the streak then starts from the
   * next accrual, so an upgrade can never retro-award a legendary for days nobody recorded.
   */
  accrualDays: string[]
  /**
   * The day a streak legendary was last awarded. The one-per-rolling-window guard, and the
   * only thing stopping the two overlapping streak rules from paying twice for one week.
   */
  lastStreakAwardDate?: string
  /**
   * Lifetime-usage milestones already paid out: `floor(usedSinceInstall / MilestoneBalance.tokens)`
   * as of the last award. A ratchet, so crossing several at once awards one and a reload
   * re-awards none.
   *
   * **Seeded, not defaulted, when the key is absent** (see `persistence.ts`): an existing save
   * with billions of lifetime tokens must upgrade silently, not hand over a legendary for
   * usage that predates the feature.
   */
  milestonesAwarded: number
  /**
   * Guaranteed-legendary encounters earned and not yet materialised.
   *
   * Reason-free on purpose — see `grantLegendaryEncounter`. Held rather than delivered when
   * the queue is full or the species index is unavailable, so a reward is deferred, never
   * lost, and never forces a legendary out of the queue to make room for itself.
   */
  owedLegendaryEncounters: number
  /**
   * Lifetime tokens accrued **on each device**, keyed by `DeviceIdentity.id`.
   *
   * What lets two machines merge without losing or doubling growth: the tokens one side has
   * not seen are exactly `other[d] − this[d]` for every device `d`, and each line only ever
   * grows, so the merge is a per-key max (a grow-only counter, `docs/sync.md` §3.1). Starts
   * empty — usage from before this field existed stays in `usedSinceInstall` and never travels,
   * because nothing can tell whose it was.
   */
  usedByDevice: Record<string, number>
  /**
   * Committed changes per device, keyed by `DeviceIdentity.id`: a version vector.
   *
   * Merging two saves needs to know whether one already contains the other (adopt it, nothing
   * lost) or whether both moved since they last met (a fork). That is decided from these
   * counters, **never from a wall clock**: a skewed clock would hand every fork to the wrong
   * machine, permanently (`docs/sync.md` §7.5).
   */
  revision: Record<string, number>
  /** Items waiting in the wild area. They share the queue's room with the Pokémon. */
  finds: WildFind[]
  /** Legendaries that got away and can still be tracked back. */
  legendaryTrail: TrailEntry[]
  /**
   * Whether the next time the queue fills it is worth a notification. Cleared when the "full"
   * notice fires and set again once a slot frees, so a queue that stays full announces itself
   * once, not on every refresh. This machine's own, like `lastEncounterToastAt`.
   */
  queueFullArmed: boolean
  /**
   * Free eggs: one a day, up to `EGG_STOCK_MAX`. Granted on a day with real usage, beside the
   * accrual day; `lastGrantDay` is that day, so a second refresh the same day grants nothing.
   */
  eggStock: EggStock
  /**
   * Registration per species, keyed by species id. Absent on a save from before it existed:
   * decoding seeds every species the save already had as unlocked at 0% (`seedRegistry`).
   */
  species: Record<number, SpeciesProgress>
}

export function freshCompanionState(hostLanguage?: string): CompanionState {
  return {
    saveSchema: COMPANION_STATE_SCHEMA,
    installBaselineSet: false,
    usedSinceInstall: 0,
    spentTokens: 0,
    earnedTokens: 0,
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
    accrualDays: [],
    milestonesAwarded: 0,
    owedLegendaryEncounters: 0,
    usedByDevice: {},
    revision: {},
    finds: [],
    legendaryTrail: [],
    queueFullArmed: true,
    eggStock: { count: 0 },
    species: {},
  }
}
