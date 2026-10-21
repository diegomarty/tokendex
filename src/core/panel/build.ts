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
  PanelDexFilter,
  PanelDexSpecies,
  PanelDexSummary,
  PanelEggs,
  PanelEncounterResult,
  PanelMoodMeter,
  PanelLure,
  PanelChallenges,
  PanelPCBox,
  PanelDrawer,
  PanelMedals,
  PanelLureOffer,
  PanelShinyBar,
  PanelShopAction,
  PanelShopPack,
  PanelShopItem,
  PanelState,
  PanelStreak,
  PanelWalletChange,
  PanelWild,
} from '../../webview/protocol.js'
import type { UsageSnapshot } from '../snapshot.js'
import type { TurnOutcome } from '../companion/encounters.js'
import { eggProgress, eggTokensToHatch } from '../companion/display.js'
import { stageProgress, tokensToNext } from '../companion/growth.js'
import {
  ANIMATED_SPECIES_MAX,
  APP_LANGUAGES,
  type AppLanguage,
  BALL_KINDS,
  BERRY_KINDS,
  type CompanionState,
  EGG_STOCK_MAX,
  type EvoLine,
  FreshEgg,
  type WildEncounter,
  ITEM_KINDS,
  Pokeball,
  PokemonBalance,
  RARITIES,
  currentSpeciesID,
  isBallKind,
  isBerryKind,
  itemEmoji,
  itemIsBundled,
  itemIsPassive,
  itemSpriteName,
  languageLabel,
  natureName,
  shopEntryPrice,
  packQuantities,
} from '../companion/model.js'
import {
  canBuyEgg,
  canBuyItem,
  canUseMint,
  canUseRareCandy,
  candyRoomLeft,
  itemCount,
  ownedItems,
  lurePrice,
  shinyBoostCapLeft,
  shinyBoostOffers,
} from '../companion/shop.js'
import { spendableBalance, streakWindow } from '../companion/ledger.js'
import {
  dexCount,
  dexEntriesSorted,
  dexSpecies,
  dexTally,
  entryName,
  lineItems,
} from '../companion/dexView.js'
import {
  EncounterBalance,
  TrailBalance,
  attackPermille,
  encounterCatchChance,
  encounterThresholdFor,
  fleePermille,
  moodOf,
  queuedCount,
  temperamentOf,
  tokensToNextEncounter,
  trailIsCold,
  trailPrice,
} from '../companion/encounters.js'
import { TRAINER_IDS, trainerIDOrDefault } from '../companion/trainers.js'
import { progressOf, registrationPercent, shinyTarget } from '../companion/registry.js'
import { EconomyBalance } from '../companion/economy.js'
import { STARTERS, starterName, starterType } from '../companion/starters.js'
import { MEDALS, medalProgress } from '../companion/medals.js'
import { REGIONS, regionProgress } from '../companion/regions.js'
import { eggIsPaused, eggOnStage, isFreshGame } from '../companion/eggs.js'
import { todayKey } from '../usage/entry.js'
import { compact, cost, grouped, percent } from '../tokenFormatter.js'
import * as D from '../i18n/dispatch.js'
import { s as str } from '../i18n/strings.js'
import { panelStrings } from '../i18n/panelStrings.js'

/** Selectable refresh intervals, in seconds. One list for the host's timer, the setting's enum
 *  and the panel's picker — three copies would drift. */
export const REFRESH_PRESETS: readonly number[] = [30, 60, 120, 300, 600]

/**
 * A collection's completion, for its bar: rounded, but never 0 with something in it (four of 649
 * is a sliver, not an empty bar) and never 100 with something missing (646–648 of 649 used to
 * read complete; code review 9.12 #13).
 */
export function completion(done: number, total: number): number {
  if (done <= 0 || total <= 0) return 0
  if (done >= total) return 100
  return Math.min(99, Math.max(1, Math.round((100 * done) / total)))
}

/** How many waiting encounters Home's Wild drawer lists behind the one on stage (plan 9.4). */
export const WILD_QUEUE_SHOWN = 3

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
  /**
   * The spendable balance as the previous panel showed it, and a serial for this change. Absent
   * on the first panel and whenever nothing moved; the impure part — remembering — is the
   * worker's.
   */
  walletChange?: { previous: number; id: number } | undefined
}

/**
 * The streak row: seven dots and the one line beside them.
 *
 * The count, the window and the award guard all come from `streakWindow`, and the text from
 * the string table — so the webview receives a drawing and a sentence, never a rule. `value`
 * is clamped to `max` because the run keeps counting past the three days it needed: a fourth
 * day is real, but a progress bar reading 4 of 3 is not.
 */
