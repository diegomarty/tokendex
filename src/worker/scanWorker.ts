/**
 * Scan worker.
 *
 * The scan runs here and **never** on the extension host thread. When the parsing lived in a
 * separate process this did not matter; inside the extension host, blocking the thread
 * freezes VS Code for the user — and the first ever scan of a real corpus takes ~30 seconds
 * (measured: 970 MB Claude + 494 MB Codex).
 *
 * The worker is long-lived on purpose. A fresh worker per refresh would reload the cache
 * snapshot from disk every time (measured: 99 ms) instead of reusing it in memory (65 ms).
 */

import { parentPort, workerData } from 'node:worker_threads'
import { type CompanionView, buildSnapshot } from '../core/snapshot.js'
import { LocalUsageCache } from '../core/usage/cache.js'
import { type Entry, enrichmentScanStart, todayKey } from '../core/usage/entry.js'
import { claudeProjectRoots, codexSessionsDir } from '../core/usage/roots.js'
import { CompanionStore } from '../core/companion/store.js'
import { LimitsPoller, isLimitWarning } from '../core/limits/poller.js'
import { candyEligibleWindows } from '../core/limits/windows.js'
import { eggProgress, eggTokensToHatch } from '../core/companion/display.js'
import { stageProgress, tokensToNext } from '../core/companion/growth.js'
import { PokeAPIClient } from '../core/pokeapi.js'
import {
  type AppLanguage,
  type ItemKind,
  type Rarity,
  currentSpeciesID,
} from '../core/companion/model.js'
import { buyEgg, buyItem, consumeRareCandy, grantCandies, useMint } from '../core/companion/shop.js'
import {
  type DevState,
  addOffset,
  applyDevOffsets,
  clearOffsets,
  freshDevState,
  grantItem,
  grantTokens,
  setDittoDisguise,
  setEggTier,
  setShiny,
  tokensToGraduation,
  tokensToMilestone,
} from '../core/dev/simulation.js'
import { freshCompanionState } from '../core/companion/model.js'
import { type DevAction, DEV_GROUPS, DEV_SCENARIOS, devSummary } from '../core/dev/scenarios.js'
import { promises as devFS } from 'node:fs'
import { join as devJoin } from 'node:path'
import { ourData } from '../core/appPaths.js'
import { compact } from '../core/tokenFormatter.js'
import { f } from '../core/i18n/strings.js'
import { stage as stageLabel } from '../core/i18n/dispatch.js'
import * as D from '../core/i18n/dispatch.js'
import { s as str } from '../core/i18n/strings.js'
import { panelStrings } from '../core/i18n/panelStrings.js'
import { grouped } from '../core/tokenFormatter.js'
import { cost } from '../core/tokenFormatter.js'
import {
  APP_LANGUAGES,
  FreshEgg,
  ITEM_KINDS,
  itemEmoji,
  itemIsPassive,
  languageLabel,
  localizedName,
  natureName,
  shopEntryPrice,
} from '../core/companion/model.js'
import {
  canBuyEgg,
  canBuyItem,
  canUseMint,
  canUseRareCandy,
  itemCount,
  ownedItems,
} from '../core/companion/shop.js'
import { spendableBalance } from '../core/companion/ledger.js'
import type {
  PanelDevControl,
  PanelState,
  PanelShopItem,
  PanelBagItem,
  PanelDexEntry,
  PanelDexSpecies,
} from '../webview/protocol.js'
import { dexEntriesSorted, dexSpecies, entryName, lineItems } from '../core/companion/dexView.js'

export type WorkerAction =
  | { action: 'buyItem'; item: ItemKind }
  | { action: 'useItem'; item: ItemKind }
  | { action: 'buyEgg'; tier?: Rarity }
  | { action: 'setLanguage'; language: AppLanguage }
  // Development-only. Declared in `core/dev/scenarios.ts` so the panel's Dev tab, the quick pick
  // and this switch are all driven by one table.
  | DevAction

export interface ScanRequest {
  id: number
  type: 'scan'
  locale?: string
}

export interface PanelRequest {
  id: number
  type: 'panel'
  locale?: string
  devMode?: boolean
}

export interface ActionRequest {
  id: number
  type: 'action'
  locale?: string
  devMode?: boolean
  payload: WorkerAction
}

export type WorkerRequest = ScanRequest | PanelRequest | ActionRequest

export type ScanResponse =
  | { id: number; ok: true; snapshot: ReturnType<typeof buildSnapshot> }
  | { id: number; ok: true; panel: PanelState }
  | { id: number; ok: false; error: string }

interface WorkerConfig {
  cacheFilePath?: string
  claudeRoots?: string[]
  codexRoot?: string
}

