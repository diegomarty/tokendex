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
  todayTokensByProvider,
  totalsFor,
} from '../core/snapshot.js'
import {
  ScanLease,
  type ScanObservation,
  observeThroughLease,
  readPublishedScan,
} from '../core/coordination/scanLease.js'
import { LocalUsageCache } from '../core/usage/cache.js'
import { type Entry, enrichmentScanStart, todayKey } from '../core/usage/entry.js'
import { claudeProjectRoots, codexSessionsDir } from '../core/usage/roots.js'
import { CompanionStore, SaveBusyError } from '../core/companion/store.js'
import { LimitsPoller, highestUtilization, isLimitWarning } from '../core/limits/poller.js'
import { candyEligibleWindows, limitSeverity } from '../core/limits/windows.js'
import { type BurnTier, burnTierFor, eggProgress, eggTokensToHatch } from '../core/companion/display.js'
import { stageProgress, tokensToNext } from '../core/companion/growth.js'
import { PokeAPIClient } from '../core/pokeapi.js'
import {
  type AppLanguage,
  type CompanionState,
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
import { atomicWriteFile, sweepOrphanTemporaries } from '../core/coordination/atomicWrite.js'
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
  /** The host's `tokendex.refreshInterval`, for the Settings picker. Sticky like the flag. */
  refreshSeconds?: number
}

/**
 * Another window changed a file in `ourData()`; re-read it and rebuild.
 *
 * Sent by the host's watcher, debounced, so a catch or a purchase in one window reaches the
 * other in about a second instead of at its next tick. Strictly read-only: it never scans and
 * never writes, which is what keeps two watching windows from answering each other for ever.
 */
export interface SyncRequest {
  id: number
  type: 'sync'
  locale?: string
}

/**
 * Shut down cleanly: persist what is still buffered, then hand back the scan lease.
 *
 * The usage cache throttles its writes to once a minute, so a window closed shortly after a
 * scan that parsed something new would otherwise discard that work and re-parse it on the next
 * launch. Releasing the lease is the other half: without it the next window waits out the
 * staleness ceiling before it may scan, for a window that closed politely. The host sends this
 * from `deactivate`, bounded by a timeout — a flush queued behind a cold scan must never be
 * what keeps a window open.
 */
export interface FlushRequest {
  id: number
  type: 'flush'
}

export type WorkerRequest =
  ScanRequest | PanelRequest | ActionRequest | RenderRequest | SyncRequest | FlushRequest

/** Fire-and-forget broadcast, outside the request/response ids: celebration toasts. */
export interface CelebrateBroadcast {
  celebrate: string[]
  openLabel: string
}

export type ScanResponse =
  | { id: number; ok: true; snapshot: ReturnType<typeof buildSnapshot> }
  /** Answer to a `flush`: everything buffered is on disk. */
  | { id: number; ok: true; flushed: true }
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
/**
 * The in-flight read, not a "loaded" flag. Same reason `LocalUsageCache.ensureLoaded` holds
 * one: a flag flipped before the `await` lets a second caller run against the *fresh* dev
 * state while the file is still being read, and a `saveDev()` on that path would then write
 * the empty state over the user's offsets.
 */
let devLoading: Promise<void> | undefined

/**
 * Awaits the one read, then hands back the **current** state.
 *
 * Returning the memoised promise directly would resolve every later call with the object
 * captured at first read, so a caller that wrote `const d = await loadDev()` would silently
 * get pre-mutation offsets. Every call site happens to read the module variable today; this
 * makes the signature tell the truth rather than relying on that.
 */
async function loadDev(): Promise<DevState> {
  devLoading ??= readDev()
  await devLoading
  return dev
}

async function readDev(): Promise<void> {
  try {
    dev = {
      ...freshDevState(),
      ...(JSON.parse(await devFS.readFile(DEV_FILE, 'utf8')) as DevState),
    }
  } catch {
    dev = freshDevState()
  }
}

async function saveDev(): Promise<void> {
  try {
    // Per-writer temp then rename: every other window's worker writes this same path, and a
    // plain `writeFile` there truncates in place — a reader lands in the hole and the offsets
    // read back as a fresh dev state.
    await atomicWriteFile(DEV_FILE, JSON.stringify(dev), 'utf8')
  } catch {
    // Dev-only: a write failure must never break a refresh.
  }
}

