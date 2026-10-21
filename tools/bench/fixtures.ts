/**
 * `PanelState` fixtures for the development bench.
 *
 * Every panel here comes out of the core's own `buildPanelState` (covered by
 * `test/panel-build.test.ts`), fed a fixture save and a fixture snapshot. A fixture describes a
 * *situation* — what is in the bag, what is waiting in the grass, how far along the companion
 * is — and every row, price and string below it is then derived exactly as the extension
 * derives it.
 *
 * That indirection is the point rather than an inconvenience. The shop, the bag and the wild
 * rack used to be hand-rolled here next to the core's version, and the copy had already lost
 * the ×10 ball bundles and the refresh-interval picker: the bench was quietly hiding two
 * sections the extension really ships, which is the exact failure a bench exists to prevent.
 *
 * Typed against the real protocol on purpose: `npm run typecheck` covers this file, so any
 * change to `PanelState` breaks here instead of silently leaving the bench rendering a shape
 * the extension no longer sends.
 */

import type {
  PanelDev,
  PanelDevControl,
  PanelEncounterResult,
  PanelState,
  PanelWalletChange,
} from '../../src/webview/protocol.js'
import {
  type AppLanguage,
  type CompanionState,
  type DexEntry,
  type EvoLine,
  type EvoNode,
  type ItemKind,
  type MonState,
  Pokeball,
  PokemonBalance,
  type Rarity,
  type SpeciesProgress,
  type PokemonType,
  type WildEncounter,
  currentSpeciesID,
  freshCompanionState,
  freshSpeciesProgress,
  resolveName,
} from '../../src/core/companion/model.js'
import { DEV_GROUPS, DEV_SCENARIOS } from '../../src/core/dev/scenarios.js'
import { registerXP } from '../../src/core/companion/registry.js'
import { EconomyBalance } from '../../src/core/companion/economy.js'
import * as D from '../../src/core/i18n/dispatch.js'
import { buildPanelState, catchBanner } from '../../src/core/panel/build.js'
import { todayKey } from '../../src/core/usage/entry.js'
import {
  type CompanionView,
  type LimitRow,
  type ProviderReport,
  buildSnapshot,
} from '../../src/core/snapshot.js'

/**
 * Fixed clock and locale, never `Date.now()`: a bench that renders a different string on every
 * reload makes "did my change do that?" impossible to answer.
 */
const EPOCH = Date.parse('2026-08-19T10:00:00Z')
const LOCALE = 'en-US'
const DAY = 86_400_000

/** Species names are the English PokéAPI ones — the bench is about layout, not translation. */
const NAMES: Record<number, string> = {
  1: 'Bulbasaur',
  2: 'Ivysaur',
  3: 'Venusaur',
  4: 'Charmander',
  5: 'Charmeleon',
  6: 'Charizard',
  7: 'Squirtle',
  8: 'Wartortle',
  9: 'Blastoise',
  10: 'Caterpie',
  25: 'Pikachu',
  26: 'Raichu',
  39: 'Jigglypuff',
  52: 'Meowth',
  54: 'Psyduck',
  63: 'Abra',
  92: 'Gastly',
  93: 'Haunter',
  94: 'Gengar',
  129: 'Magikarp',
  130: 'Gyarados',
  131: 'Lapras',
  133: 'Eevee',
  134: 'Vaporeon',
  143: 'Snorlax',
  147: 'Dratini',
  148: 'Dragonair',
  149: 'Dragonite',
  150: 'Mewtwo',
  155: 'Cyndaquil',
  172: 'Pichu',
  175: 'Togepi',
  196: 'Espeon',
  197: 'Umbreon',
  249: 'Lugia',
  251: 'Celebi',
  448: 'Lucario',
  483: 'Dialga',
  494: 'Victini',
}

/**
 * One line is translated, which is all the Japanese fixture needs to show its typography — plus
 * the Pokémon of the longest catch line, measured in every language.
 */
const JA_NAMES: Record<number, string> = {
  4: 'ヒトカゲ',
  5: 'リザード',
  6: 'リザードン',
  150: 'ミュウツー',
}
const KO_NAMES: Record<number, string> = { 150: '뮤츠' }
/** Spanish keeps the English names; listed only where a fixture renders in Spanish. */
const ES_NAMES: Record<number, string> = { 150: 'Mewtwo' }

/** The per-language name map the core stores on a save and resolves at render time. */
function names(id: number): Record<string, string> {
  const out: Record<string, string> = { en: NAMES[id] ?? `#${id}` }
  if (JA_NAMES[id] !== undefined) out['ja'] = JA_NAMES[id]
  if (KO_NAMES[id] !== undefined) out['ko'] = KO_NAMES[id]
  if (ES_NAMES[id] !== undefined) out['es'] = ES_NAMES[id]
  return out
}

