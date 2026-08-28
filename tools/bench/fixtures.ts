/**
 * `PanelState` fixtures for the development bench.
 *
 * Typed against the real protocol on purpose: `npm run typecheck` covers this file, so any
 * change to `PanelState` breaks here instead of silently leaving the bench rendering a shape
 * the extension no longer sends.
 *
 * Titles, prices and labels come from the **real** i18n and formatter modules rather than
 * hand-typed strings, so switching a fixture's language exercises the actual tables.
 *
 * The panel itself is now built by the core's pure `buildPanelState` (covered by
 * `test/panel-build.test.ts`), so these fixtures only have to produce interesting *states*;
 * drift between what the bench shows and what the extension sends is a unit test away.
 */

import type {
  PanelBagItem,
  PanelDev,
  PanelDevControl,
  PanelDexEntry,
  PanelDexSpecies,
  PanelShopItem,
  PanelState,
  PanelWild,
  PanelWildEncounter,
} from '../../src/webview/protocol.js'
import {
  APP_LANGUAGES,
  type AppLanguage,
  BALL_KINDS,
  FreshEgg,
  ITEM_KINDS,
  type ItemKind,
  itemEmoji,
  itemShopPrice,
  itemSpriteName,
  languageLabel,
} from '../../src/core/companion/model.js'
import { DEFAULT_TRAINER_ID, TRAINER_IDS } from '../../src/core/companion/trainers.js'
import { DEV_GROUPS, DEV_SCENARIOS } from '../../src/core/dev/scenarios.js'
import * as D from '../../src/core/i18n/dispatch.js'
import { panelStrings } from '../../src/core/i18n/panelStrings.js'
import { s } from '../../src/core/i18n/strings.js'
import { compact, cost, grouped, percent } from '../../src/core/tokenFormatter.js'
import { catchChance } from '../../src/core/companion/encounters.js'

// Read from `itemShopPrice` rather than re-listed here: a hand-written map is a second price
// table, and the typecheck only catches a *missing* kind, never a wrong number.
const PRICES: Record<ItemKind, number> = Object.fromEntries(
  ITEM_KINDS.map((kind) => [kind, itemShopPrice(kind) ?? 0]),
) as Record<ItemKind, number>

function shop(
  lang: AppLanguage,
  options: { spendable: number; hasActive: boolean; owns?: ItemKind[] },
): PanelShopItem[] {
  const owns = new Set(options.owns ?? [])
  const items: PanelShopItem[] = ITEM_KINDS.map((kind) => {
    const entry: PanelShopItem = {
      id: `item:${kind}`,
      emoji: itemEmoji(kind),
      title: D.itemName(lang, kind),
      description: D.itemDescription(lang, kind),
      priceText: compact(PRICES[kind]),
      enabled: options.spendable >= PRICES[kind] && !owns.has(kind),
      owned: owns.has(kind),
      group: (BALL_KINDS as readonly string[]).includes(kind) ? 'balls' : 'items',
    }
    const sprite = itemSpriteName(kind)
    if (sprite !== undefined) entry.sprite = sprite
    return entry
  })
  if (!options.hasActive) return items
  for (const tier of FreshEgg.shopTiers) {
    items.push({
      id: `egg:${tier ?? 'any'}`,
      emoji: '🥚',
      title: D.eggName(lang, tier),
      description: D.eggDescription(lang, tier),
      priceText: compact(FreshEgg.price_(tier)),
      enabled: options.spendable >= FreshEgg.price_(tier),
      owned: false,
      group: 'eggs',
    })
  }
  return items
}

function bag(
  lang: AppLanguage,
  counts: Partial<Record<ItemKind, number>>,
  usable: boolean,
): PanelBagItem[] {
  return ITEM_KINDS.filter((kind) => (counts[kind] ?? 0) > 0).map((kind) => {
    const entry: PanelBagItem = {
      id: `item:${kind}`,
      emoji: itemEmoji(kind),
      title: D.itemName(lang, kind),
      description: D.itemDescription(lang, kind),
      count: counts[kind] ?? 0,
      usable: usable && kind !== 'shinyCharm',
    }
    if (kind === 'shinyCharm') entry.hint = s(lang, 'shinyCharmEffectHint')
    return entry
  })
}