const config = (workerData ?? {}) as WorkerConfig

const companion = new CompanionStore({ provider: new PokeAPIClient() })

/**
 * Official limits, kept off the scan's critical path — `refresh()` returns what is known and
 * fetches for next time. They are what turns an exhausted window into a rare candy, and the
 * only reason the shop's grant logic ever receives anything.
 */
const limits = new LimitsPoller()

// Dev simulation state, persisted apart from the save so it survives a reload and can be
// rewound without touching real accounting.
const DEV_FILE = devJoin(ourData(), 'dev-state.json')
const DEV_SNAPSHOT_FILE = devJoin(ourData(), 'dev-snapshot.json')
let dev: DevState = freshDevState()
let devLoaded = false

async function loadDev(): Promise<DevState> {
  if (devLoaded) return dev
  devLoaded = true
  try {
    dev = {
      ...freshDevState(),
      ...(JSON.parse(await devFS.readFile(DEV_FILE, 'utf8')) as DevState),
    }
  } catch {
    dev = freshDevState()
  }
  return dev
}

async function saveDev(): Promise<void> {
  try {
    await devFS.mkdir(ourData(), { recursive: true })
    await devFS.writeFile(DEV_FILE, JSON.stringify(dev), 'utf8')
  } catch {
    // Dev-only: a write failure must never break a refresh.
  }
}

const cache = new LocalUsageCache({
  ...(config.cacheFilePath !== undefined ? { filePath: config.cacheFilePath } : {}),
  ...(config.claudeRoots !== undefined ? { claudeRoots: config.claudeRoots } : {}),
  ...(config.codexRoot !== undefined ? { codexRoot: config.codexRoot } : {}),
})