/** The flavour rule the fixtures have always used, so the same ids keep reading the same. */
function rarityOf(id: number): Rarity {
  if (id === 150 || id === 249 || id === 251 || id === 483) return 'legendary'
  if (id % 7 === 0) return 'rare'
  if (id % 3 === 0) return 'uncommon'
  return 'common'
}

// MARK: - Save pieces

/**
 * An evolution tree from the path it can take. `branches` turns the last step into a choice,
 * which is what puts the mystery slot in the strip — the core reads that from the tree, so a
 * fixture cannot show a branch the real rules would not draw.
 */
function evoLine(chain: number[], branches: number[] = []): EvoLine {
  let tree: EvoNode = {
    speciesID: chain[chain.length - 1]!,
    children: branches.map((id) => ({ speciesID: id, children: [] })),
  }
  for (let i = chain.length - 2; i >= 0; i--) tree = { speciesID: chain[i]!, children: [tree] }
  const byID: Record<number, Record<string, string>> = {}
  for (const id of [...chain, ...branches]) byID[id] = names(id)
  return { baseID: chain[0]!, tree, rarity: rarityOf(chain[0]!), names: byID }
}

/**
 * The Pokémon being raised. `pathIDs` holds only what it has actually reached; everything still
 * ahead of it comes from the line's tree, never from here.
 */
function mon(chain: number[], stageIndex: number, over: Partial<MonState> = {}): MonState {
  return {
    baseID: chain[0]!,
    pathIDs: chain.slice(0, stageIndex + 1),
    plannedPathIDs: chain,
    stageIndex,
    usedAtStage: 0,
    rarity: rarityOf(chain[0]!),
    totalForms: chain.length,
    isShiny: false,
    dittoRevealed: false,
    ...over,
  }
}

/**
 * A graduated catch. `chainOrder` carries the whole line rather than just the final form,
 * because that is what fills the species Pokédex.
 */
function caught(chain: number[], days: number, over: Partial<DexEntry> = {}): DexEntry {
  const finalID = chain[chain.length - 1]!
  const byID: Record<number, Record<string, string>> = {}
  for (const id of chain) byID[id] = names(id)
  return {
    id: `dex-${finalID}`,
    baseID: chain[0]!,
    finalID,
    chainOrder: chain,
    rarity: rarityOf(chain[0]!),
    caughtAt: EPOCH - days * DAY,
    isShiny: false,
    names: byID,
    ...over,
  }
}

/** Real types for the species the fixtures stage, so each scene stands on its own terrain. */
const TYPES: Record<number, PokemonType[]> = {
  6: ['fire', 'flying'],
  10: ['bug'],
  130: ['water', 'flying'],
  149: ['dragon', 'flying'],
  129: ['water'],
  133: ['normal'],
  147: ['dragon'],
  150: ['psychic'],
}

/** One queued encounter. The head of the queue is the one on stage, and it prices the rack. */
function wild(speciesID: number, over: Partial<WildEncounter> = {}): WildEncounter {
  const types = TYPES[speciesID]
  return {
    ...(types === undefined ? {} : { types }),
    id: `w-${speciesID}`,
    speciesID,
    captureRate: 45,
    rarity: rarityOf(speciesID),
    isShiny: false,
    appearedAt: EPOCH - 60_000,
    throws: 0,
    names: names(speciesID),
    ...over,
  }
}

// MARK: - Usage pieces

const LIMITS: LimitRow[] = [
  { label: '5-hour session', value: '42%', percent: 42, severity: 'normal' },
  { label: 'Weekly', value: '37%', percent: 37, severity: 'normal' },
]

interface UsageOptions {
  todayTokens?: number
  todayCost?: number
  monthTokens?: number
  monthCost?: number
}

/**
 * Two providers whose rows add up to the totals, because the snapshot derives the totals from
 * the reports — a fixture that wrote both would be free to make them disagree, which is the one
 * thing a breakdown table is read for. Only the totals reach the panel, so the per-model
 * breakdown fields stay at zero.
 */
function providers(options: UsageOptions): ProviderReport[] {
  const today = options.todayTokens ?? 253_412_890
  const month = options.monthTokens ?? 4_812_004_331
  const todayCost = options.todayCost ?? 41.82
  const monthCost = options.monthCost ?? 812.4
  const split = (whole: number, share: number) => Math.round(whole * share)
  const daily = (tokens: number, cost: number) => ({
    date: '2026-08-19',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: tokens,
    totalCost: cost,
  })
  const leadToday = split(today, 0.72)
  const leadMonth = split(month, 0.7)
  return [
    {
      providerID: 'claude_code',
      displayName: 'Claude Code',
      entries: 4820,
      today: daily(leadToday, todayCost * 0.72),
      month: { period: '2026-08', totalTokens: leadMonth, totalCost: monthCost * 0.7 },
      // Only one provider burns: the /min column appears exactly when something is running,
      // and a bench where it never appears is a bench that never renders it.
      tokensPerMinute: 184_000,
    },
    {
      providerID: 'codex',
      displayName: 'Codex',
      entries: 1204,
      today: daily(today - leadToday, todayCost * 0.28),
      month: { period: '2026-08', totalTokens: month - leadMonth, totalCost: monthCost * 0.3 },
    },
  ]
}

