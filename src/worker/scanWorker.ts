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
import { LimitsPoller, highestUtilization, isLimitWarning } from '../core/limits/poller.js'
import { candyEligibleWindows, limitSeverity } from '../core/limits/windows.js'
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
import { compact, percent } from '../core/tokenFormatter.js'
import { f } from '../core/i18n/strings.js'
import { stage as stageLabel } from '../core/i18n/dispatch.js'
import { type CelebrationEvent, celebrationText, openPanelLabel } from '../core/i18n/dispatch.js'
import * as D from '../core/i18n/dispatch.js'
import { panelStrings } from '../core/i18n/panelStrings.js'
import { cost } from '../core/tokenFormatter.js'
import { type BallKind } from '../core/companion/model.js'
import { spawnTestEncounter, grantBalls } from '../core/dev/simulation.js'
import type { PanelDevControl, PanelState, PanelThrowResult } from '../webview/protocol.js'

export type WorkerAction =
  | { action: 'buyItem'; item: ItemKind; quantity?: number }
  | { action: 'useItem'; item: ItemKind }
  | { action: 'buyEgg'; tier?: Rarity }
  | { action: 'setLanguage'; language: AppLanguage }
  | { action: 'throwBall'; encounterID: string; ball: BallKind }
  | { action: 'runFrom'; encounterID: string }
  | { action: 'setTrainer'; trainerID: string }
  // Development-only. Declared in `core/dev/scenarios.ts` so the panel's Dev tab, the quick pick
  // and this switch are all driven by one table.
  | DevAction

export interface ScanRequest {
  id: number
  type: 'scan'
  locale?: string
  /** `tokendex.encounterNotifications` !== 'off'. Sticky: absent keeps the last value. */
  encounterToasts?: boolean
  /** The host's `tokendex.refreshInterval`, for the Settings picker. Sticky like the flag. */
  refreshSeconds?: number
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
  /**
   * Re-render from the last scan instead of re-scanning after the action. Set for the
   * latency-sensitive game actions (a throw's animation awaits this reply): the usage half did
   * not change, and `buildPanel` reads the companion store fresh anyway.
   */
  fromLastScan?: boolean
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
  /** `extra` rides beside the panel on a throw reply — never inside `PanelState`, which is
   *  replayed to late-opening surfaces and would replay the animation. */
  | { id: number; ok: true; panel: PanelState; extra?: PanelThrowResult }
  | { id: number; ok: false; error: string }

interface WorkerConfig {
  cacheFilePath?: string
  claudeRoots?: string[]
  codexRoot?: string
}

const config = (workerData ?? {}) as WorkerConfig

// Re-exported from the core panel builder, its real home, so the host's import keeps working.
export { REFRESH_PRESETS } from '../core/panel/build.js'
import { buildPanelState } from '../core/panel/build.js'

/**
 * Whether an encounter may toast at all (`tokendex.encounterNotifications`). Carried on every
 * request rather than read here — the worker has no access to VS Code configuration — and held
 * as a flag the store reads through a callback, so a change applies without a restart.
 */
let encounterToasts = true

/** The host's current `tokendex.refreshInterval`, piggybacked on requests like the flag above. */
let refreshSecondsSetting: number | undefined

const companion = new CompanionStore({
  provider: new PokeAPIClient(),
  encounterToastsEnabled: () => encounterToasts,
})

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
  const wildCount = state.wild.length
  const wildTooltip = D.wildBadgeTooltip(lang, wildCount)