async function scan(locale: string | undefined) {
  const now = Date.now()
  const since = enrichmentScanStart(now, locale)
  const errors: string[] = []

  /**
   * Every provider is read independently and a failure in one is recorded rather than thrown.
   * One unreadable store must never cost the user the numbers from all the others.
   */
  const read = async (label: string, load: () => Promise<Entry[]>): Promise<Entry[]> => {
    try {
      return await load()
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  const [claude, codex, gemini, grok, cursor, copilot, opencode, hermes, kiro, antigravity] =
    await Promise.all([
      read('Claude', () => cache.claudeEntries(since)),
      read('Codex', () => cache.codexEntries(since)),
      read('Gemini', () => cache.geminiEntries(since)),
      read('Grok', () => cache.grokEntries(since)),
      read('Cursor', () => cache.cursorEntries(since)),
      read('Copilot', () => cache.copilotEntries(since)),
      read('OpenCode', () => cache.openCodeEntries(since)),
      read('Hermes', () => cache.hermesEntries(since)),
      read('Kiro', () => cache.kiroEntries(since)),
      read('Antigravity', async () => {
        // Its diagnostics ride along with the entries: an unreadable conversation store makes
        // the total quietly low, which is exactly the kind of silence worth breaking.
        const scan = await cache.antigravityScan(since)
        errors.push(...scan.notes)
        return scan.entries
      }),
    ])

  // Providers with nothing to report are dropped: a permanent row of zeros for a tool the
  // user does not have is noise, and the panel is read at a glance.
  const sources = [
    { providerID: 'claude_code', displayName: 'Claude Code', entries: claude },
    { providerID: 'codex', displayName: 'Codex', entries: codex },
    { providerID: 'gemini', displayName: 'Gemini', entries: gemini },
    { providerID: 'grok', displayName: 'Grok', entries: grok },
    { providerID: 'cursor', displayName: 'Cursor', entries: cursor },
    { providerID: 'copilot', displayName: 'Copilot', entries: copilot },
    { providerID: 'opencode', displayName: 'OpenCode', entries: opencode },
    { providerID: 'hermes', displayName: 'Hermes', entries: hermes },
    { providerID: 'kiro', displayName: 'Kiro', entries: kiro },
    {
      providerID: 'antigravity',
      displayName: 'Antigravity',
      entries: antigravity,
    },
  ].filter((s) => s.entries.length > 0)

  // Build once without the companion so the per-provider daily totals are available to feed
  // the ledger, then rebuild with the resulting companion view.
  const usage = buildSnapshot(sources, {
    now,
    ...(locale !== undefined ? { locale } : {}),
    lang: companion.snapshot().language,
    errors,
  })

  let view: CompanionView | undefined
  try {
    const observed: Record<string, number> = {}
    for (const p of usage.providers) {
      if (p.today !== undefined) observed[p.providerID] = p.today.totalTokens
    }
    await loadDev()
    const todayTokensByProvider = applyDevOffsets(observed, dev)
    await companion.update({
      todayTokensByProvider,
      todayDate: dev.dateOverride ?? todayKey(now),
      hasUsageData: usage.providers.some((p) => p.entries > 0),
    })
    // After `update`, so the grant lands on the state that was just persisted rather than on
    // a copy `update` is about to overwrite.
    const known = limits.refresh()
    const outcome = grantCandies(
      companion.snapshot(),
      candyEligibleWindows(known.sources, companion.snapshot().language),
      known.ready,
    )
    if (outcome.changed) {
      // Re-arming counts as a change even with no grant: dropping it leaves a stale tier, and
      // the next genuine crossing is then mistaken for one already paid.
      companion.replaceState(outcome.state)
      await companion.save()
    }
    view = companionView(locale, isLimitWarning(known.sources))
  } catch (e) {
    errors.push(`Companion: ${e instanceof Error ? e.message : String(e)}`)
  }

  return buildSnapshot(sources, {
    now,
    ...(locale !== undefined ? { locale } : {}),
    lang: companion.snapshot().language,
    errors,
    ...(view !== undefined ? { companion: view } : {}),
  })
}

/** Everything the UI needs, already formatted — it must never re-derive a number. */
function companionView(locale: string | undefined, limitWarning: boolean): CompanionView {
  const state = companion.snapshot()
  const lang = state.language
  const active = state.active
  const dexCount = state.dex.length
  const spendableTokens = companion.spendable()

  if (active === undefined) {
    return {
      state: 'egg',
      isShiny: false,
      progress: eggProgress(state),
      toNextText: f.eggToHatch(lang, compact(eggTokensToHatch(state))),
      dexCount,
      spendableTokens,
    }
  }

  const remaining = compact(tokensToNext(active))
  const isFinal = active.stageIndex >= active.totalForms - 1
  const view: CompanionView = {
    state: companion.displayState({
      burnTier: 'normal',
      limitWarning: false,
      hasUsageData: true,
      todayTokens: 1,
    }),
    speciesID: currentSpeciesID(active),
    isShiny: active.isShiny,
    rarity: active.rarity,
    progress: stageProgress(active),
    toNextText: isFinal ? f.toGraduation(lang, remaining) : f.toNextEvolution(lang, remaining),
    stageText: stageLabel(lang, active.stageIndex + 1, active.totalForms),
    dexCount,
    spendableTokens,
  }
  const name = companion.displayName()
  if (name !== undefined) view.name = name
  return view
}

/**
 * Applies a user action, then rescans so the reply carries a fully consistent snapshot. The
 * webview never mutates state itself — it only asks, and re-renders whatever comes back.
 */
async function applyAction(payload: WorkerAction): Promise<void> {
  await companion.load()
  const state = companion.snapshot()

  switch (payload.action) {
    case 'buyItem': {
      const next = buyItem(state, payload.item)
      if (next !== undefined) companion.replaceState(next)
      break
    }
    case 'useItem': {
      if (payload.item === 'rareCandy') {
        const next = consumeRareCandy(state)
        if (next !== undefined) {
          companion.replaceState(next)
          companion.applyCandy()
        }
      } else if (payload.item === 'mint') {
        const result = useMint(state, () => Math.floor(Math.random() * 0x7fffffff))
        if (result !== undefined) companion.replaceState(result.state)
      }
      break
    }
    case 'buyEgg': {
      const next = buyEgg(state, payload.tier)
      if (next !== undefined) companion.replaceState(next)
      break
    }
    case 'setLanguage':
      companion.replaceState({ ...state, language: payload.language })
      break

    // ---- development-only ----

    case 'devAddTokens':
      await loadDev()
      dev = addOffset(dev, payload.provider, payload.amount)
      await saveDev()
      break

    case 'devAddToMilestone': {
      await loadDev()
      const amount =
        payload.scope === 'graduation' ? tokensToGraduation(state) : tokensToMilestone(state).amount
      dev = addOffset(dev, 'claude_code', amount)
      await saveDev()
      break
    }

    case 'devClearOffsets':
      await loadDev()
      // Every provider's total drops, which the ledger treats as a regression and rebases —
      // exactly what happens when a log is rotated, so this exercises that branch too.
      dev = clearOffsets(dev)
      delete dev.dateOverride
      await saveDev()
      break

    case 'devGrantItem':
      companion.replaceState(grantItem(state, payload.item, payload.count))
      break

    case 'devGrantTokens':
      companion.replaceState(grantTokens(state, payload.amount))
      break

    case 'devSetShiny':
      companion.replaceState(setShiny(state, payload.value))
      break

    case 'devSetDitto':
      companion.replaceState(setDittoDisguise(state, payload.value))
      break

    case 'devSetEggTier':
      companion.replaceState(setEggTier(state, payload.tier))
      break

    case 'devDayRollover':
      await loadDev()
      // A date the ledger has never seen forces the rollover branch on the next observation.
      dev.dateOverride = `2099-01-${String(1 + (new Date().getSeconds() % 28)).padStart(2, '0')}`
      await saveDev()
      break

    case 'devResetSave':
      companion.replaceState(freshCompanionState(), false)
      await loadDev()
      dev = clearOffsets(dev)
      delete dev.dateOverride
      await saveDev()
      break

    case 'devSnapshot':
      if (payload.slot === 'save') {
        await devFS.writeFile(DEV_SNAPSHOT_FILE, JSON.stringify(state), 'utf8')
      } else {
        try {
          const raw = await devFS.readFile(DEV_SNAPSHOT_FILE, 'utf8')
          companion.replaceState(JSON.parse(raw) as typeof state, false)
        } catch {
          // Nothing snapshotted yet.
        }
      }
      break
  }
  await companion.save()
}

/**
 * Everything the panel renders, already formatted and localised. Ids are opaque tokens the
 * webview echoes back — it never parses them, so a rename here cannot break the UI silently.
 */
function buildPanel(
  usage: ReturnType<typeof buildSnapshot>,
  locale: string | undefined,
  devMode = false,
): PanelState {
  const state = companion.snapshot()
  const lang = state.language
  const line = companion.currentLine()
  const spendable = spendableBalance(state)

  const shop: PanelShopItem[] = []
  for (const kind of ITEM_KINDS) {
    const owned = itemIsPassive(kind) && itemCount(state, kind) > 0
    shop.push({
      id: `item:${kind}`,
      emoji: itemEmoji(kind),
      title: D.itemName(lang, kind),
      description: D.itemDescription(lang, kind),
      priceText: compact(shopEntryPrice({ kind: 'item', item: kind })),
      enabled: canBuyItem(state, kind),
      owned,
    })
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
      })
    }
  }
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

  const panel: PanelState = {
    totals: {
      todayText: grouped(usage.totals.todayTokens, locale),
      todayCostText: cost(usage.totals.todayCost),
      monthText: grouped(usage.totals.monthTokens, locale),
      monthCostText: cost(usage.totals.monthCost),
    },
    providers: usage.providers.map((p) => ({
      displayName: p.displayName,
      todayText: compact(p.today?.totalTokens ?? 0),
      monthText: compact(p.month?.totalTokens ?? 0),
    })),
    spendableText: compact(spendable),
    shop,
    bag,
    dexSpecies: species,
    dexLog,
    language: lang,
    languages: APP_LANGUAGES.map((id) => ({ id, label: languageLabel(id) })),
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
    if (view.name !== undefined) c.name = view.name
    if (view.speciesID !== undefined) c.speciesID = view.speciesID
    if (view.stageText !== undefined) c.stageText = view.stageText
    if (state.active !== undefined) {
      c.rarityText = D.rarityLabel(lang, state.active.rarity)
      if (state.active.nature !== undefined) c.natureText = natureName(state.active.nature, lang)
    }
    panel.companion = c
  }
  if (devMode) panel.dev = buildDevPanel()
  return panel
}