// MARK: - Scenes

interface SceneOptions extends UsageOptions {
  lang?: AppLanguage
  spendable?: number
  inventory?: Partial<Record<ItemKind, number>>
  /** Absent means an egg: nothing on stage, and no egg shelf in the shop. */
  mon?: MonState
  line?: EvoLine
  /** Present = there is something to draw on Home. The rest of the view is filled in below. */
  companion?: Partial<CompanionView>
  dex?: DexEntry[]
  wild?: WildEncounter[]
  finds?: CompanionState['finds']
  legendaryTrail?: CompanionState['legendaryTrail']
  limits?: LimitRow[]
  errors?: string[]
  dev?: PanelDev
  /** Days back from the fixture clock on which usage accrued, for the streak row. */
  streakDaysAgo?: number[]
  /** Days back from the fixture clock on which this window's legendary was earned. */
  awardDaysAgo?: number
  /**
   * The registry. Absent: derived from what the fixture shows — every graduated line
   * registered, the companion's earlier forms registered and its current one at the view's
   * progress. Pass it to draw specific states (seen, partial, shiny).
   */
  species?: CompanionState['species']
  eggStock?: CompanionState['eggStock']
  /** Usage already in an egg. Defaults to the view's progress when there is no companion. */
  eggUsage?: number
  /** A brand-new save: nothing at all, so the panel asks for a starter. */
  fresh?: boolean
  /** The balance before this panel, so the builder emits the wallet chip for the change. */
  walletFrom?: number
}

/** The registry a fixture implies, with the bar of the form on stage at `progress`. */
function impliedSpecies(state: CompanionState, progress: number): CompanionState['species'] {
  const species: CompanionState['species'] = {}
  const set = (id: number, over: Partial<SpeciesProgress>) => {
    species[id] = { ...(species[id] ?? freshSpeciesProgress()), unlocked: true, ...over }
  }
  for (const entry of state.dex) {
    for (const id of entry.chainOrder) set(id, { registered: true, lineRarity: entry.rarity })
  }
  const active = state.active
  if (active !== undefined) {
    active.pathIDs.forEach((id, stage) => {
      const threshold = registerXP(active.rarity, active.totalForms, stage)
      const reached = stage < active.stageIndex
      if (species[id]?.registered === true) return
      set(id, {
        threshold,
        lineRarity: active.rarity,
        registered: reached,
        xp: reached ? threshold : Math.round(progress * threshold),
      })
    })
  }
  return species
}

/** Enough balls to throw and one candy to spend — the default a fixture rarely needs to change. */
const DEFAULT_INVENTORY: Partial<Record<ItemKind, number>> = {
  pokeBall: Pokeball.starterCount,
  rareCandy: 3,
}