  if (active === undefined) {
    return {
      state: 'egg',
      isShiny: false,
      progress: eggProgress(state),
      toNextText: f.eggToHatch(lang, compact(eggTokensToHatch(state))),
      dexCount,
      spendableTokens,
      wildCount,
      wildTooltip,
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
    wildCount,
    wildTooltip,
  }
  const name = companion.displayName()
  if (name !== undefined) view.name = name
  return view
}

/**
 * The scene's result line, pre-localised — the webview must never compose localised text.
 * Present tense theatre, matching the games: "Gotcha!", "It broke free!", "It fled…".
 */
function throwResultText(
  lang: AppLanguage,
  outcome: { kind: string; shakes?: number },
  name: string,
  isShiny: boolean,
): string {
  switch (outcome.kind) {
    case 'caught':
      return celebrationText(lang, { kind: 'wildCaught', name, isShiny })
    case 'broke':
      return D.brokeFreeText(lang, outcome.shakes ?? 0)
    case 'fled':
      return D.fledText(lang, name)
    case 'noBall':
      return D.wildNoBallsText(lang)
    default:
      return '' // unknownEncounter: the state push already removed the scene
  }
}

/**
 * Applies a user action, then rescans so the reply carries a fully consistent snapshot. The
 * webview never mutates state itself — it only asks, and re-renders whatever comes back.
 *
 * A throw returns its outcome, which the dispatcher attaches to the reply beside the panel.
 */
async function applyAction(payload: WorkerAction): Promise<PanelThrowResult | undefined> {
  await companion.load()
  const state = companion.snapshot()

  switch (payload.action) {
    case 'buyItem': {
      const next = buyItem(state, payload.item, payload.quantity ?? 1)
      if (next !== undefined) companion.replaceState(next)
      break
    }

    case 'throwBall': {
      // The name is captured before the throw: a caught or fled encounter is gone afterwards.
      const target = state.wild.find((e) => e.id === payload.encounterID)
      const name = target?.names?.[state.language] ?? `#${target?.speciesID ?? '?'}`
      const outcome = await companion.throwBallAt(payload.encounterID, payload.ball)
      const shakes = 'shakes' in outcome ? outcome.shakes : 0
      return {
        encounterID: payload.encounterID,
        kind: outcome.kind,
        shakes,
        resultText: throwResultText(
          companion.snapshot().language,
          outcome,
          name,
          target?.isShiny ?? false,
        ),
      }
    }

    case 'runFrom':
      await companion.runFrom(payload.encounterID)
      break

    case 'setTrainer':
      await companion.setTrainer(payload.trainerID)
      break
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

    case 'devSpawnEncounter':
      companion.replaceState(spawnTestEncounter(state, payload.variant, Date.now()))
      break

    case 'devGrantBalls':
      companion.replaceState(grantBalls(state, payload.count))
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
  return undefined
}

/**
 * Thin wrapper over the core's pure `buildPanelState`: this side only collects what is impure —
 * the store's live readings, the clock, the piggybacked settings and the dev tab.
 */
function buildPanel(
  usage: ReturnType<typeof buildSnapshot>,
  locale: string | undefined,
  devMode = false,
): PanelState {
  return buildPanelState({
    usage,
    state: companion.snapshot(),
    line: companion.currentLine(),
    isCelebrating: companion.isCelebrating(),
    now: Date.now(),
    locale,
    refreshSeconds: refreshSecondsSetting,
    dev: devMode ? buildDevPanel() : undefined,
  })
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
const dispatch = createDispatcher<
  WorkerAction,
  ReturnType<typeof buildSnapshot>,
  PanelState,
  PanelThrowResult
>({
  scan,
  applyAction,
  buildPanel,
  post: (response) => parentPort?.postMessage(response),
})

parentPort?.on('message', (message: WorkerRequest) => {
  // Settings piggyback on requests because a worker cannot read VS Code configuration.
  if ('encounterToasts' in message && typeof message.encounterToasts === 'boolean') {
    encounterToasts = message.encounterToasts
  }
  if ('refreshSeconds' in message && typeof message.refreshSeconds === 'number') {
    refreshSecondsSetting = message.refreshSeconds
  }
  dispatch(message)
})

// Keep the resolved roots warm so the first scan does not also pay for discovery.
void claudeProjectRoots().catch(() => undefined)
void Promise.resolve(codexSessionsDir())
