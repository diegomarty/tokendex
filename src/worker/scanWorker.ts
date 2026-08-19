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
import { createDispatcher } from './dispatcher.js'
import {
  type CompanionView,
  type LimitRow,
  type ProviderReport,
  aggregateProviders,
  buildSnapshot,
  totalsFor,
} from '../core/snapshot.js'
import { LocalUsageCache } from '../core/usage/cache.js'
import { type Entry, enrichmentScanStart, todayKey } from '../core/usage/entry.js'
import { claudeProjectRoots, codexSessionsDir } from '../core/usage/roots.js'
import { CompanionStore } from '../core/companion/store.js'
import {
  CRIT_THRESHOLD,
  LimitsPoller,
  WARN_THRESHOLD,
  highestUtilization,
  isLimitWarning,
} from '../core/limits/poller.js'
import { candyEligibleWindows } from '../core/limits/windows.js'
import { type BurnTier, burnTierFor, eggProgress, eggTokensToHatch } from '../core/companion/display.js'
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
import { type CelebrationEvent, celebrationText, openPanelLabel } from '../core/i18n/dispatch.js'
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

/**
 * Re-renders the panel from the last completed scan without scanning again. This is how an
 * open panel stays in step with the status bar: the scan that just finished already holds
 * everything the panel shows, so rebuilding it costs string formatting, not a disk pass.
 * Before it existed, a panel kept open doubled every tick's scan work.
 */
export interface RenderRequest {
  id: number
  type: 'render'
  locale?: string
  devMode?: boolean
}

export type WorkerRequest = ScanRequest | PanelRequest | ActionRequest | RenderRequest

/** Fire-and-forget broadcast, outside the request/response ids: celebration toasts. */
export interface CelebrateBroadcast {
  celebrate: string[]
  openLabel: string
}

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

  // Aggregate once. The same reports feed the ledger, the burn tier and the final snapshot:
  // building a full snapshot here just to read them meant paying the three passes over every
  // entry twice per scan (and its status text and tooltip were thrown away unread).
  const providers = aggregateProviders(sources, now)
  const totals = totalsFor(providers)

  let view: CompanionView | undefined
  let limitWarning = false
  let limitPercent: number | undefined
  let limitRows: LimitRow[] = []
  try {
    const observed: Record<string, number> = {}
    for (const p of providers) {
      if (p.today !== undefined) observed[p.providerID] = p.today.totalTokens
    }
    await loadDev()
    const todayTokensByProvider = applyDevOffsets(observed, dev)
    await companion.update({
      todayTokensByProvider,
      todayDate: dev.dateOverride ?? todayKey(now),
      hasUsageData: providers.some((p) => p.entries > 0),
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
    // The game's peak moments — hatch, evolution, graduation, a candy grant — accumulate in
    // the store and would otherwise happen in silence. They ride their own broadcast (not the
    // response) so a panel request and a timer scan celebrate exactly once each.
    const celebrations: CelebrationEvent[] = [
      ...companion.drainEvents(),
      ...outcome.grants.map((g): CelebrationEvent => ({
        kind: 'candyGranted',
        count: g.count,
        windowName: g.windowName,
      })),
    ]
    if (celebrations.length > 0) {
      const lang = companion.snapshot().language
      parentPort?.postMessage({
        celebrate: celebrations.map((event) => celebrationText(lang, event)),
        openLabel: openPanelLabel(lang),
      })
    }

    limitWarning = isLimitWarning(known.sources)
    // Only providers that actually logged something today: a limit window for a tool you have
    // not touched says nothing about the session you are in.
    const usedToday = new Set(
      providers.filter((p) => (p.today?.totalTokens ?? 0) > 0).map((p) => p.providerID),
    )
    limitPercent = highestUtilization(known.sources, usedToday)
    limitRows = candyEligibleWindows(known.sources, companion.snapshot().language).map((window) => ({
      label: window.name,
      value: `${Math.round(window.utilization)}%`,
      percent: window.utilization,
      severity: limitSeverity(window.utilization),
    }))
    view = companionView(locale, {
      burnTier: burnTierFor(combinedBurnPerMinute(providers)),
      limitWarning,
      hasUsageData: providers.some((p) => p.entries > 0),
      todayTokens: totals.todayTokens,
    })
  } catch (e) {
    errors.push(`Companion: ${e instanceof Error ? e.message : String(e)}`)
  }

  return buildSnapshot(sources, {
    now,
    providers,
    ...(locale !== undefined ? { locale } : {}),
    lang: companion.snapshot().language,
    errors,
    ...(view !== undefined ? { companion: view } : {}),
    ...(limitPercent !== undefined ? { limitPercent } : {}),
    limitWarning,
    limitRows,
  })
}

/**
 * How alarming a window is, from the same thresholds the status bar's warning background uses.
 *
 * TODO: `WARN_THRESHOLD`/`CRIT_THRESHOLD` live in `limits/poller.ts`, which cannot be imported by
 * the pure `limits/windows.ts` (that would be circular), so this mapping sits in the worker and is
 * outside the test suite. Moving the two constants to `windows.ts` would let the row builder move
 * there with them and be covered.
 */
function limitSeverity(percent: number): LimitRow['severity'] {
  if (percent >= CRIT_THRESHOLD) return 'crit'
  if (percent >= WARN_THRESHOLD) return 'warn'
  return 'normal'
}

/**
 * Burn summed across providers, matching `UsageStore.combinedBurnPerMinute`.
 *
 * Summed rather than maxed: two tools at 60K/min each is one fast session, and tiering them
 * apart would call it two normal ones.
 */
function combinedBurnPerMinute(providers: ProviderReport[]): number {
  return providers.reduce((total, p) => total + (p.tokensPerMinute ?? 0), 0)
}

/** Everything the UI needs, already formatted — it must never re-derive a number. */
function companionView(
  locale: string | undefined,
  display: { burnTier: BurnTier; limitWarning: boolean; hasUsageData: boolean; todayTokens: number },
): CompanionView {
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
    state: companion.displayState(display),
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
      todayText: compact(usage.totals.todayTokens),
      todayExactText: grouped(usage.totals.todayTokens, locale),
      todayCostText: cost(usage.totals.todayCost),
      monthText: compact(usage.totals.monthTokens),
      monthExactText: grouped(usage.totals.monthTokens, locale),
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

// Serialization and the render-from-last-scan shortcut live in `dispatcher.ts`, where they
// are tested with stubs; this wiring is the only untested part.
const dispatch = createDispatcher<WorkerAction, ReturnType<typeof buildSnapshot>, PanelState>({
  scan,
  applyAction,
  buildPanel,
  post: (response) => parentPort?.postMessage(response),
})

parentPort?.on('message', dispatch)

// Keep the resolved roots warm so the first scan does not also pay for discovery.
void claudeProjectRoots().catch(() => undefined)
void Promise.resolve(codexSessionsDir())