function scene(options: SceneOptions = {}): PanelState {
  const lang = options.lang ?? 'en'
  const spendable = options.spendable ?? 1_204_000_000
  const state: CompanionState = {
    ...freshCompanionState(lang),
    language: lang,
    installBaselineSet: true,
    usedSinceInstall: spendable,
    inventory: { ...(options.inventory ?? DEFAULT_INVENTORY) },
    dex: options.dex ?? [],
    wild: options.wild ?? [],
    finds: options.finds ?? [],
    legendaryTrail: options.legendaryTrail ?? [],
    // Pinned so the "next encounter" line always reads 1.2M and its bar 52%.
    encounterUsage: 1_300_000,
    encountersSeen: 3,
    // The streak row is built from these by the real `streakWindow`, so a fixture says which
    // days a player worked and the panel decides what that draws.
    accrualDays: (options.streakDaysAgo ?? []).map((n) => todayKey(EPOCH - n * DAY)),
  }
  if (options.awardDaysAgo !== undefined) {
    state.lastStreakAwardDate = todayKey(EPOCH - options.awardDaysAgo * DAY)
  }
  if (options.mon !== undefined) {
    // The stage meter at the view's progress, so the EXP bar reads what the fixture says.
    const mon = options.mon
    const threshold = registerXP(mon.rarity, mon.totalForms, mon.stageIndex)
    state.active = { ...mon, usedAtStage: Math.round((options.companion?.progress ?? 0.5) * threshold) }
  }
  if (options.eggStock !== undefined) state.eggStock = options.eggStock
  if (options.fresh !== true) {
    state.species = options.species ?? impliedSpecies(state, options.companion?.progress ?? 0.5)
    // An egg fixture is an egg under way, not a new game: give it the usage its bar shows.
    state.eggUsage =
      options.eggUsage ??
      (options.mon === undefined
        ? Math.max(1, Math.round((options.companion?.progress ?? 0) * PokemonBalance.eggHatchThreshold))
        : 0)
  }

  const over = options.companion
  let view: CompanionView | undefined
  if (over !== undefined) {
    const speciesID = options.mon === undefined ? undefined : currentSpeciesID(options.mon)
    view = {
      state: options.mon === undefined ? 'egg' : 'working',
      isShiny: options.mon?.isShiny ?? false,
      progress: 0.5,
      toNextText: '',
      dexCount: state.dex.length,
      spendableTokens: spendable,
      wildCount: state.wild.length,
      wildTooltip: D.wildBadgeTooltip(lang, state.wild.length),
      ...(speciesID === undefined
        ? {}
        : { speciesID, name: resolveName(lang, names(speciesID)) ?? `#${speciesID}` }),
      ...over,
    }
  }

  return buildPanelState({
    usage: buildSnapshot([], {
      now: EPOCH,
      locale: LOCALE,
      lang,
      providers: providers(options),
      limitRows: options.limits ?? LIMITS,
      errors: options.errors ?? [],
      ...(view === undefined ? {} : { companion: view }),
    }),
    state,
    line: options.line,
    isCelebrating: false,
    now: EPOCH,
    locale: LOCALE,
    // The host's own default (`tokendex.refreshInterval`), so Settings shows its picker here too.
    refreshSeconds: 120,
    ...(options.walletFrom === undefined
      ? {}
      : { walletChange: { previous: options.walletFrom, id: 1 } }),
    ...(options.dev === undefined ? {} : { dev: options.dev }),
  })
}

/**
 * The Dev tab exactly as the worker builds it — same table, same grouping. The summary is a
 * fixture because it depends on live state the bench does not have.
 */
function devSection(): PanelDev {
  return {
    summary: [
      { label: 'Companion', value: '#4 · stage 1/3 · common' },
      { label: 'To next evolution', value: '82.5M' },
      { label: 'To graduation', value: '703.4M' },
      { label: 'Lifetime tokens', value: '1.5B' },
      { label: 'Spent in the shop', value: '300M' },
      { label: 'Synthetic offsets', value: 'claude_code +120M' },
      { label: 'Date override', value: '2099-01-07' },
    ],
    groups: DEV_GROUPS.map((group) => ({
      title: group.title,
      controls: DEV_SCENARIOS.filter((scenario) => scenario.group === group.id).map((scenario) => {
        const control: PanelDevControl = {
          id: scenario.id,
          label: scenario.label,
          description: scenario.detail,
          input: scenario.input.kind === 'none' ? 'button' : scenario.input.kind,
          destructive: scenario.confirm !== undefined,
        }
        if (scenario.input.kind !== 'none') {
          control.prompt = scenario.input.prompt
          control.defaultValue = scenario.input.defaultValue
        }
        if (scenario.input.kind === 'choice') control.options = scenario.input.options
        return control
      }),
    })).filter((group) => group.controls.length > 0),
  }
}

/**
 * A catch, before and after: the scene with `species` on stage, and what the host replies — the
 * core's own result line, and for a duplicate the panel rebuilt with the reward in the wallet,
 * so the chip is the builder's, not a mock-up.
 */
function catchFixture(
  id: string,
  label: string,
  lang: AppLanguage,
  species: number,
  rarity: Rarity,
  outcome: { registeredPercent?: number; reward?: number; refunded?: number },
): Fixture {
  const spendable = 1_204_000_000
  const encounter = wild(species, { rarity })
  const base: SceneOptions = {
    lang,
    spendable,
    inventory: { pokeBall: 7, greatBall: 2, ultraBall: 3, masterBall: 1 },
    wild: [encounter, wild(10)],
    mon: mon([4, 5, 6], 1),
    line: evoLine([4, 5, 6]),
    companion: { progress: 0.35, stageText: D.stage(lang, 2, 3), toNextText: '11M' },
  }
  const state = scene(base)
  const name = state.wild.encounters[0]!.name
  const resultText = D.turnResultText(
    lang,
    { kind: 'caught', refunded: outcome.refunded ?? 0, ...outcome },
    { name, isShiny: false, item: 'ultraBall', trailHours: 0 },
  )
  // The core's own banner, from the save as it was before the catch: nothing of this species yet.
  const catchNews = catchBanner(lang, freshCompanionState(lang), species, {
    kind: 'caught',
    refunded: outcome.refunded ?? 0,
    ...outcome,
  })
  const gained = (outcome.reward ?? 0) + (outcome.refunded ?? 0)
  if (gained === 0) return { id, label, state, throwResult: { resultText, catchNews } }
  const after = scene({ ...base, spendable: spendable + gained, walletFrom: spendable })
  return {
    id,
    label,
    state,
    throwResult: {
      resultText,
      catchNews,
      spendableText: after.spendableText,
      ...(after.walletChange === undefined ? {} : { walletChange: after.walletChange }),
    },
  }
}