/**
 * The Dev tab's contents, straight from the scenario table plus the live summary.
 *
 * Nothing is decided here: adding a scenario is one entry in `core/dev/scenarios.ts` and it shows
 * up in the tab and in the quick pick at once.
 */
function buildDevPanel(): NonNullable<PanelState['dev']> {
  const groups = DEV_GROUPS.map((group) => ({
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
  })).filter((group) => group.controls.length > 0)

  return { summary: devSummary(companion.snapshot(), dev), groups }
}

parentPort?.on('message', (message: WorkerRequest) => {
  const wantsPanel = message.type === 'panel' || message.type === 'action'
  const work =
    message.type === 'action'
      ? applyAction(message.payload).then(() => scan(message.locale))
      : scan(message.locale)
  void work
    .then((snapshot) => {
      const response: ScanResponse = wantsPanel
        ? {
            id: message.id,
            ok: true,
            panel: buildPanel(snapshot, message.locale, message.devMode ?? false),
          }
        : { id: message.id, ok: true, snapshot }
      parentPort?.postMessage(response)
    })
    .catch((e: unknown) => {
      const response: ScanResponse = {
        id: message.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }
      parentPort?.postMessage(response)
    })
})

// Keep the resolved roots warm so the first scan does not also pay for discovery.
void claudeProjectRoots().catch(() => undefined)
void Promise.resolve(codexSessionsDir())