/**
 * The scan lease (`docs/multi-window.md` §6 stage 2, §3.6).
 *
 * **It lives here, in the worker, and not on the extension host.** Three facts decide that.
 * The decision it drives — scan, or read what the holder published — has to be taken at the
 * moment the scan runs, and a flag piggybacked from the host on the request would be a
 * decision taken one round trip ago about a lease another window may since have broken. The
 * publication is produced here, because the aggregated providers only exist here. And the
 * heartbeat has to be touched after each scan, which is an event only this side sees.
 *
 * What the host keeps is the half that is genuinely its own: the lifecycle. `deactivate`
 * sends `flush`, and releasing the lease is the last thing that request does.
 */
const lease = new ScanLease({ directory: ourData() })

/**
 * The lease holder's heartbeat cadence.
 *
 * Deliberately independent of `tokendex.refreshInterval`. Touching only after each scan would
 * tie staleness to a setting that ranges from 30 s to 10 minutes and is stretched further by
 * the host's unfocused backoff (three skipped ticks), so a ten-minute interval would need a
 * half-hour ceiling — and a window killed at the start of that would own the scan, dead, for
 * half an hour. `LEASE_STALE_AFTER_MS` is four missed touches at this cadence.
 */
const LEASE_HEARTBEAT_MS = 20_000
let leaseHeartbeat: NodeJS.Timeout | undefined

const cache = new LocalUsageCache({
  // Only the elected window publishes the cache. The gate matters most at the moment §3.5
  // names: a closing window's `flush` writing its view over the survivor's fresher parse.
  canPersist: () => lease.owned,
  ...(config.cacheFilePath !== undefined ? { filePath: config.cacheFilePath } : {}),
  ...(config.claudeRoots !== undefined ? { claudeRoots: config.claudeRoots } : {}),
  ...(config.codexRoot !== undefined ? { codexRoot: config.codexRoot } : {}),
})

/**
 * The last observation, for the `sync` path — it recomposes rather than re-observing.
 *
 * `ScanObservation` carries `scannedAt`: when the disk pass behind `providers` ran, ours or
 * the holder's. Everything time-shaped downstream reads that rather than `Date.now()`,
 * because a follower's numbers are as of the holder's scan. The tooltip would otherwise claim
 * a freshness they do not have, and — the part that costs progress rather than honesty — a
 * follower folding yesterday's cumulative totals against today's date would re-open the
 * ledger's day rollover and credit a whole day a second time.
 */
let lastObservation: ScanObservation | undefined

/** One refresh's worth of observation. The policy lives in `observeThroughLease`. */
async function observe(locale: string | undefined): Promise<ScanObservation> {
  const result = await observeThroughLease({
    directory: ourData(),
    lease,
    scanCorpus: () => readCorpus(locale),
    onOwned: startLeaseHeartbeat,
  })
  return result.observation
}

/**
 * Keeps the lease alive while this window owns it, and stops owning it the moment it does not.
 *
 * `heartbeat()` answering `false` means another window judged us stale and broke the hold —
 * the residual window in break-by-rename that `fileLock.ts` documents as unclosable. A lease
 * that ignored that answer would go on publishing snapshots and writing the usage cache as if
 * it were the elected window, which is two writers with one of them convinced otherwise.
 * `ScanLease.touch` drops the handle, so `lease.owned` is false from that instant and the next
 * `observe` competes for the lease again like any other follower.
 */
function startLeaseHeartbeat(): void {
  if (leaseHeartbeat !== undefined) return
  leaseHeartbeat = setInterval(() => {
    void lease.touch()
  }, LEASE_HEARTBEAT_MS)
  // The worker is kept alive by its message port; this timer must not be what holds it open.
  leaseHeartbeat.unref?.()
}

async function readCorpus(locale: string | undefined): Promise<ScanObservation> {
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
  return { providers: aggregateProviders(sources, now), errors, scannedAt: now }
}

/**
 * A full refresh: observe, fold the observation into the save, and compose the snapshot.
 */
async function scan(locale: string | undefined) {
  const observation = await observe(locale)
  lastObservation = observation
  return compose(observation, locale, { accrue: true })
}