function streakRow(state: CompanionState, lang: AppLanguage, now: number): PanelStreak {
  const window = streakWindow(state, todayKey(now))
  return {
    days: window.days,
    // Once the week has paid out there is nothing left to count toward, so the count gives way
    // to what actually happened.
    text: window.earned
      ? D.streakEarnedText(lang)
      : D.streakProgressText(lang, window.count, window.needed),
    label: D.streakRowLabel(lang),
    value: Math.min(window.count, window.needed),
    max: window.needed,
    earned: window.earned,
  }
}

/** A reaction threshold as the panel prints it: permille is exactly what the roll is held to. */
function permilleText(permille: number): string {
  const pct = permille / 10
  return percent(pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10)
}

/** Where a 0–100 reading starts to stand out, for the words and the bars alike. */
const HIGH = 65
const LOW = 35

function moodMeters(encounter: WildEncounter, lang: AppLanguage): PanelMoodMeter[] {
  const mood = moodOf(encounter)
  return (['anger', 'nervousness', 'trust'] as const).map((key) => ({
    key,
    label: D.moodMeterLabel(lang, key),
    percent: mood[key],
    tone: mood[key] >= HIGH ? 'high' : mood[key] <= LOW ? 'low' : 'mid',
  }))
}

function temperamentText(encounter: WildEncounter, lang: AppLanguage): string {
  const t = temperamentOf(encounter)
  // An encounter from before temperaments existed has nothing to say beyond neutral.
  if (encounter.temperament === undefined && encounter.nature === undefined) return ''
  return D.temperamentText(
    lang,
    encounter.nature === undefined ? undefined : natureName(encounter.nature, lang),
    {
      aggressive: t.aggression >= HIGH,
      gentle: t.aggression <= LOW,
      skittish: t.skittishness >= HIGH,
      steady: t.skittishness <= LOW,
      hungry: t.appetite >= HIGH,
    },
  )
}

function walletChange(
  change: PanelBuildInputs['walletChange'],
  spendable: number,
): { walletChange?: PanelWalletChange } {
  if (change === undefined || change.previous === spendable) return {}
  const delta = spendable - change.previous
  // U+2212, not a hyphen: a hyphen beside a number reads as a dash at this size.
  const text = `${delta > 0 ? '+' : '\u2212'}${compact(Math.abs(delta))}`
  return { walletChange: { id: change.id, text, kind: delta > 0 ? 'gain' : 'loss' } }
}

