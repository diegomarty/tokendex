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

import type { PanelDev, PanelDevControl, PanelState } from '../../src/webview/protocol.js'
import {
  type AppLanguage,
  type CompanionState,
  type DexEntry,
  type EvoLine,
  type EvoNode,
  type ItemKind,
  type MonState,
  Pokeball,
  type Rarity,
  type WildEncounter,
  currentSpeciesID,
  freshCompanionState,
  resolveName,
} from '../../src/core/companion/model.js'
import { DEV_GROUPS, DEV_SCENARIOS } from '../../src/core/dev/scenarios.js'
import * as D from '../../src/core/i18n/dispatch.js'
import { buildPanelState } from '../../src/core/panel/build.js'
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

/** One line is translated, which is all the Japanese fixture needs to show its typography. */
const JA_NAMES: Record<number, string> = { 4: 'ヒトカゲ', 5: 'リザード', 6: 'リザードン' }

/** The per-language name map the core stores on a save and resolves at render time. */
function names(id: number): Record<string, string> {
  const en = NAMES[id] ?? `#${id}`
  const ja = JA_NAMES[id]
  return ja === undefined ? { en } : { en, ja }
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

/** One queued encounter. The head of the queue is the one on stage, and it prices the rack. */
function wild(speciesID: number, over: Partial<WildEncounter> = {}): WildEncounter {
  return {
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
  limits?: LimitRow[]
  errors?: string[]
  dev?: PanelDev
  /** Days back from the fixture clock on which usage accrued, for the streak row. */
  streakDaysAgo?: number[]
  /** Days back from the fixture clock on which this window's legendary was earned. */
  awardDaysAgo?: number
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
  if (options.mon !== undefined) state.active = options.mon

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

export interface Fixture {
  id: string
  label: string
  state: PanelState
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