/**
 * Another window wrote something. Re-read it and recompose — no disk pass, and **no write**.
 *
 * Driven by the watcher on `ourData()`. Two things it deliberately does not do. It does not
 * scan: a catch or a purchase changes the save, not the logs. And it does not accrue — the
 * fold ends in a write, and a watch handler that wrote would hand the other window a change
 * to answer, for ever. Accrual belongs to the timer, whose tick is nobody's event.
 *
 * A follower also re-reads the publication here, so the holder finishing a scan reaches every
 * other window in about a second rather than at their own next tick.
 */
async function sync(locale: string | undefined) {
  await companion.syncFromDisk()
  const published = lease.owned ? undefined : await readPublishedScan(ourData())
  const observation = published ?? lastObservation
  // Nothing observed yet by anyone: there is no snapshot to recompose, so do the real thing.
  if (observation === undefined) return scan(locale)
  lastObservation = observation
  return compose(observation, locale, { accrue: false })
}

/**
 * Turns one observation into the snapshot the UI renders.
 *
 * `accrue` is what separates a refresh from a re-read: only a refresh folds the observation
 * into the ledger, grants candy and drains celebrations. Everything below that line is pure
 * presentation and runs on both paths, which is what makes a follower's panel identical in
 * shape to the holder's — same code, same already-localised text, different freshness.
 */
