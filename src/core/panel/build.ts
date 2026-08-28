/**
 * Builds the `PanelState` the webview renders — everything already formatted and localised.
 *
 * Pure and in the core on purpose. This exact logic used to live in the scan worker, where it
 * read the companion store and the clock directly — which put the single largest piece of
 * UI-shaping code outside the test suite and outside the bench, and that blind spot shipped a
 * real bug (a celebration flag frozen into a reused snapshot). Everything impure now arrives as
 * an input: the worker passes the store's live readings, tests pass fixtures, and both get the
 * same panel.
 *
 * Ids are opaque tokens the webview echoes back — it never parses them, so a rename here cannot
 * break the UI silently.
 */

import type {
  PanelBagItem,
  PanelDev,
  PanelDexEntry,
  PanelDexSpecies,
  PanelShopItem,
  PanelState,
  PanelWild,
} from '../../webview/protocol.js'
import type { UsageSnapshot } from '../snapshot.js'
import {
  APP_LANGUAGES,
  BALL_KINDS,
  type CompanionState,
  type EvoLine,
  FreshEgg,
  ITEM_KINDS,
  Pokeball,
  currentSpeciesID,
  itemEmoji,
  itemIsPassive,
  itemSpriteName,
  languageLabel,
  natureName,
  shopEntryPrice,
} from '../companion/model.js'
import {
  canBuyEgg,
  canBuyItem,
  canUseMint,
  canUseRareCandy,
  itemCount,
  ownedItems,
} from '../companion/shop.js'
import { spendableBalance } from '../companion/ledger.js'
import { dexEntriesSorted, dexSpecies, entryName, lineItems } from '../companion/dexView.js'
import { catchChance, encounterThresholdFor, tokensToNextEncounter } from '../companion/encounters.js'
import { TRAINER_IDS, trainerIDOrDefault } from '../companion/trainers.js'
import { todayKey } from '../usage/entry.js'
import { compact, cost, grouped, percent } from '../tokenFormatter.js'
import * as D from '../i18n/dispatch.js'
import { s as str } from '../i18n/strings.js'
import { panelStrings } from '../i18n/panelStrings.js'

/** Selectable refresh intervals, in seconds. One list for the host's timer, the setting's enum
 *  and the panel's picker — three copies would drift. */
export const REFRESH_PRESETS: readonly number[] = [30, 60, 120, 300, 600]

export interface PanelBuildInputs {
  /** The scan this panel accompanies. May be a reused one — nothing time-critical lives in it. */
  usage: UsageSnapshot
  /** The companion store's current state, always fresh (the store re-reads its save). */
  state: CompanionState
  line: EvoLine | undefined
  /** The store's live celebration window — never taken from `usage`, which can be stale. */
  isCelebrating: boolean
  /** Epoch ms, for "did this encounter appear today". Injected so tests can pin it. */
  now: number
  locale?: string | undefined
  /** The host's `tokendex.refreshInterval`; absent hides the Settings picker. */
  refreshSeconds?: number | undefined
  /** The Dev tab, already built by the worker (it owns the dev state). Absent = no tab. */
  dev?: PanelDev | undefined
}