/** Species names are the English PokéAPI ones — the bench is about layout, not translation. */
const NAMES: Record<number, string> = {
  1: 'Bulbasaur',
  2: 'Ivysaur',
  3: 'Venusaur',
  4: 'Charmander',
  5: 'Charmeleon',
  6: 'Charizard',
  7: 'Squirtle',
  9: 'Blastoise',
  10: 'Caterpie',
  25: 'Pikachu',
  26: 'Raichu',
  39: 'Jigglypuff',
  52: 'Meowth',
  54: 'Psyduck',
  63: 'Abra',
  92: 'Gastly',
  94: 'Gengar',
  129: 'Magikarp',
  130: 'Gyarados',
  131: 'Lapras',
  133: 'Eevee',
  134: 'Vaporeon',
  143: 'Snorlax',
  147: 'Dratini',
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

function species(
  lang: AppLanguage,
  ids: number[],
  shiny: number[] = [],
  raising: number[] = [],
): PanelDexSpecies[] {
  return ids.map((id) => ({
    id,
    name: NAMES[id] ?? `#${id}`,
    isShiny: shiny.includes(id),
    isRaising: raising.includes(id),
    rarityText: D.rarityLabel(
      lang,
      id === 150 || id === 249 || id === 251 || id === 483
        ? 'legendary'
        : id % 7 === 0
          ? 'rare'
          : id % 3 === 0
            ? 'uncommon'
            : 'common',
    ),
  }))
}

function log(
  lang: AppLanguage,
  rows: { id: number; days: number; shiny?: boolean; active?: boolean; wild?: boolean }[],
): PanelDexEntry[] {
  const day = 86_400_000
  // Fixed epoch, not `Date.now()`: a bench that renders a different string every reload makes
  // "did my change do that?" impossible to answer.
  const base = Date.parse('2026-08-19T10:00:00Z')
  return rows.map((row) => {
    const entry: PanelDexEntry = {
      finalID: row.id,
      name: NAMES[row.id] ?? `#${row.id}`,
      isShiny: row.shiny ?? false,
      rarityText: D.rarityLabel(
        lang,
        row.id === 150 ? 'legendary' : row.id % 7 === 0 ? 'rare' : 'common',
      ),
      isActive: row.active ?? false,
      isWild: row.wild ?? false,
    }
    if (!row.active) entry.caughtText = new Date(base - row.days * day).toLocaleDateString('en-US')
    return entry
  })
}

// MARK: - Wild encounters

function wildEncounter(
  lang: AppLanguage,
  over: Partial<PanelWildEncounter> & { speciesID: number },
): PanelWildEncounter {
  const rarity = over.rarity ?? 'common'
  return {
    id: `w-${over.speciesID}`,
    name: NAMES[over.speciesID] ?? `#${over.speciesID}`,
    rarityText: D.rarityLabel(lang, rarity as never),
    rarity,
    isShiny: false,
    appearedText: '10:24',
    ...over,
  }
}

/** The Wild tab exactly as the worker shapes it, with a controllable rack. */
function wildSection(
  lang: AppLanguage,
  encounters: PanelWildEncounter[],
  counts: Partial<Record<string, number>> = {},
  /** Capture rate of the encounter on stage, pricing the rack's odds like the worker does. */
  stagedCaptureRate?: number,
): PanelWild {
  return {
    encounters,
    waitingText: D.wildBadgeTooltip(lang, encounters.length),
    emptyText: D.wildEmptyText(lang, compact(1_200_000)),
    progressPercent: 52,
    balls: BALL_KINDS.map((kind) => {
      const ball: PanelWild['balls'][number] = {
        kind,
        name: D.itemName(lang, kind),
        count: counts[kind] ?? 0,
        sprite: itemSpriteName(kind) ?? 'poke-ball',
      }
      if (stagedCaptureRate !== undefined) {
        const pct = catchChance(stagedCaptureRate, kind) * 100
        ball.oddsText = percent(pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10)
      }
      return ball
    }),
    noBallsText: D.wildNoBallsText(lang),
  }
}

interface BaseOptions {
  lang?: AppLanguage
  todayTokens?: number
  todayCost?: number
  monthTokens?: number
  monthCost?: number
  spendable?: number
}

function base(options: BaseOptions = {}): PanelState {
  const lang = options.lang ?? 'en'
  const today = options.todayTokens ?? 253_412_890
  const month = options.monthTokens ?? 4_812_004_331
  const spendable = options.spendable ?? 1_204_000_000
  return {
    totals: {
      todayText: compact(today),
      todayExactText: grouped(today, 'en-US'),
      todayCostText: cost(options.todayCost ?? 41.82),
      monthText: compact(month),
      monthExactText: grouped(month, 'en-US'),
      monthCostText: cost(options.monthCost ?? 812.4),
    },
    providers: [
      {
        displayName: 'Claude Code',
        todayText: compact(Math.round(today * 0.72)),
        monthText: compact(Math.round(month * 0.7)),
      },
      {
        displayName: 'Codex',
        todayText: compact(Math.round(today * 0.28)),
        monthText: compact(Math.round(month * 0.3)),
      },
    ],
    limits: [
      { label: '5-hour session', value: '42%', percent: 42, severity: 'normal' },
      { label: 'Weekly', value: '37%', percent: 37, severity: 'normal' },
    ],
    spendableText: compact(spendable),
    wild: wildSection(lang, [], { pokeBall: 5 }),
    trainerID: DEFAULT_TRAINER_ID,
    trainers: [...TRAINER_IDS],
    shop: shop(lang, { spendable, hasActive: true }),
    bag: bag(lang, { rareCandy: 3 }, true),
    dexSpecies: [],
    dexLog: [],
    language: lang,
    languages: APP_LANGUAGES.map((id) => ({ id, label: languageLabel(id) })),
    strings: panelStrings(lang),
    errors: [],
  }
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
    state: { ...base(), limits: [] },
  },
  {
    id: 'wild-queue',
    label: 'Home scene: queue with a shiny and a legendary, full rack',
    state: {
      ...base(),
      wild: wildSection(
        'en',
        [
          wildEncounter('en', { speciesID: 147, rarity: 'rare' }),
          wildEncounter('en', { speciesID: 129, isShiny: true }),
          wildEncounter('en', { speciesID: 10 }),
          wildEncounter('en', { speciesID: 150, rarity: 'legendary' }),
        ],
        { pokeBall: 7, greatBall: 2, ultraBall: 1, masterBall: 1 },
        45, // Dratini's capture rate: the rack reads 27% / 38% / 46% / 100%
      ),
      companion: {
        name: 'Pikachu',
        speciesID: 25,
        isShiny: false,
        progress: 0.71,
        stageText: D.stage('en', 2, 3),
        toNextText: '21.7M to next evolution',
        rarityText: D.rarityLabel('en', 'common'),
        line: [],
      },
      dexLog: log('en', [
        { id: 129, days: 0, wild: true },
        { id: 3, days: 12 },
      ]),
    },
  },
  {
    id: 'wild-no-balls',
    label: 'Home scene: encounter waiting, empty rack (shop hint)',
    state: {
      ...base(),
      wild: wildSection('en', [wildEncounter('en', { speciesID: 133 })]),
    },
  },
  {
    id: 'wild-empty',
    label: 'Home scene: nothing waiting, companion on stage',
    state: { ...base() },
  },
  {
    id: 'egg-early',
    label: 'Freshly laid egg (nothing to show)',
    state: {
      ...base({
        todayTokens: 312_004,
        todayCost: 0.61,
        monthTokens: 312_004,
        monthCost: 0.61,
        spendable: 312_004,
      }),
      shop: shop('en', { spendable: 312_004, hasActive: false }),
      bag: [],
      companion: {
        isShiny: false,
        progress: 0.06,
        toNextText: '4.7M to hatch',
        line: [],
      },
    },
  },
  {
    id: 'egg-almost',
    label: 'Egg almost ready',
    state: {
      ...base({ spendable: 4_600_000 }),
      shop: shop('en', { spendable: 4_600_000, hasActive: false }),
      companion: {
        isShiny: false,
        progress: 0.92,
        toNextText: '400K to hatch',
        line: [],
      },
    },
  },
  {
    id: 'hatched-linear',
    label: 'Just hatched, linear line (1/3)',
    state: {
      ...base(),
      companion: {
        name: 'Bulbasaur',
        speciesID: 1,
        isShiny: false,
        progress: 0.34,
        stageText: D.stage('en', 1, 3),
        toNextText: '82.5M to next evolution',
        rarityText: D.rarityLabel('en', 'common'),
        natureText: 'Brave',
        line: [
          { speciesID: 1, state: 'current' },
          { speciesID: 2, state: 'future' },
          { speciesID: 3, state: 'future' },
        ],
      },
      dexSpecies: species('en', [1], [], [1]),
      dexLog: log('en', [{ id: 1, days: 0, active: true }]),
    },
  },
  {
    id: 'branching',
    label: 'Undecided branch (the question mark)',
    state: {
      ...base(),
      companion: {
        name: 'Eevee',
        speciesID: 133,
        isShiny: false,
        progress: 0.71,
        stageText: D.stage('en', 1, 2),
        toNextText: '21.7M to next evolution',
        rarityText: D.rarityLabel('en', 'uncommon'),
        natureText: 'Jolly',
        line: [{ speciesID: 133, state: 'current' }, { state: 'future' }],
      },
      dexSpecies: species('en', [133], [], [133]),
      dexLog: log('en', [{ id: 133, days: 0, active: true }]),
    },
  },
  {
    id: 'shiny-final',
    label: 'Shiny in its final stage (heading for graduation)',
    state: {
      ...base({ spendable: 6_400_000_000 }),
      shop: shop('en', { spendable: 6_400_000_000, hasActive: true, owns: ['shinyCharm'] }),
      bag: bag('en', { rareCandy: 12, mint: 2, shinyCharm: 1 }, true),
      companion: {
        name: 'Charizard',
        speciesID: 6,
        isShiny: true,
        progress: 0.88,
        stageText: D.stage('en', 3, 3),
        toNextText: '45M to graduation',
        rarityText: D.rarityLabel('en', 'rare'),
        natureText: 'Adamant',
        line: [
          { speciesID: 4, state: 'done' },
          { speciesID: 5, state: 'done' },
          { speciesID: 6, state: 'current' },
        ],
      },
      dexSpecies: species('en', [4, 5, 6, 25, 133, 134], [6], [4, 5, 6]),
      dexLog: log('en', [
        { id: 6, days: 0, shiny: true, active: true },
        { id: 25, days: 3 },
        { id: 134, days: 11 },
      ]),
    },
  },
  {
    id: 'dex-full',
    label: 'Populated Pokédex (24 species, 12 catches)',
    state: {
      ...base(),
      dexSpecies: species(
        'en',
        [1, 2, 3, 4, 5, 6, 7, 10, 25, 26, 39, 52, 54, 63, 92, 94, 129, 130, 133, 143, 147, 149, 150, 448],
        [94, 150],
        [147],
      ),
      dexLog: log('en', [
        { id: 147, days: 0, active: true },
        { id: 150, days: 1, shiny: true },
        { id: 149, days: 2 },
        { id: 94, days: 4, shiny: true },
        { id: 130, days: 6 },
        { id: 143, days: 8 },
        { id: 26, days: 12 },
        { id: 3, days: 15 },
        { id: 6, days: 19 },
        { id: 9, days: 24 },
        { id: 39, days: 30 },
        { id: 10, days: 41 },
      ]),
    },
  },
  {
    id: 'limits-hot',
    label: 'Límites al límite (aviso y crítico)',
    state: {
      ...base(),
      limits: [
        { label: '5-hour session', value: '97%', percent: 97, severity: 'crit' },
        { label: 'Weekly', value: '84%', percent: 84, severity: 'warn' },
        { label: 'Weekly Opus', value: '61%', percent: 61, severity: 'normal' },
        { label: 'Codex · 5-hour session', value: '12%', percent: 12, severity: 'normal' },
      ],
      companion: {
        name: 'Snorlax',
        speciesID: 143,
        isShiny: false,
        progress: 0.42,
        stageText: D.stage('es', 1, 1),
        toNextText: '380M to graduate',
        rarityText: D.rarityLabel('es', 'uncommon'),
        natureText: 'Relaxed',
        line: [{ speciesID: 143, state: 'current' }],
      },
      dexSpecies: species('es', [143], [], [143]),
      dexLog: log('es', [{ id: 143, days: 0, active: true }]),
    },
  },
  {
    id: 'errors',
    label: 'With provider errors and large figures',
    state: {
      ...base({
        todayTokens: 1_204_998_120,
        todayCost: 1841.55,
        monthTokens: 38_004_112_887,
        monthCost: 21_004.9,
      }),
      errors: [
        "Codex: EACCES: permission denied, scandir '/home/user/.codex/sessions'",
        'Companion: fetch failed (pokeapi.co)',
      ],
      companion: {
        name: 'Snorlax',
        speciesID: 143,
        isShiny: false,
        progress: 0.12,
        stageText: D.stage('en', 1, 1),
        toNextText: '660M to graduation',
        rarityText: D.rarityLabel('en', 'uncommon'),
        natureText: 'Relaxed',
        line: [{ speciesID: 143, state: 'current' }],
      },
      dexSpecies: species('en', [143], [], [143]),
      dexLog: log('en', [{ id: 143, days: 0, active: true }]),
    },
  },
  {
    id: 'japanese',
    label: 'Japanese (different typography and lengths)',
    state: (() => {
      const state = base({ lang: 'ja' })
      return {
        ...state,
        bag: bag('ja', { rareCandy: 3, shinyCharm: 1 }, true),
        companion: {
          name: 'リザードン',
          speciesID: 6,
          isShiny: false,
          progress: 0.55,
          stageText: D.stage('ja', 3, 3),
          toNextText: 'そつぎょうまで 120M',
          rarityText: D.rarityLabel('ja', 'rare'),
          natureText: 'いじっぱり',
          line: [
            { speciesID: 4, state: 'done' },
            { speciesID: 5, state: 'done' },
            { speciesID: 6, state: 'current' },
          ],
        },
        dexSpecies: [
          {
            id: 4,
            name: 'ヒトカゲ',
            isShiny: false,
            isRaising: true,
            rarityText: D.rarityLabel('ja', 'rare'),
          },
          {
            id: 5,
            name: 'リザード',
            isShiny: false,
            isRaising: true,
            rarityText: D.rarityLabel('ja', 'rare'),
          },
          {
            id: 6,
            name: 'リザードン',
            isShiny: false,
            isRaising: true,
            rarityText: D.rarityLabel('ja', 'rare'),
          },
        ],
        dexLog: [
          {
            finalID: 6,
            name: 'リザードン',
            isShiny: false,
            rarityText: D.rarityLabel('ja', 'rare'),
            isActive: true,
            isWild: false,
          },
        ],
      }
    })(),
  },
  {
    id: 'dev-tab',
    label: 'Pestaña Dev (devMode on)',
    state: {
      ...base(),
      companion: {
        name: 'Charmander',
        speciesID: 4,
        isShiny: false,
        progress: 0.34,
        stageText: D.stage('es', 1, 3),
        toNextText: 'Faltan 82.5M para evolucionar',
        rarityText: D.rarityLabel('es', 'common'),
        natureText: 'Firme',
        line: [
          { speciesID: 4, state: 'current' },
          { speciesID: 5, state: 'future' },
          { speciesID: 6, state: 'future' },
        ],
      },
      dexSpecies: species('es', [4], [], [4]),
      dexLog: log('es', [{ id: 4, days: 0, active: true }]),
      dev: devSection(),
    },
  },
]