async function compose(
  observation: ScanObservation,
  locale: string | undefined,
  options: { accrue: boolean },
) {
  const { providers, scannedAt } = observation
  const errors = [...observation.errors]
  const totals = totalsFor(providers)

  let view: CompanionView | undefined
  let limitWarning = false
  let limitPercent: number | undefined
  let limitRows: LimitRow[] = []
  try {
    await loadDev()
    // Returns what is already known and fetches for next time, on its own ten-minute cadence,
    // so calling it from the cheap path costs nothing and keeps the limits in the snapshot.
    const known = limits.refresh()
    if (options.accrue) await accrue(observation, known)

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

  // The empty `sources`: `buildSnapshot` only aggregates them when `providers` is absent, and
  // it never is here. Republishing the entries so a follower could re-aggregate them would be
  // republishing the usage cache, megabytes of it, for an answer the holder already computed.
  return buildSnapshot([], {
    now: scannedAt,
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
 * Folds one observation into the save: the ledger, the candy grant, the celebrations.
 *
 * Everything here writes, which is exactly why it is separated from `compose`. The `sync`
 * path must be able to recompose the panel without touching the file — see `sync` above.
 */
async function accrue(observation: ScanObservation, known: ReturnType<LimitsPoller['refresh']>) {
  const { providers, scannedAt } = observation
  // Synthetic dev tokens ride on top of the real observation, so they travel the whole
  // production pipeline (ledger, crediting, growth) instead of being written into the save.
  const observed = applyDevOffsets(todayTokensByProvider(providers), dev)
  await companion.update({
    todayTokensByProvider: observed,
    // The *observation's* day, not this window's. A follower rendering a publication made
    // before midnight must fold it against the day it was made, or the ledger's rollover
    // branch counts that whole day's cumulative total as new usage a second time.
    todayDate: dev.dateOverride ?? todayKey(scannedAt),
    hasUsageData: providers.some((p) => p.entries > 0),
  })
  // After `update`, so the grant lands on the state that was just persisted rather than on
  // a copy `update` is about to overwrite.
  //
  // One transaction, so the grant is decided against the file rather than against this
  // window's copy. Both windows poll the same account-wide limit windows and both cross
  // 100 %, but the second one re-reads a tier the first already armed, so `changed` is
  // false and no candy is granted twice.
  const granted = await companion.mutate((tx) => {
    const outcome = grantCandies(
      tx.state,
      candyEligibleWindows(known.sources, tx.state.language),
      known.ready,
    )
    // Re-arming counts as a change even with no grant: dropping it leaves a stale tier, and
    // the next genuine crossing is then mistaken for one already paid.
    if (outcome.changed) tx.commit(outcome.state)
    return outcome.grants
  })
  // Accrual-shaped, so a busy lock is a skip: the tier stays where it was and the next tick
  // re-evaluates the same limit windows.
  const grants = granted.committed ? granted.value : []
  // The game's peak moments — hatch, evolution, graduation, a candy grant — accumulate in
  // the store and would otherwise happen in silence. They ride their own broadcast (not the
  // response) so a panel request and a timer scan celebrate exactly once each.
  const celebrations: CelebrationEvent[] = [
    ...companion.drainEvents(),
    ...grants.map((g): CelebrationEvent => ({
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
 * One state-changing action, as a single read-modify-write under the save's cross-window lock.
 *
 * Every site here used to read `companion.snapshot()`, transform it and write the result back
 * — which is the §3.2 bug in miniature, once per action: a purchase in one window overwritten
 * by another window's morning-old copy, with the toast already fired. `mutate` closes it by
 * re-reading the file inside the lock, so `fn` always sees the balance, the bag and the queue
 * as they actually are.
 *
 * `undefined` from `fn` means the rule declined (not enough tokens, nothing to use); that is a
 * committed no-op, not a failure. A lock that could not be taken **is** a failure and throws
 * the same `SaveBusyError` the store's own action methods throw, so `applyAction` has exactly
 * one place to turn contention into a sentence the user reads.
 */
async function commit(
  fn: (state: Readonly<CompanionState>) => CompanionState | undefined,
  keepLine = true,
): Promise<void> {
  const result = await companion.mutate((tx) => {
    const next = fn(tx.state)
    if (next !== undefined) tx.commit(next, keepLine)
  })
  if (!result.committed) throw new SaveBusyError()
}

/**
 * Applies a user action, then rescans so the reply carries a fully consistent snapshot. The
 * webview never mutates state itself — it only asks, and re-renders whatever comes back.
 *
 * A throw returns its outcome, which the dispatcher attaches to the reply beside the panel.
 *
 * A `SaveBusyError` becomes localised text here, which is the one and only place it happens:
 * the dispatcher turns a throw into `{ ok: false, error }`, and `handlePanelRequest` shows
 * that string. The core emits the sentence; the host never composes one.
 */
async function applyAction(payload: WorkerAction): Promise<PanelThrowResult | undefined> {
  await companion.load()
  try {
    return await applyActionOn(payload)
  } catch (error) {
    if (error instanceof SaveBusyError) {
      throw new Error(D.saveBusyText(companion.snapshot().language))
    }
    throw error
  }
}

async function applyActionOn(payload: WorkerAction): Promise<PanelThrowResult | undefined> {
  switch (payload.action) {
    case 'buyItem':
      await commit((state) => buyItem(state, payload.item, payload.quantity ?? 1))
      return undefined

    case 'throwBall': {
      // The name is captured before the throw: a caught or fled encounter is gone afterwards.
      // Read from this window's last-known queue rather than from inside the hold, because it
      // only feeds the animation's caption — the throw itself resolves against the re-read
      // queue, so an encounter another window already caught answers `unknownEncounter`.
      const before = companion.snapshot()
      const target = before.wild.find((e) => e.id === payload.encounterID)
      const name = target?.names?.[before.language] ?? `#${target?.speciesID ?? '?'}`
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
      return undefined

    case 'setTrainer':
      await companion.setTrainer(payload.trainerID)
      return undefined

    case 'useItem': {
      if (payload.item === 'rareCandy') {
        // The debit and the XP it buys are one operation, so they share one hold: committing
        // the spend and then growing outside it would let another window's write land between
        // them and swallow the candy's effect while keeping the charge.
        const result = await companion.mutate((tx) => {
          const next = consumeRareCandy(tx.state)
          if (next === undefined) return
          tx.commit(next)
          tx.applyCandy()
        })
        if (!result.committed) throw new SaveBusyError()
      } else if (payload.item === 'mint') {
        await commit((state) => useMint(state, () => Math.floor(Math.random() * 0x7fffffff))?.state)
      }
      return undefined
    }

    case 'buyEgg':
      await commit((state) => buyEgg(state, payload.tier))
      return undefined

    case 'setLanguage':
      await commit((state) => ({ ...state, language: payload.language }))
      return undefined

    // ---- development-only ----
    //
    // The dev offsets live in their own file and are this window's alone, so they are not
    // under the save's lock. Anything that touches the *save* still goes through `commit`.

    case 'devAddTokens':
      await loadDev()
      dev = addOffset(dev, payload.provider, payload.amount)
      await saveDev()
      return undefined

    case 'devAddToMilestone': {
      await loadDev()
      const state = companion.snapshot()
      const amount =
        payload.scope === 'graduation' ? tokensToGraduation(state) : tokensToMilestone(state).amount
      dev = addOffset(dev, 'claude_code', amount)
      await saveDev()
      return undefined
    }

    case 'devClearOffsets':
      await loadDev()
      // Every provider's total drops, which the ledger treats as a regression and rebases —
      // exactly what happens when a log is rotated, so this exercises that branch too.
      dev = clearOffsets(dev)
      delete dev.dateOverride
      await saveDev()
      return undefined

    case 'devGrantItem':
      await commit((state) => grantItem(state, payload.item, payload.count))
      return undefined

    case 'devGrantTokens':
      await commit((state) => grantTokens(state, payload.amount))
      return undefined

    case 'devSetShiny':
      await commit((state) => setShiny(state, payload.value))
      return undefined

    case 'devSetDitto':
      await commit((state) => setDittoDisguise(state, payload.value))
      return undefined

    case 'devSetEggTier':
      await commit((state) => setEggTier(state, payload.tier))
      return undefined

    case 'devDayRollover':
      await loadDev()
      // A date the ledger has never seen forces the rollover branch on the next observation.
      dev.dateOverride = `2099-01-${String(1 + (new Date().getSeconds() % 28)).padStart(2, '0')}`
      await saveDev()
      return undefined

    case 'devResetSave':
      await commit(() => freshCompanionState(), false)
      await loadDev()
      dev = clearOffsets(dev)
      delete dev.dateOverride
      await saveDev()
      return undefined

    case 'devSpawnEncounter':
      await commit((state) => spawnTestEncounter(state, payload.variant, Date.now()))
      return undefined

    case 'devGrantBalls':
      await commit((state) => grantBalls(state, payload.count))
      return undefined

    case 'devSnapshot':
      if (payload.slot === 'save') {
        // Read inside a hold so the copy is the file's state, not this window's: a snapshot
        // taken from a stale copy would resurrect that copy whenever it was restored. The
        // write to the snapshot file itself needs no lock — nothing else writes that path.
        const taken = await companion.mutate((tx) => JSON.stringify(tx.state))
        if (!taken.committed) throw new SaveBusyError()
        await atomicWriteFile(DEV_SNAPSHOT_FILE, taken.value, 'utf8')
      } else {
        let restored: CompanionState | undefined
        try {
          restored = JSON.parse(await devFS.readFile(DEV_SNAPSHOT_FILE, 'utf8')) as CompanionState
        } catch {
          // Nothing snapshotted yet.
        }
        if (restored !== undefined) await commit(() => restored, false)
      }
      return undefined
  }
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
  sync,
  // The companion store already saves on every change, so the usage cache — which throttles
  // its writes — is the only thing that can still be holding work in memory. `flush`, not
  // `save`: a window closed with nothing new parsed must not pay for a full rewrite. The
  // scan lease is handed back in the same request; see `shutdown` for why in that order.
  flush: shutdown,
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

/**
 * The closing sequence, in this order and for a reason.
 *
 * The cache is flushed **while the lease is still held**, because the flush is gated on
 * exactly that (`canPersist`); releasing first would silently discard the parse this window
 * just paid for. Releasing second hands the scan to the next window immediately rather than
 * making it wait out the staleness ceiling for a window that closed politely.
 *
 * Both halves are best effort. The host bounds this request at 1.5 s, and a lease that is not
 * released simply goes stale — which is the path a `kill -9` takes anyway.
 */
async function shutdown(): Promise<void> {
  await cache.flush()
  stopLeaseHeartbeat()
  await lease.release()
}

function stopLeaseHeartbeat(): void {
  if (leaseHeartbeat !== undefined) clearInterval(leaseHeartbeat)
  leaseHeartbeat = undefined
}

// Keep the resolved roots warm so the first scan does not also pay for discovery.
void claudeProjectRoots().catch(() => undefined)
void Promise.resolve(codexSessionsDir())

// Per-writer temp names removed the shared-name corruption of §3.1 by trading it for one
// orphan per `kill -9` mid-write, and nothing else in the product would ever collect them.
// Once per worker, detached: housekeeping must never be on a refresh's critical path, and the
// one-hour floor means several windows sweeping at once cannot touch a live writer's file.
void sweepOrphanTemporaries(ourData())