export interface Fixture {
  id: string
  label: string
  state: PanelState
  /**
   * What the bench's stand-in host replies to a `?throw=` on this fixture: the result line and,
   * when the catch pays, the wallet's new balance and the chip that animates the rise. Absent:
   * a plain "Gotcha!".
   */
  throwResult?: {
    resultText: string
    catchNews?: PanelEncounterResult['catchNews']
    spendableText?: string
    walletChange?: PanelWalletChange
  }
}

/** Every case worth eyeballing after a UI change. Add one rather than editing another. */
export const FIXTURES: Fixture[] = [
  {
    id: 'no-limits',
    label: 'Sin límites conocidos (sección ausente)',
    state: scene({ limits: [] }),
  },
  {
    id: 'wild-queue',
    label: 'Home scene: queue with a shiny and a legendary, full rack',
    state: scene({
      inventory: { pokeBall: 7, greatBall: 2, ultraBall: 1, masterBall: 1, rareCandy: 3 },
      // Dratini is on stage, and its capture rate prices the whole rack: 24 / 33 / 41 / 100%.
      wild: [wild(147), wild(129, { isShiny: true }), wild(10), wild(150)],
      mon: mon([172, 25, 26], 1),
      line: evoLine([172, 25, 26]),
      companion: {
        progress: 0.71,
        stageText: D.stage('en', 2, 3),
        toNextText: '21.7M to next evolution',
      },
      dex: [caught([129], 0, { id: 'dex-wild-129', source: 'wild' }), caught([1, 2, 3], 12)],
    }),
  },
  {
    id: 'wild-mood',
    label: 'Home scene: an angry legendary with a temperament, berries, finds and a trail',
    state: scene({
      inventory: { pokeBall: 7, greatBall: 2, ultraBall: 3, oranBerry: 4, nanabBerry: 2, razzBerry: 1 },
      wild: [
        wild(150, {
          captureRate: 3,
          nature: 'adamant',
          temperament: { aggression: 86, skittishness: 75, appetite: 20 },
          mood: { anger: 72, nervousness: 48, trust: 10 },
          stolen: 4_000_000,
          primed: true,
        }),
        wild(10),
        wild(129),
      ],
      finds: [
        { id: 'f1', item: 'pokeBall', count: 2, rarity: 'uncommon', appearedAt: EPOCH - 60_000 },
        { id: 'f2', item: 'razzBerry', count: 1, rarity: 'common', appearedAt: EPOCH - 60_000 },
        { id: 'f3', item: 'ultraBall', count: 3, rarity: 'legendary', appearedAt: EPOCH - 60_000 },
      ],
      legendaryTrail: [
        {
          id: 'lost-249',
          speciesID: 249,
          captureRate: 3,
          isShiny: false,
          names: names(249),
          trackedCount: 1,
          lostAt: EPOCH - 5 * 3_600_000,
        },
      ],
      mon: mon([172, 25, 26], 1),
      line: evoLine([172, 25, 26]),
      companion: {
        progress: 0.71,
        stageText: D.stage('en', 2, 3),
        toNextText: '21.7M to next evolution',
      },
    }),
  },
  {
    id: 'wild-no-balls',
    label: 'Home scene: encounter waiting, empty rack (shop hint)',
    state: scene({ inventory: { rareCandy: 3 }, wild: [wild(133)] }),
  },
  {
    id: 'wild-empty',
    label: 'Home scene: nothing waiting, companion on stage',
    state: scene(),
  },
  // The four states of the streak row, which is otherwise only reachable by waiting a week.
  {
    id: 'streak-empty',
    label: 'Streak row: no days worked yet',
    state: scene({ mon: mon([172, 25, 26], 1), line: evoLine([172, 25, 26]) }),
  },
  {
    id: 'streak-partway',
    label: 'Streak row: two of three days',
    state: scene({
      streakDaysAgo: [3, 0],
      mon: mon([172, 25, 26], 1),
      line: evoLine([172, 25, 26]),
    }),
  },
  {
    id: 'streak-earned',
    label: 'Streak row: the third day just paid out',
    state: scene({
      streakDaysAgo: [2, 1, 0],
      awardDaysAgo: 0,
      mon: mon([172, 25, 26], 1),
      line: evoLine([172, 25, 26]),
    }),
  },
  {
    id: 'streak-paid',
    label: 'Streak row: paid earlier in the week, still working',
    state: scene({
      streakDaysAgo: [4, 3, 2, 1, 0],
      awardDaysAgo: 2,
      mon: mon([172, 25, 26], 1),
      line: evoLine([172, 25, 26]),
    }),
  },
  {
    id: 'egg-early',
    label: 'Freshly laid egg (nothing to show)',
    state: scene({
      todayTokens: 312_004,
      todayCost: 0.61,
      monthTokens: 312_004,
      monthCost: 0.61,
      spendable: 312_004,
      inventory: {},
      companion: { progress: 0.06, toNextText: '4.7M to hatch' },
    }),
  },
  {
    id: 'egg-almost',
    label: 'Egg almost ready',
    state: scene({
      spendable: 4_600_000,
      companion: { progress: 0.92, toNextText: '400K to hatch' },
    }),
  },
  {
    id: 'hatched-linear',
    label: 'Just hatched, linear line (1/3)',
    state: scene({
      mon: mon([1, 2, 3], 0, { nature: 'brave' }),
      line: evoLine([1, 2, 3]),
      companion: {
        progress: 0.34,
        stageText: D.stage('en', 1, 3),
        toNextText: '82.5M to next evolution',
      },
    }),
  },
  {
    id: 'branching',
    label: 'Undecided branch (the question mark)',
    state: scene({
      mon: mon([133], 0, { nature: 'jolly' }),
      line: evoLine([133], [134, 196, 197]),
      companion: {
        progress: 0.71,
        stageText: D.stage('en', 1, 2),
        toNextText: '21.7M to next evolution',
      },
    }),
  },
  {
    id: 'shiny-final',
    label: 'Shiny in its final stage (heading for graduation)',
    state: scene({
      spendable: 6_400_000_000,
      inventory: { pokeBall: Pokeball.starterCount, rareCandy: 12, mint: 2, shinyCharm: 1 },
      mon: mon([4, 5, 6], 2, { isShiny: true, nature: 'adamant' }),
      line: evoLine([4, 5, 6]),
      companion: {
        progress: 0.88,
        stageText: D.stage('en', 3, 3),
        toNextText: '45M to graduation',
      },
      dex: [caught([172, 25, 26], 3), caught([133, 134], 11)],
    }),
  },
  {
    id: 'dex-full',
    label: 'Populated Pokédex (25 species, 12 catches)',
    state: scene({
      mon: mon([147, 148, 149], 1),
      line: evoLine([147, 148, 149]),
      companion: {
        progress: 0.44,
        stageText: D.stage('en', 2, 3),
        toNextText: '120M to next evolution',
      },
      dex: [
        caught([150], 1, { isShiny: true }),
        caught([92, 93, 94], 4, { isShiny: true }),
        caught([129, 130], 6),
        caught([143], 8),
        caught([172, 25, 26], 12),
        caught([1, 2, 3], 15),
        caught([4, 5, 6], 19),
        caught([7, 8, 9], 24),
        caught([39], 30),
        caught([133, 134], 33),
        caught([10], 41),
      ],
    }),
  },
  {
    id: 'starter',
    label: 'First run: pick a starter',
    state: scene({ fresh: true, inventory: {} }),
  },
  {
    id: 'registry-states',
    label: 'Pokédex: seen, unlocked at a share, registered, shiny unlocked and registered',
    state: scene({
      mon: mon([4, 5, 6], 1),
      line: evoLine([4, 5, 6]),
      companion: { progress: 0.35, stageText: D.stage('en', 2, 3), toNextText: '11M to next evolution' },
      dex: [caught([1, 2, 3], 9), caught([129, 130], 4, { isShiny: true })],
      species: {
        1: { ...freshSpeciesProgress(), unlocked: true, registered: true },
        2: { ...freshSpeciesProgress(), unlocked: true, registered: true, shinyUnlocked: true },
        3: { ...freshSpeciesProgress(), unlocked: true, xp: 6_000_000, threshold: 25_000_000 },
        4: { ...freshSpeciesProgress(), unlocked: true, registered: true },
        5: { ...freshSpeciesProgress(), unlocked: true, xp: 5_950_000, threshold: 17_000_000 },
        7: { ...freshSpeciesProgress(), unlocked: true, xp: 2_000_000, threshold: 8_000_000 },
        16: { ...freshSpeciesProgress(), seen: true },
        19: { ...freshSpeciesProgress(), seen: true },
        25: { ...freshSpeciesProgress(), seen: true },
        129: {
          ...freshSpeciesProgress(),
          unlocked: true,
          registered: true,
          shinyUnlocked: true,
          shinyRegistered: true,
        },
        130: { ...freshSpeciesProgress(), unlocked: true, registered: true },
      },
    }),
  },
  {
    id: 'eggs-stock',
    label: 'Home: two eggs in stock, a companion on stage',
    state: scene({
      mon: mon([4, 5, 6], 1),
      line: evoLine([4, 5, 6]),
      companion: { progress: 0.35, stageText: D.stage('en', 2, 3), toNextText: '11M to next evolution' },
      eggStock: { count: 2 },
    }),
  },
  {
    id: 'egg-paused',
    label: 'Home: an egg set aside for a companion, none in stock',
    state: scene({
      mon: mon([4, 5, 6], 1),
      line: evoLine([4, 5, 6]),
      companion: { progress: 0.35, stageText: D.stage('en', 2, 3), toNextText: '11M to next evolution' },
      eggUsage: 2_400_000,
    }),
  },
  catchFixture('catch-first', 'Catch: a first catch registers the species at 5%', 'en', 147, 'rare', {
    registeredPercent: 5,
  }),
  catchFixture('catch-duplicate', 'Catch: a duplicate pays tokens into the wallet', 'en', 10, 'common', {
    reward: EconomyBalance.duplicateReward.common,
  }),
  // The longest result line there is: a legendary duplicate that also refunds a theft.
  ...(['en', 'ko', 'ja', 'es'] as const).map((lang) =>
    catchFixture(
      `catch-longest-${lang}`,
      `Catch: the longest result line (${lang})`,
      lang,
      150,
      'legendary',
      {
        reward: EconomyBalance.duplicateReward.legendary,
        refunded: 3_000_000,
      },
    ),
  ),
  {
    id: 'plate-quarter',
    label: 'Player plate: the EXP bar a quarter of the way through its stage',
    state: scene({
      mon: mon([4, 5, 6], 1),
      line: evoLine([4, 5, 6]),
      companion: {
        progress: 0.25,
        stageText: D.stage('en', 2, 3),
        toNextText: '12.5M to next evolution',
      },
      wild: [wild(147)],
    }),
  },
  {
    id: 'plate-registered',
    label: 'Player plate: a final form registered, its bar full',
    state: scene({
      mon: mon([4, 5, 6], 2),
      line: evoLine([4, 5, 6]),
      companion: { progress: 1, stageText: D.stage('en', 3, 3), toNextText: '' },
      wild: [wild(147)],
      species: {
        4: { ...freshSpeciesProgress(), unlocked: true, registered: true },
        5: { ...freshSpeciesProgress(), unlocked: true, registered: true },
        6: {
          ...freshSpeciesProgress(),
          unlocked: true,
          registered: true,
          xp: 25_000_000,
          threshold: 25_000_000,
        },
      },
    }),
  },
  {
    id: 'plate-egg',
    label: 'Player plate: an egg on its way to hatching',
    state: scene({ companion: { progress: 0.4, toNextText: '3M to hatch' }, wild: [wild(147)] }),
  },
  {
    id: 'wild-owned',
    label: 'Wild plate: a species you already have carries the Poké Ball',
    state: scene({
      mon: mon([4, 5, 6], 1),
      line: evoLine([4, 5, 6]),
      companion: { progress: 0.35, stageText: D.stage('en', 2, 3), toNextText: '11M to next evolution' },
      wild: [wild(129), wild(147)],
      dex: [caught([129, 130], 6)],
    }),
  },
  {
    id: 'wild-evolved',
    label: 'Wild: an evolved form on stage (Charizard), more evolved forms queued',
    state: scene({
      inventory: { pokeBall: 7, greatBall: 2, ultraBall: 3, masterBall: 1 },
      wild: [
        wild(6, {
          captureRate: 45,
          rarity: 'rare',
          line: { baseID: 4, stageIndex: 2, totalForms: 3, rarity: 'rare' },
        }),
        wild(149, {
          captureRate: 45,
          rarity: 'rare',
          line: { baseID: 147, stageIndex: 2, totalForms: 3, rarity: 'rare' },
        }),
        wild(130, {
          captureRate: 45,
          rarity: 'rare',
          line: { baseID: 129, stageIndex: 1, totalForms: 2, rarity: 'common' },
        }),
      ],
      mon: mon([4, 5, 6], 1),
      line: evoLine([4, 5, 6]),
      companion: { progress: 0.35, stageText: D.stage('en', 2, 3), toNextText: '11M to next evolution' },
    }),
  },
  {
    id: 'wild-evolved-owned',
    label: 'Wild: an evolved form you already have (Gyarados), with the Poké Ball',
    state: scene({
      inventory: { pokeBall: 7, greatBall: 2, ultraBall: 3, masterBall: 1 },
      wild: [
        wild(130, {
          captureRate: 45,
          rarity: 'rare',
          line: { baseID: 129, stageIndex: 1, totalForms: 2, rarity: 'common' },
        }),
        wild(6, {
          captureRate: 45,
          rarity: 'rare',
          line: { baseID: 4, stageIndex: 2, totalForms: 3, rarity: 'rare' },
        }),
      ],
      mon: mon([4, 5, 6], 1),
      line: evoLine([4, 5, 6]),
      companion: { progress: 0.35, stageText: D.stage('en', 2, 3), toNextText: '11M to next evolution' },
      dex: [caught([129, 130], 6)],
    }),
  },
  ...(['shinydex', 'shinydex-broke'] as const).map((id) => ({
    id,
    label:
      id === 'shinydex'
        ? 'Shinydex: not registered, registered at 0%, at 30% with boosts, and a shiny registered'
        : 'Shinydex: the same, with an empty wallet (no boosts, only the hint)',
    state: scene({
      spendable: id === 'shinydex' ? 1_204_000_000 : 0,
      mon: mon([4, 5, 6], 1),
      line: evoLine([4, 5, 6]),
      companion: { progress: 0.35, stageText: D.stage('en', 2, 3), toNextText: '11M to next evolution' },
      dex: [caught([1, 2, 3], 9), caught([129, 130], 4)],
      species: {
        // #1 registered, its shiny bar at 0%; #2 at 30% of a common form's 400M; #3 unlocked only.
        1: {
          ...freshSpeciesProgress(),
          unlocked: true,
          registered: true,
          lineRarity: 'common',
          shinyXP: 0,
        },
        2: {
          ...freshSpeciesProgress(),
          unlocked: true,
          registered: true,
          lineRarity: 'common',
          shinyUnlocked: true,
          shinyXP: 120_000_000,
        },
        3: { ...freshSpeciesProgress(), unlocked: true, xp: 6_000_000, threshold: 25_000_000 },
        4: { ...freshSpeciesProgress(), unlocked: true, registered: true, lineRarity: 'common' },
        5: { ...freshSpeciesProgress(), unlocked: true, xp: 5_950_000, threshold: 17_000_000 },
        129: {
          ...freshSpeciesProgress(),
          unlocked: true,
          registered: true,
          lineRarity: 'common',
          shinyUnlocked: true,
          shinyRegistered: true,
        },
        130: { ...freshSpeciesProgress(), unlocked: true, registered: true, lineRarity: 'common' },
      },
    }),
  })),
  {
    id: 'limits-hot',
    label: 'Límites al límite (aviso y crítico)',
    state: scene({
      lang: 'es',
      limits: [
        { label: '5-hour session', value: '97%', percent: 97, severity: 'crit' },
        { label: 'Weekly', value: '84%', percent: 84, severity: 'warn' },
        { label: 'Weekly Opus', value: '61%', percent: 61, severity: 'normal' },
        { label: 'Codex · 5-hour session', value: '12%', percent: 12, severity: 'normal' },
      ],
      mon: mon([143], 0, { nature: 'relaxed' }),
      line: evoLine([143]),
      companion: {
        progress: 0.42,
        stageText: D.stage('es', 1, 1),
        toNextText: '380M para graduarse',
      },
    }),
  },
  {
    id: 'errors',
    label: 'With provider errors and large figures',
    state: scene({
      todayTokens: 1_204_998_120,
      todayCost: 1841.55,
      monthTokens: 38_004_112_887,
      monthCost: 21_004.9,
      errors: [
        "Codex: EACCES: permission denied, scandir '/home/user/.codex/sessions'",
        'Companion: fetch failed (pokeapi.co)',
      ],
      mon: mon([143], 0, { nature: 'relaxed' }),
      line: evoLine([143]),
      companion: {
        progress: 0.12,
        stageText: D.stage('en', 1, 1),
        toNextText: '660M to graduation',
      },
    }),
  },
  {
    id: 'japanese',
    label: 'Japanese (different typography and lengths)',
    state: scene({
      lang: 'ja',
      inventory: { pokeBall: Pokeball.starterCount, rareCandy: 3, shinyCharm: 1 },
      mon: mon([4, 5, 6], 2, { nature: 'adamant' }),
      line: evoLine([4, 5, 6]),
      companion: {
        progress: 0.55,
        stageText: D.stage('ja', 3, 3),
        toNextText: 'そつぎょうまで 120M',
      },
    }),
  },
  {
    id: 'dev-tab',
    label: 'Pestaña Dev (devMode on)',
    state: scene({
      lang: 'es',
      mon: mon([4, 5, 6], 0, { nature: 'hardy' }),
      line: evoLine([4, 5, 6]),
      companion: {
        progress: 0.34,
        stageText: D.stage('es', 1, 3),
        toNextText: 'Faltan 82.5M para evolucionar',
      },
      dev: devSection(),
    }),
  },
]