export function buildPanelState(inputs: PanelBuildInputs): PanelState {
  const { usage, state, line, now, locale } = inputs
  const lang = state.language
  const spendable = spendableBalance(state)

  // The discount is derived, not written: `shopEntryPrice` charges bundleMultiplier/bundleSize,
  // and copy that said a different percentage would be lying about the till.
  const bundleDiscount = Math.round(100 * (1 - Pokeball.bundleMultiplier / Pokeball.bundleSize))
  const buyWord = str(lang, 'buy')
  const shop: PanelShopItem[] = []
  for (const kind of ITEM_KINDS) {
    const owned = itemIsPassive(kind) && itemCount(state, kind) > 0
    const isBall = isBallKind(kind)
    const name = D.itemName(lang, kind)
    // A ball and its ten-pack are one product sold at two quantities, not two products. They
    // were two cards, and the ×10 card had nothing of its own to say — its description was the
    // same generated sentence on all three, so a third of the tab was a repeated clause. The
    // ids are untouched: `parseEntryID` sees `item:pokeBall` and `item:pokeBall:<pack>`, and
    // refuses any quantity `parsePackQuantity` does not list.
    const bundled = itemIsBundled(kind)
    const singlePrice = compact(shopEntryPrice({ kind: 'item', item: kind }))
    const actions: PanelShopAction[] = [
      {
        id: `item:${kind}`,
        // With a second price beside it the word "Buy" stops being the useful half: which
        // quantity is. Alone on a row, it stays the word it has always been.
        text: owned ? str(lang, 'ownedAlready') : bundled ? '×1' : buyWord,
        label: owned ? D.ownedActionLabel(lang, name) : D.buyActionLabel(lang, name, singlePrice),
        confirmTitle: name,
        priceText: singlePrice,
        price: shopEntryPrice({ kind: 'item', item: kind }),
        enabled: canBuyItem(state, kind),
      },
    ]
    if (bundled) {
      const pack = (quantity: number): PanelShopPack => {
        const bundleName = `${name} ×${quantity}`
        const price = shopEntryPrice({ kind: 'item', item: kind, quantity })
        const priceText = compact(price)
        return {
          id: `item:${kind}:${quantity}`,
          text: `×${quantity}`,
          label: D.bundleBuyLabel(lang, bundleName, priceText, bundleDiscount),
          confirmTitle: bundleName,
          priceText,
          price,
          // Grouping the two prices onto one row is only an improvement while the ten-pack is
          // still visibly the cheaper ball. Without this the saving would survive nowhere but in
          // arithmetic the reader has to do.
          saveText: D.bundleSaveText(bundleDiscount),
          enabled: canBuyItem(state, kind, quantity),
        }
      }
      // The ten-pack is the row's second price; its steps (×10 … ×100) ride on it, each one
      // priced and checked against the wallet here, so the stepper only walks a list.
      const packs = packQuantities().map(pack)
      actions.push({ ...packs[0]!, packs })
    }
    const row: PanelShopItem = {
      id: `item:${kind}`,
      emoji: itemEmoji(kind),
      title: name,
      actions,
      owned,
      group: isBall ? 'balls' : isBerryKind(kind) ? 'berries' : 'items',
    }
    // A ball's catch rate is a figure, and the figure is the whole content of the sentence it
    // replaces. The Poké Ball keeps a `1×` for the same reason a scale needs its origin: `1.5×`
    // one row below means nothing without it. The Master Ball has no figure, so it keeps prose.
    const stat = isBall ? D.ballCatchStat(lang, kind) : undefined
    const statLabel = isBall ? D.ballCatchLabel(lang, kind) : undefined
    if (stat === undefined) row.description = D.itemDescription(lang, kind)
    else {
      row.stat = stat
      if (statLabel !== undefined) row.statLabel = statLabel
    }
    const sprite = itemSpriteName(kind)
    if (sprite !== undefined) row.sprite = sprite
    shop.push(row)
  }
  // The eggs are on the shelf once the game has begun (Diego): the egg itself, for the stock, and
  // the guarantees after it — those greyed out (`canBuyEgg`) until an egg is incubating, since
  // they are bought for that egg.
  if (!isFreshGame(state)) {
    for (const tier of [undefined, ...FreshEgg.shopTiers]) {
      const name = D.eggName(lang, tier)
      const priceText = compact(FreshEgg.price_(tier))
      shop.push({
        id: `egg:${tier ?? 'any'}`,
        emoji: '🥚',
        sprite: 'egg-icon',
        title: name,
        // Only the guarantee. What they all do — fix the rarity of the egg incubating — is said
        // once under the heading, as `strings.shopEggsNote`.
        description: D.eggDescription(lang, tier),
        actions: [
          {
            id: `egg:${tier ?? 'any'}`,
            text: buyWord,
            label: D.buyActionLabel(lang, name, priceText),
            confirmTitle: name,
            priceText,
            price: FreshEgg.price_(tier),
            enabled: canBuyEgg(state, tier),
          },
        ],
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
      pocket: isBallKind(item.kind) ? 'balls' : isBerryKind(item.kind) ? 'berries' : 'items',
    }
    if (!usable && itemIsPassive(item.kind)) entry.hint = str(lang, 'shinyCharmEffectHint')
    if (isBerryKind(item.kind)) entry.hint = D.berryBagHint(lang)
    // Candies in hand that the species on stage can no longer take: say why Use is greyed out.
    if (item.kind === 'rareCandy' && state.active !== undefined && !candyRoomLeft(state))
      entry.hint = D.candyFullHint(lang)
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
      rarity: e.rarity,
      rarityText: D.rarityLabel(lang, e.rarity),
      isActive: e.id === activeID,
      isWild: e.source === 'wild',
    }
    if (e.caughtAt !== undefined) {
      row.caughtText = new Date(e.caughtAt).toLocaleDateString(locale)
    }
    return row
  })

  // Rarity chips over the catch log. The log is ordered by time because it is a record, so
  // narrowing is what replaced rarity as its sort key — this is the filter that comment always
  // meant, and `dexCount` is the counter written for it. A tier with nothing in it is left out
  // rather than shown as a zero: an empty chip is a control that does nothing.
  const dexLogFilters: PanelDexFilter[] = [
    { id: 'all', label: D.dexFilterAllLabel(lang), count: dexLog.length },
    ...RARITIES.map((rarity) => ({
      id: rarity,
      label: D.rarityLabel(lang, rarity),
      count: dexCount(state, line, rarity),
    })).filter((chip) => chip.count > 0),
  ]

  const companionSpeciesID = state.active === undefined ? undefined : currentSpeciesID(state.active)
  const species: PanelDexSpecies[] = dexSpecies(state, line, lang).map((sp) => {
    const isCompanion = sp.id === companionSpeciesID
    return {
      id: sp.id,
      name: sp.name,
      isShiny: sp.isShiny,
      isRaising: sp.isRaising,
      rarityText: D.rarityLabel(lang, sp.rarity),
      rarity: sp.rarity,
      status: sp.status,
      shiny: sp.shiny,
      percent: sp.percent,
      percentText: D.registrationText(lang, sp.percent, sp.status === 'registered'),
      // Anything owned can be the companion — a seen species is not owned yet, and the one on
      // stage is already chosen.
      canChoose: sp.status !== 'seen' && !isCompanion,
      rarityRank: Math.max(0, RARITIES.indexOf(sp.rarity as (typeof RARITIES)[number])),
      isCompanion,
      ...lureOffer(state, sp.id, now, lang),
      ...(sp.status === 'registered' || sp.shiny === 'registered'
        ? { shinyBar: shinyBarFor(state, sp.id, sp.name, lang) }
        : {}),
    }
  })

  const toNext = tokensToNextEncounter(state.encounterUsage, state.encountersSeen)
  const threshold = encounterThresholdFor(state.encountersSeen)
  // The head of the queue is the one on stage: its capture rate and mood price every ball's
  // odds, and its rarity decides whether letting it go deserves a native confirmation.
  const staged = state.wild[0]
  const wild: PanelWild = {
    encounters: state.wild.map((e) => {
      const flee = permilleText(fleePermille(e))
      const attack = permilleText(attackPermille(e))
      const row: PanelWild['encounters'][number] = {
        id: e.id,
        speciesID: e.speciesID,
        name: e.names?.[lang] ?? `#${e.speciesID}`,
        rarityText: D.rarityLabel(lang, e.rarity),
        rarity: e.rarity,
        terrain: e.types?.[0] ?? e.rarity,
        isShiny: e.isShiny,
        appearedText:
          todayKey(e.appearedAt) === todayKey(now)
            ? new Date(e.appearedAt).toLocaleTimeString(locale, {
                hour: '2-digit',
                minute: '2-digit',
              })
            : new Date(e.appearedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
        meters: moodMeters(e, lang),
        statuses: [],
        // The reaction thresholds for the mood on screen — the one a berry can change. A miss
        // moves the mood before the roll, so the next miss is slightly riskier than this reads.
        riskText: D.riskText(lang, flee, attack),
        risk: {
          heading: D.riskHeading(lang),
          items: [
            { key: 'flee', text: D.riskFlee(lang, flee) },
            { key: 'attack', text: D.riskAttack(lang, attack) },
          ],
        },
      }
      const temperament = temperamentText(e, lang)
      if (temperament !== '') row.temperamentText = temperament
      if (e.primed === true) {
        row.primedText = D.primedText(lang)
        row.statuses.push({ key: 'primed', text: D.primedBadge(lang), title: row.primedText })
      }
      if ((e.stolen ?? 0) > 0) {
        row.stolenText = D.stolenText(lang, compact(e.stolen ?? 0))
        row.statuses.push({
          key: 'stolen',
          text: D.stolenBadge(lang, compact(e.stolen ?? 0)),
          title: row.stolenText,
        })
      }
      if (progressOf(state, e.speciesID).unlocked) row.ownedText = D.ownedText(lang)
      // Running from a common stays one click; discarding what hurts to lose asks first.
      if (e.rarity === 'rare' || e.rarity === 'legendary' || e.isShiny) {
        row.runConfirmText = D.runAwayConfirm(lang, row.name)
      }
      return row
    }),
    waitingText: D.wildBadgeTooltip(lang, state.wild.length),
    ...(state.wild.length > 1 ? { moreText: D.moreWaitingText(lang, state.wild.length - 1) } : {}),
    queueShown: WILD_QUEUE_SHOWN,
    ...(state.wild.length > 1 + WILD_QUEUE_SHOWN
      ? { queueMoreText: D.moreWaitingText(lang, state.wild.length - 1 - WILD_QUEUE_SHOWN) }
      : {}),
    nextText: D.wildNextEncounterText(lang, compact(toNext)),
    progressPercent: Math.max(0, Math.min(100, Math.round(100 * (1 - toNext / threshold)))),
    streak: streakRow(state, lang, now),
    balls: BALL_KINDS.map((kind) => {
      const ball: PanelWild['balls'][number] = {
        kind,
        name: D.itemName(lang, kind),
        count: itemCount(state, kind),
        sprite: itemSpriteName(kind) ?? 'poke-ball',
      }
      if (staged !== undefined) {
        // Same maths the throw rolls, mood included, so the number shown is the number played.
        const pct = encounterCatchChance(staged, kind) * 100
        ball.oddsText = percent(pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10)
      }
      return ball
    }),
    noBallsText: D.wildNoBallsText(lang),
    // Only berries the bag holds: an empty berry is a button that cannot do anything, and the
    // shop is where you learn they exist.
    berries: BERRY_KINDS.filter((kind) => itemCount(state, kind) > 0).map((kind) => ({
      kind,
      name: D.itemName(lang, kind),
      count: itemCount(state, kind),
      sprite: itemSpriteName(kind) ?? 'oran-berry',
      effectText: D.itemDescription(lang, kind),
    })),
    finds: state.finds.map((find) => {
      const name = D.itemName(lang, find.item)
      const row: PanelWild['finds'][number] = {
        id: find.id,
        name,
        count: find.count,
        emoji: itemEmoji(find.item),
        rarity: find.rarity,
        rarityText: D.rarityLabel(lang, find.rarity),
        label: D.collectLabel(lang, find.count > 1 ? `${name} ×${find.count}` : name),
      }
      const sprite = itemSpriteName(find.item)
      if (sprite !== undefined) row.sprite = sprite
      return row
    }),
    collectAllText: D.collectAllLabel(lang),
    trail: state.legendaryTrail
      .filter((entry) => !trailIsCold(entry, now))
      .map((entry) => {
        const name = entry.names?.[lang] ?? `#${entry.speciesID}`
        const priceText = compact(trailPrice(entry))
        return {
          id: entry.id,
          speciesID: entry.speciesID,
          name,
          isShiny: entry.isShiny,
          expiresText: D.trailExpiresText(lang, (entry.lostAt + TrailBalance.windowMs - now) / 3_600_000),
          trackText: D.trackLabel(lang, priceText),
          priceText,
          confirmTitle: D.trackConfirmTitle(lang, name),
          confirmLabel: D.trackConfirmLabel(lang),
          // The same three conditions `trackLegendary` refuses on, so the button is never live
          // for a track the rule would turn down.
          enabled: queuedCount(state) < EncounterBalance.maxQueue && spendable >= trailPrice(entry),
        }
      }),
    trailTitle: D.trailTitle(lang),
  }
  if (state.finds.length > 0) wild.findsText = D.findsText(lang, state.finds.length)

  const panel: PanelState = {
    drawers: [],
    lid: { usageText: '', usageShortText: '', lights: [], columns: [], toggleLabel: '' },
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
    ...walletChange(inputs.walletChange, spendable),
    shop,
    bag,
    dexSpecies: species,
    dexSummary: dexSummary(state, species, dexLog.length, lang),
    medals: medalsPanel(state, lang),
    pcBox: pcBoxPanel(species, lang),
    shopGroups: shopGroupsPanel(shop, lang),
    ...challengesPanel(state, now, lang),
    eggs: eggsPanel(state, lang),
    dexLog,
    dexLogFilters,
    wild,
    trainerID: trainerIDOrDefault(state.trainerID),
    keepCompletedCompanion: state.keepCompletedCompanion === true,
    ...lureRunning(state, now, lang),
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
      ...expBar(state, lang),
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
      c.registrationPercent = registrationPercent(progressOf(state, currentSpeciesID(state.active)))
    }
    panel.companion = c
  }
  if (isFreshGame(state)) {
    panel.starters = STARTERS.map((id) => ({
      id,
      name: starterName(id, lang),
      types: [starterType(id)],
    }))
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
  panel.drawers = homeDrawers(state, panel, lang)
  panel.lid = {
    usageText: D.usageSummary(lang, panel.totals.todayText, panel.totals.monthText),
    usageShortText: D.usageShortText(lang, panel.totals.todayText),
    columns: [
      {
        label: D.usageColumnLabel(lang, 'today'),
        tokensText: panel.totals.todayText,
        exactText: panel.totals.todayExactText,
        costText: panel.totals.todayCostText,
      },
      {
        label: D.usageColumnLabel(lang, 'month'),
        tokensText: panel.totals.monthText,
        exactText: panel.totals.monthExactText,
        costText: panel.totals.monthCostText,
      },
    ],
    toggleLabel: D.lidToggleLabel(lang),
    lights: [0, 1, 2].map((i) => {
      const limit = panel.limits[i]
      if (limit === undefined) return 'off' as const
      return limit.severity === 'crit' ? 'crit' : limit.severity === 'warn' ? 'warn' : 'ok'
    }),
  }
  if (inputs.dev !== undefined) panel.dev = inputs.dev
  return panel
}

/**
 * The EXP bar, like the games': the stage meter against what the stage costs, or an egg toward
 * its hatch. Both figures are formatted here; the webview paints them in the bar's colour.
 */
function expBar(
  state: CompanionState,
  lang: AppLanguage,
): Pick<NonNullable<PanelState['companion']>, 'expPercent' | 'expText' | 'expLeftText'> {
  // The progress and what is left come from the same helpers as the status bar's line
  // (`eggProgress`/`eggTokensToHatch`, `stageProgress`/`tokensToNext`), so the two never disagree.
  const mon = state.active
  if (mon === undefined) {
    if (isFreshGame(state)) return { expPercent: 0 }
    const total = PokemonBalance.eggHatchThreshold
    const left = eggTokensToHatch(state)
    return {
      expPercent: Math.floor(100 * eggProgress(state)),
      expText: D.expProgressText(compact(total - left), compact(total)),
      expLeftText: D.expLeftText(lang, compact(left)),
    }
  }
  const total = PokemonBalance.phaseThreshold(mon.rarity, mon.totalForms, mon.stageIndex)
  const left = tokensToNext(mon)
  const full = left === 0 && progressOf(state, currentSpeciesID(mon)).registered
  return {
    expPercent: Math.floor(100 * stageProgress(mon)),
    expText: D.expProgressText(compact(total - left), compact(total)),
    expLeftText: full ? D.registrationText(lang, 100, true) : D.expLeftText(lang, compact(left)),
  }
}

/**
 * The egg stock on Home. The incubate button exists only while a companion is on stage — with
 * none, the egg already is — and reads "Resume" for an egg set aside mid-incubation, which needs
 * no stock.
 */
function eggsPanel(state: CompanionState, lang: AppLanguage): PanelEggs {
  const count = state.eggStock.count
  const paused = eggIsPaused(state)
  const eggs: PanelEggs = { count, max: EGG_STOCK_MAX, stockText: D.eggStockText(lang, count), paused }
  if (count === 0) eggs.emptyText = D.eggsEmptyText(lang)
  if (paused) eggs.incubateText = D.resumeEggText(lang)
  else if (state.active !== undefined && count > 0) eggs.incubateText = D.incubateEggText(lang)
  return eggs
}

/** The Pokédex's counts, formatted here so the webview paints them instead of counting. */
function dexSummary(
  state: CompanionState,
  species: readonly PanelDexSpecies[],
  logCount: number,
  lang: AppLanguage,
): PanelDexSummary {
  const { owned, registered, shinyRegistered } = dexTally(species)
  const total = ANIMATED_SPECIES_MAX
  const strings = panelStrings(lang)
  return {
    owned,
    registered,
    total,
    percent: completion(registered, total),
    progressText: D.dexProgressText(registered, total),
    speciesSegmentText: D.countedLabel(strings.segmentSpecies, owned),
    logSegmentText: D.countedLabel(strings.segmentLog, logCount),
    sorts: (['number', 'progress', 'rarity'] as const).map((id) => ({
      id,
      label: D.pcSortLabel(lang, id),
    })),
    regions: regionProgress(state).map((r) => {
      const region = REGIONS.find((x) => x.id === r.id)!
      return {
        id: r.id,
        name: D.regionName(lang, r.id),
        registered: r.registered,
        total: r.total,
        percent: completion(r.registered, r.total),
        progressText: D.dexProgressText(r.registered, r.total),
        shinyRegistered: r.shinyRegistered,
        shinyPercent: completion(r.shinyRegistered, r.total),
        shinyProgressText: D.dexProgressText(r.shinyRegistered, r.total),
        from: region.from,
        to: region.to,
      }
    }),
    shinyRegistered,
    shinyPercent: completion(shinyRegistered, total),
    shinyProgressText: D.dexProgressText(shinyRegistered, total),
    shinySegmentText: D.countedLabel(D.shinydexLabel(lang), shinyRegistered),
  }
}

/** The lure running, for Home, with the hours left rounded up; nothing once its day is over. */
function lureRunning(state: CompanionState, now: number, lang: AppLanguage): { lure?: PanelLure } {
  const lure = state.lure
  if (lure === undefined || lure.until <= now) return {}
  const hoursLeft = Math.ceil((lure.until - now) / 3_600_000)
  return {
    lure: {
      speciesID: lure.speciesID,
      text: D.lureActiveText(lang, lureName(lure.speciesID), hoursLeft),
    },
  }
}

/**
 * The lure button on a species that can be lured (`lurePrice`), or nothing. Named by its number:
 * a lure is only for a species seen and not obtained, whose name the Pokédex keeps hidden.
 */
function lureOffer(
  state: CompanionState,
  speciesID: number,
  now: number,
  lang: AppLanguage,
): { lure?: PanelLureOffer } {
  const price = lurePrice(state, speciesID)
  if (price === undefined) return {}
  const hours = Math.round(EconomyBalance.lure.durationMs / 3_600_000)
  const priceText = compact(price)
  const name = lureName(speciesID)
  const running = state.lure !== undefined && state.lure.until > now
  return {
    lure: {
      text: D.lureButtonText(lang, hours),
      priceText,
      label: D.lureLabel(lang, name, hours, priceText),
      confirmTitle: D.lureConfirmTitle(lang, name, running),
      enabled: spendableBalance(state) >= price,
    },
  }
}

/** A lured species' name: its number, as the Pokédex names a species it has no name for. */
function lureName(speciesID: number): string {
  return `#${speciesID}`
}

/**
 * Home's drawers (plan 08 §8): one summary line per system, in a fixed order, built from what the
 * panel already carries so a drawer and the tab it summarises can never disagree. A drawer with
 * nothing to say is absent. `attention` marks what waits on the player.
 */
function homeDrawers(state: CompanionState, panel: PanelState, lang: AppLanguage): PanelDrawer[] {
  const drawers: PanelDrawer[] = []
  const drawer = (id: PanelDrawer['id'], summary: string, attention: boolean) =>
    drawers.push({ id, title: D.drawerTitle(lang, id), summary, attention })

  // The incubator: the egg on stage, one paused, or only the stock. Nothing before the starter.
  if (!isFreshGame(state)) {
    const stock = state.eggStock.count
    if (eggOnStage(state)) {
      drawer(
        'incubator',
        D.incubatorSummary(lang, { percent: Math.floor(100 * eggProgress(state)), stock }),
        false,
      )
    } else if (eggIsPaused(state)) {
      drawer('incubator', D.incubatorSummary(lang, { paused: true, stock }), true)
    } else {
      drawer('incubator', D.incubatorSummary(lang, { stock }), stock > 0)
    }
  }

  const challenges = panel.challenges
  if (challenges !== undefined && challenges.items.length > 0) {
    const done = challenges.items.filter((c) => c.done).length
    drawer(
      'challenges',
      D.challengesSummary(lang, done, challenges.items.length),
      done < challenges.items.length,
    )
  }

  // The trail is the one thing that runs out: flagged while it lasts.
  const trail = panel.wild.trail
  if (trail.length > 0) {
    const first = trail[0]!
    drawer('trail', D.trailSummary(lang, first.name, first.expiresText, trail.length - 1), true)
  }

  const waiting = state.wild.length
  const toNext = tokensToNextEncounter(state.encounterUsage, state.encountersSeen)
  const wildLine = waiting > 0 ? panel.wild.waitingText : D.nextEncounterShort(lang, compact(toNext))
  drawer('wild', panel.lure === undefined ? wildLine : `${wildLine} · ${panel.lure.text}`, waiting > 0)

  // Finds wait to be picked up: their own drawer, flagged while there is something to collect.
  const finds = state.finds.length
  // The same sentence the Wild tab heads its finds with: one fact, one wording.
  if (finds > 0) drawer('finds', D.findsText(lang, finds), true)

  drawer('streak', panel.wild.streak.text, false)
  return drawers
}

/**
 * The shop's drawers (Diego): each group that has something in it, with how many things and the
 * cheapest price — the rows' own figures, so the summary and the drawer never disagree.
 */
function shopGroupsPanel(shop: readonly PanelShopItem[], lang: AppLanguage): PanelState['shopGroups'] {
  const strings = panelStrings(lang)
  const titles: Record<PanelShopItem['group'], string> = {
    balls: strings.shopBalls,
    berries: strings.shopBerries,
    items: strings.shopItems,
    eggs: strings.shopEggs,
  }
  return (['balls', 'berries', 'items', 'eggs'] as const).flatMap((id) => {
    const items = shop.filter((item) => item.group === id)
    if (items.length === 0) return []
    const prices = items.flatMap((item) => item.actions.map((a) => a.price)).filter((p) => p > 0)
    const from = prices.length === 0 ? '' : compact(Math.min(...prices))
    return [{ id, title: titles[id], summary: D.shopGroupSummary(lang, items.length, from) }]
  })
}

/**
 * The PC box (Diego): what the companion can switch to — every species `canChoose` allows, the
 * unfinished ones first and the most advanced of those first, then the registered. From the
 * Pokédex's own cells, so the box and the Pokédex never disagree.
 */
function pcBoxPanel(species: readonly PanelDexSpecies[], lang: AppLanguage): PanelPCBox {
  const items = species
    .filter((sp) => sp.canChoose)
    .map((sp) => ({
      id: sp.id,
      name: sp.name,
      isShiny: sp.isShiny,
      rarity: sp.rarity,
      percent: sp.percent,
      percentText: sp.percentText,
      registered: sp.status === 'registered',
      shinyRegistered: sp.shiny === 'registered',
      rarityRank: sp.rarityRank,
    }))
    .sort((a, b) => Number(a.registered) - Number(b.registered) || b.percent - a.percent || a.id - b.id)
  const matches: Record<PanelPCBox['filters'][number]['id'], (item: (typeof items)[number]) => boolean> =
    {
      unregistered: (item) => !item.registered,
      registered: (item) => item.registered,
      shiny: (item) => item.shinyRegistered,
    }
  return {
    title: D.pcBoxTitle(lang),
    items,
    emptyText: D.pcBoxEmptyText(lang),
    searchPlaceholder: D.dexSearchPlaceholder(lang),
    sorts: (['progress', 'number', 'rarity'] as const).map((id) => ({
      id,
      label: D.pcSortLabel(lang, id),
    })),
    filters: (['unregistered', 'registered', 'shiny'] as const).map((id) => ({
      id,
      label: D.pcFilterLabel(lang, id),
      count: items.filter(matches[id]).length,
      countText: String(items.filter(matches[id]).length),
    })),
  }
}

/** The challenges board for Home, formatted; nothing before the first fold of a day. */
function challengesPanel(
  state: CompanionState,
  now: number,
  lang: AppLanguage,
): { challenges?: PanelChallenges } {
  const board = state.challenges
  // Yesterday's board, before today's fold, is not today's: nothing rather than a wrong label.
  if (board === undefined || board.day !== todayKey(now)) return {}
  return {
    challenges: {
      heading: D.challengesHeading(lang),
      items: board.items.map((c) => ({
        id: c.id,
        period: c.period,
        periodText: D.challengePeriodText(lang, c.period),
        text: D.challengeText(lang, c),
        // Tokens read compact ("500K / 2M"), as every figure on the panel; counts read as counts.
        progressText:
          c.kind === 'useTokens'
            ? D.dexProgressText(compact(c.progress), compact(c.target))
            : D.dexProgressText(c.progress, c.target),
        percent: Math.min(100, Math.floor((100 * c.progress) / c.target)),
        done: c.done,
        rewardText: `+${compact(D.challengeReward(c))}`,
      })),
    },
  }
}

/**
 * The medal catalogue with each medal's progress. Earned is what the save celebrated, not a
 * fresh derivation, so a medal never flickers back when a merge or a migration moves a count.
 */
function medalsPanel(state: CompanionState, lang: AppLanguage): PanelMedals {
  const celebrated = new Set(state.medals ?? [])
  const items = MEDALS.map((medal) => {
    const progress = medalProgress(state, medal.id)!
    const earned = celebrated.has(medal.id)
    const current = earned ? Math.max(progress.current, progress.target) : progress.current
    return {
      id: medal.id,
      name: D.medalName(lang, medal.id),
      description: D.medalDescription(lang, medal.id),
      earned,
      progressText: D.dexProgressText(Math.min(current, progress.target), progress.target),
      percent: Math.min(100, Math.floor((100 * current) / progress.target)),
    }
  })
  const earned = items.filter((m) => m.earned).length
  return { earned, total: items.length, headingText: D.medalsHeading(lang, earned, items.length), items }
}

/**
 * A registered species' shiny bar: how full, the sentence, and the boosts the wallet can buy
 * (`shinyBoostOffers`) — or why it cannot. Every figure formatted here.
 */
function shinyBarFor(
  state: CompanionState,
  speciesID: number,
  name: string,
  lang: AppLanguage,
): PanelShinyBar {
  const p = progressOf(state, speciesID)
  if (p.shinyRegistered === true) return { percent: 100, text: D.shinyRegisteredText(lang), boosts: [] }
  const target = p.lineRarity === undefined ? undefined : shinyTarget(p.lineRarity)
  const done = p.shinyXP ?? 0
  const percent = target === undefined ? 0 : Math.min(100, Math.floor((100 * done) / target))
  const bar: PanelShinyBar = {
    percent,
    text: D.shinyBarText(lang, percent, compact(done), target === undefined ? '?' : compact(target)),
    boosts: shinyBoostOffers(state, speciesID).map((amount) => {
      const priceText = compact(amount)
      return {
        amount,
        text: `+${priceText}`,
        label: D.shinyBoostLabel(lang, name, priceText),
        confirmTitle: D.shinyBoostTitle(lang, name),
        priceText,
      }
    }),
  }
  if (bar.boosts.length === 0 && target !== undefined) {
    bar.boostHint =
      shinyBoostCapLeft(state, speciesID) <= 0
        ? D.shinyBoostCappedText(lang, Math.round(100 * EconomyBalance.shinyBoostShare))
        : D.shinyBoostNoFundsText(lang)
  }

  return bar
}

/**
 * The banner a catch shows on the wild scene: `D.catchNews`' text, plus — for a first catch —
 * the species and its bar before and after, so the reveal animates numbers it never derives.
 * `before` is the state read before the turn, the one place the old percentage still exists.
 */
export function catchBanner(
  lang: AppLanguage,
  before: CompanionState,
  speciesID: number,
  outcome: Omit<Extract<TurnOutcome, { kind: 'caught' }>, 'shakes'>,
): NonNullable<PanelEncounterResult['catchNews']> {
  const news: NonNullable<PanelEncounterResult['catchNews']> = D.catchNews(lang, outcome)
  if (news.isNew && outcome.registeredPercent !== undefined) {
    const fromPercent = registrationPercent(progressOf(before, speciesID))
    news.registration = { speciesID, fromPercent, toPercent: outcome.registeredPercent }
    // What this catch added — the span the bar animates — not where the bar now stands.
    news.detail = D.catchShareText(lang, Math.max(0, outcome.registeredPercent - fromPercent))
  }
  return news
}