export function buildPanelState(inputs: PanelBuildInputs): PanelState {
  const { usage, state, line, now, locale } = inputs
  const lang = state.language
  const spendable = spendableBalance(state)

  // The discount is derived, not written: `shopEntryPrice` charges bundleMultiplier/bundleSize,
  // and copy that said a different percentage would be lying about the till.
  const bundleDiscount = Math.round(100 * (1 - Pokeball.bundleMultiplier / Pokeball.bundleSize))
  const shop: PanelShopItem[] = []
  for (const kind of ITEM_KINDS) {
    const owned = itemIsPassive(kind) && itemCount(state, kind) > 0
    const isBall = (BALL_KINDS as readonly string[]).includes(kind)
    const row: PanelShopItem = {
      id: `item:${kind}`,
      emoji: itemEmoji(kind),
      title: D.itemName(lang, kind),
      description: D.itemDescription(lang, kind),
      priceText: compact(shopEntryPrice({ kind: 'item', item: kind })),
      enabled: canBuyItem(state, kind),
      owned,
      group: isBall ? 'balls' : 'items',
    }
    const sprite = itemSpriteName(kind)
    if (sprite !== undefined) row.sprite = sprite
    shop.push(row)
    // Ball ten-packs, straight after their single row. The Master Ball is deliberately not
    // bundled — a ten-pack of guaranteed catches is not a thing worth pricing.
    if (kind !== 'masterBall' && isBall) {
      const quantity = Pokeball.bundleSize
      const bundle: PanelShopItem = {
        id: `item:${kind}:${quantity}`,
        emoji: itemEmoji(kind),
        title: `${D.itemName(lang, kind)} ×${quantity}`,
        description: D.bundleDescription(lang, quantity, bundleDiscount),
        priceText: compact(shopEntryPrice({ kind: 'item', item: kind, quantity })),
        enabled: canBuyItem(state, kind, quantity),
        owned: false,
        group: 'balls',
      }
      if (sprite !== undefined) bundle.sprite = sprite
      shop.push(bundle)
    }
  }
  if (state.active !== undefined) {
    for (const tier of FreshEgg.shopTiers) {
      shop.push({
        id: `egg:${tier ?? 'any'}`,
        emoji: '🥚',
        title: D.eggName(lang, tier),
        description: D.eggDescription(lang, tier),
        priceText: compact(FreshEgg.price_(tier)),
        enabled: canBuyEgg(state, tier),
        owned: false,
        group: 'eggs',
      })
    }
  }
  // Sorted within each group by price, owned passives last; the webview renders group by group.
  shop.sort((a, b) => Number(a.owned) - Number(b.owned))

  const bag: PanelBagItem[] = ownedItems(state).map((item) => {
    const usable =
      item.kind === 'rareCandy'
        ? canUseRareCandy(state, line !== undefined)
        : item.kind === 'mint'
          ? canUseMint(state)
          : false
    const entry: PanelBagItem = {
      id: `item:${item.kind}`,
      emoji: itemEmoji(item.kind),
      ...(itemSpriteName(item.kind) !== undefined ? { sprite: itemSpriteName(item.kind) } : {}),
      title: D.itemName(lang, item.kind),
      description: D.itemDescription(lang, item.kind),
      count: item.count,
      usable,
    }
    if (!usable && itemIsPassive(item.kind)) entry.hint = str(lang, 'shinyCharmEffectHint')
    return entry
  })

  const activeID =
    state.active === undefined
      ? undefined
      : `active-${state.active.baseID}-${currentSpeciesID(state.active)}`
  const dexLog: PanelDexEntry[] = dexEntriesSorted(state, line).map((e) => {
    const row: PanelDexEntry = {
      finalID: e.finalID,
      name: entryName(e, lang, line),
      isShiny: e.isShiny,
      rarityText: D.rarityLabel(lang, e.rarity),
      isActive: e.id === activeID,
      isWild: e.source === 'wild',
    }
    if (e.caughtAt !== undefined) {
      row.caughtText = new Date(e.caughtAt).toLocaleDateString(locale)
    }
    return row
  })

  const species: PanelDexSpecies[] = dexSpecies(state, line, lang).map((sp) => ({
    id: sp.id,
    name: sp.name,
    isShiny: sp.isShiny,
    isRaising: sp.isRaising,
    rarityText: D.rarityLabel(lang, sp.rarity),
  }))

  const toNext = tokensToNextEncounter(state.encounterUsage, state.encountersSeen)
  const threshold = encounterThresholdFor(state.encountersSeen)
  // The head of the queue is the one on stage: its capture rate prices every ball's odds, and
  // its rarity decides whether letting it go deserves a native confirmation.
  const staged = state.wild[0]
  const wild: PanelWild = {
    encounters: state.wild.map((e) => {
      const row: PanelWild['encounters'][number] = {
        id: e.id,
        speciesID: e.speciesID,
        name: e.names?.[lang] ?? `#${e.speciesID}`,
        rarityText: D.rarityLabel(lang, e.rarity),
        rarity: e.rarity,
        isShiny: e.isShiny,
        appearedText:
          todayKey(e.appearedAt) === todayKey(now)
            ? new Date(e.appearedAt).toLocaleTimeString(locale, {
                hour: '2-digit',
                minute: '2-digit',
              })
            : new Date(e.appearedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
      }
      // Running from a common stays one click; discarding what hurts to lose asks first.
      if (e.rarity === 'rare' || e.rarity === 'legendary' || e.isShiny) {
        row.runConfirmText = D.runAwayConfirm(lang, row.name)
      }
      return row
    }),
    waitingText: D.wildBadgeTooltip(lang, state.wild.length),
    emptyText: D.wildEmptyText(lang, compact(toNext)),
    progressPercent: Math.max(0, Math.min(100, Math.round(100 * (1 - toNext / threshold)))),
    balls: BALL_KINDS.map((kind) => {
      const ball: PanelWild['balls'][number] = {
        kind,
        name: D.itemName(lang, kind),
        count: itemCount(state, kind),
        sprite: itemSpriteName(kind) ?? 'poke-ball',
      }
      if (staged !== undefined) {
        // Same maths the throw rolls (`catchChance`), so the number shown is the number played.
        const pct = catchChance(staged.captureRate, kind) * 100
        ball.oddsText = percent(pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10)
      }
      return ball
    }),
    noBallsText: D.wildNoBallsText(lang),
  }

  const panel: PanelState = {
    totals: {
      todayText: compact(usage.totals.todayTokens),
      todayExactText: grouped(usage.totals.todayTokens, locale),
      todayCostText: cost(usage.totals.todayCost),
      monthText: compact(usage.totals.monthTokens),
      monthExactText: grouped(usage.totals.monthTokens, locale),
      monthCostText: cost(usage.totals.monthCost),
    },
    providers: usage.providers.map((p) => {
      const row: PanelState['providers'][number] = {
        displayName: p.displayName,
        todayText: compact(p.today?.totalTokens ?? 0),
        monthText: compact(p.month?.totalTokens ?? 0),
      }
      // The same trailing-window burn the tooltip shows — one source, two surfaces.
      if (p.tokensPerMinute !== undefined && p.tokensPerMinute > 0) {
        row.burnText = `${compact(Math.round(p.tokensPerMinute))}/min`
      }
      return row
    }),
    spendableText: compact(spendable),
    shop,
    bag,
    dexSpecies: species,
    dexLog,
    wild,
    trainerID: trainerIDOrDefault(state.trainerID),
    trainers: [...TRAINER_IDS],
    language: lang,
    languages: APP_LANGUAGES.map((id) => ({ id, label: languageLabel(id) })),
    limits: usage.limits,
    strings: panelStrings(lang),
    errors: usage.errors,
  }
  const view = usage.companion
  if (view !== undefined) {
    const c: NonNullable<PanelState['companion']> = {
      isShiny: view.isShiny,
      progress: view.progress,
      toNextText: view.toNextText,
      line: lineItems(state.active, line).map((item) =>
        item.content.kind === 'species'
          ? { speciesID: item.content.id, state: item.state }
          : { state: item.state },
      ),
    }
    // From the injected live flag, never from `view.state`: `usage` can be a reused snapshot.
    if (inputs.isCelebrating) c.celebrating = true
    if (view.name !== undefined) c.name = view.name
    if (view.speciesID !== undefined) c.speciesID = view.speciesID
    if (view.stageText !== undefined) c.stageText = view.stageText
    if (state.active !== undefined) {
      c.rarityText = D.rarityLabel(lang, state.active.rarity)
      if (state.active.nature !== undefined) c.natureText = natureName(state.active.nature, lang)
    }
    panel.companion = c
  }
  if (inputs.refreshSeconds !== undefined) {
    panel.refresh = {
      seconds: inputs.refreshSeconds,
      options: REFRESH_PRESETS.map((seconds) => ({
        seconds,
        label: D.intervalLabel(lang, seconds),
      })),
    }
  }
  if (inputs.dev !== undefined) panel.dev = inputs.dev
  return panel
}
