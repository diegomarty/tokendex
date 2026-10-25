/**
 * Extension entry point: status bar, refresh timer, worker lifecycle.
 *
 * Everything under `src/core/` is free of `vscode` imports so it stays unit-testable without
 * launching VS Code — `test/usage-environment.test.ts` enforces related invariants. This file
 * is the only place allowed to touch the VS Code API.
 */

import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { type UsageSnapshot, todayTokensByProvider } from './core/snapshot.js'
import type {
  CelebrateBroadcast,
  ScanResponse,
  SyncBroadcast,
  WorkerAction,
  WorkerRequest,
} from './worker/scanWorker.js'
import { REFRESH_PRESETS } from './worker/scanWorker.js'
import { GamePanel } from './panel.js'
import { GameViewProvider, VIEW_ID } from './view.js'
/**
 * The Explorer home of the compact companion card. The id predates the card (it named an
 * animated scene that was discarded); it is kept because changing a view id resets where
 * users have dragged the view.
 */
const AMBIENT_VIEW_ID = 'tokendex.ambient'
import {
  type PanelRequestKind,
  anySurfaceOpen,
  broadcastThrow,
  deliverNews,
  reloadSurfaces,
  updateSurfaces,
} from './surface.js'
import { pickScenario } from './dev.js'
import { devScenarioByID } from './core/dev/scenarios.js'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { ourData } from './core/appPaths.js'
import { atomicWriteFile } from './core/coordination/atomicWrite.js'
import { type WatchHandle, watchDataDirectory } from './core/coordination/dataWatcher.js'
import { FileLock, lockPathFor } from './core/coordination/fileLock.js'
import { todayKey } from './core/usage/entry.js'
import { parseCompanionState } from './core/companion/persistence.js'
import {
  type SaveEnvelope,
  SaveTransferFailure,
  backupFileName,
  decodeSave,
  encodeSave,
  pruneBackups,
  rebasedForThisDevice,
  sanitized,
  suggestedFileName,
  summarize,
} from './core/companion/saveTransfer.js'
import { deviceIdentity } from './core/companion/device.js'
import { mergeSaves, withRevision } from './core/companion/merge.js'
import type { AppLanguage, Rarity } from './core/companion/model.js'
import {
  ANIMATED_SPECIES_MAX,
  BALL_KINDS,
  ITEM_KINDS,
  parsePackQuantity,
  isBerryKind,
  itemIsBundled,
} from './core/companion/model.js'
import { purchaseNeedsConfirmation } from './core/companion/shop.js'
import { isTrainerID } from './core/companion/trainers.js'
import { freshCompanionState, systemDefaultLanguage } from './core/companion/model.js'
import {
  importChoiceDetail,
  importMergeLabel,
  importReplaceLabel,
  importSourceText,
  importedText,
  mergedText,
  openPanelLabel,
  syncChoiceDetail,
  syncChoiceText,
  syncConsentDetail,
  syncConsentText,
  syncContinuedFromText,
  syncDisabledText,
  syncDoneText,
  syncEnableLabel,
  syncFailedText,
  syncKeepLocalLabel,
  syncKeepRemoteLabel,
  syncNewerPeerText,
  syncNotTurnedOnText,
  syncSignInLabel,
  welcomeToast,
} from './core/i18n/dispatch.js'

const DEFAULT_REFRESH_SECONDS = 120

let statusBar: vscode.StatusBarItem | undefined
let worker: Worker | undefined
let timer: NodeJS.Timeout | undefined
let pending: Map<number, (r: ScanResponse) => void> = new Map()
let nextRequestID = 1
let scanInFlight = false
let lastSnapshot: UsageSnapshot | undefined
let output: vscode.LogOutputChannel | undefined
let extensionContext: vscode.ExtensionContext | undefined
/** Production until `activate` says otherwise, so a missing value never unlocks dev mode. */
let extensionMode: vscode.ExtensionMode = vscode.ExtensionMode.Production
let view: GameViewProvider | undefined
/** True across a deliberate `terminate()`, so the exit handler knows not to resurrect it. */
let workerStopping = false
/** Crash-restart timestamps inside the last hour — the cap that stops a crash loop. */
let workerRestarts: number[] = []
const MAX_WORKER_RESTARTS_PER_HOUR = 3

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context
  extensionMode = context.extensionMode
  output = vscode.window.createOutputChannel('Tokendex', { log: true })
  context.subscriptions.push(output)

  // Logged because it is the one thing that cannot be checked by reading the code: whether an
  // installed `.vsix` really reports Production, which is what keeps the Dev tab and the scenario
  // menu out of a released build. Verify it once per release in a clean profile.
  const modeName =
    extensionMode === vscode.ExtensionMode.Production
      ? 'production'
      : extensionMode === vscode.ExtensionMode.Development
        ? 'development'
        : 'test'
  output.info(
    `Tokendex ${version()} · extension mode: ${modeName} · dev surface: ${devModeOn() ? 'on' : 'off'}`,
  )

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.name = 'Tokendex'
  statusBar.command = 'tokendex.open'
  statusBar.text = '$(sync~spin) Tokendex'
  statusBar.tooltip = 'Reading local usage…'
  statusBar.show()
  context.subscriptions.push(statusBar)

  context.subscriptions.push(
    vscode.commands.registerCommand('tokendex.refresh', () => void refresh(true)),
    vscode.commands.registerCommand('tokendex.showOutput', () => output?.show()),
    // Focusing the view reveals the container and creates the webview if it does not exist yet,
    // which is what the status bar click and the command palette both want.
    //
    // `<viewId>.focus` is generated by VS Code from the manifest, so it only exists once the
    // window has *discovered* the new contribution — a restarted extension host is not enough,
    // the debug session has to be relaunched. Falling back to the editor tab means the click
    // always does something instead of failing silently, and the log says why.
    vscode.commands.registerCommand('tokendex.open', async () => {
      try {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`)
      } catch (error) {
        output?.warn(
          `the sidebar view is not registered yet (${error instanceof Error ? error.message : String(error)}) — relaunch the extension host; opening the editor tab instead`,
        )
        GamePanel.show(context.extensionUri, dispatchPanelRequest)
      }
    }),
    vscode.commands.registerCommand('tokendex.openInEditor', () => {
      GamePanel.show(context.extensionUri, dispatchPanelRequest)
    }),
    vscode.commands.registerCommand('tokendex.dev', () => void runDevScenario()),
    vscode.commands.registerCommand('tokendex.reloadWebview', () => reloadSurfaces()),
    vscode.commands.registerCommand('tokendex.syncNow', () =>
      syncNowCommand().catch((error: unknown) => output?.warn(`sync: ${String(error)}`)),
    ),
    vscode.commands.registerCommand('tokendex.syncDisable', () =>
      disableSync().catch((error: unknown) => output?.warn(`sync: ${String(error)}`)),
    ),
    // A new GitHub sign-in (or a sign-out) changes the credential the worker holds.
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github') void configureWorkerSync()
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tokendex.refreshInterval')) scheduleTimer()
      if (e.affectsConfiguration('tokendex.devMode')) {
        syncBundleWatcher(context)
        // The Dev tab exists only in a panel state built with devMode on, so the panel has to be
        // rebuilt for the toggle to show. Without this it appears at the next timer tick, up to
        // two minutes later, and the setting reads as having done nothing.
        if (anySurfaceOpen()) void handlePanelRequest({ kind: 'refresh' })
      }
    }),
  )

  view = new GameViewProvider(context.extensionUri, dispatchPanelRequest)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, {
      // The state is small and replayed on `ready`, so holding the webview alive while the
      // sidebar shows something else buys nothing. Measured lesson from the original: an
      // always-live animated surface was the biggest idle cost there.
      webviewOptions: { retainContextWhenHidden: false },
    }),
    // The compact companion card is registered in its three possible homes — the Explorer,
    // the Tokendex sidebar and the panel area — and `tokendex.companionLocation` decides
    // which one is visible (the views' `when` clauses read the setting). All of them are the
    // same panel surface: `updateSurfaces` broadcasts to every open one, so they cannot
    // drift.
    ...[AMBIENT_VIEW_ID, 'tokendex.companionBar', 'tokendex.companionPanel'].map((id) =>
      vscode.window.registerWebviewViewProvider(
        id,
        new GameViewProvider(context.extensionUri, dispatchPanelRequest, {
          compact: true,
        }),
        {
          webviewOptions: { retainContextWhenHidden: false },
        },
      ),
    ),
  )

  context.subscriptions.push({ dispose: stopBundleWatcher })
  syncBundleWatcher(context)
  startWorker(context)
  scheduleTimer()
  startDataWatcher()
  context.subscriptions.push({ dispose: stopDataWatcher })
  void refresh(false)
  welcomeOnFirstRun(context)
}

/**
 * A one-time toast anchoring the mental model: the first scan can take seconds on a big
 * corpus, and until it lands the only sign of life is a spinner in a corner of the status
 * bar. Localised through the same tables as the rest of the UI; `globalState` (not the save)
 * carries the flag, so resetting the game does not replay the welcome.
 */
function welcomeOnFirstRun(context: vscode.ExtensionContext): void {
  const key = 'tokendex.welcomed'
  if (context.globalState.get<boolean>(key) === true) return
  void context.globalState.update(key, true)
  const lang = systemDefaultLanguage(vscode.env.language)
  void vscode.window.showInformationMessage(welcomeToast(lang), openPanelLabel(lang)).then((choice) => {
    if (choice !== undefined) void vscode.commands.executeCommand('tokendex.open')
  })
}

/**
 * Bound on the shutdown flush. A flush queued behind a cold scan must never be what keeps a
 * window open, and the cost of losing it is one re-parse on the next launch.
 */
const FLUSH_TIMEOUT_MS = 1_500

export async function deactivate(): Promise<void> {
  stopTimer()
  stopDataWatcher()
  // Two things, in the worker, in one request. The usage cache throttles its writes to once a
  // minute, so without the flush a window closed shortly after a scan that parsed something
  // new discards that work — the cold parse the cache exists to avoid, paid again on the next
  // launch. And the scan lease is handed back, so the next window takes over immediately
  // instead of waiting out the staleness ceiling for a window that closed politely.
  //
  // What stops the flush from *costing* the surviving window its parse (§3.5) is not the
  // ordering here but the gate in the worker: only the window that holds the lease publishes
  // the cache at all, so a closing follower has nothing to overwrite anybody with.
  await Promise.race([requestFlush(), new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))])
  await stopWorker()
}

// MARK: - Cross-window watcher

let dataWatcher: WatchHandle | undefined
/** Whether a watcher is wanted, so a `deactivate` racing the directory creation still wins. */
let dataWatcherWanted = false

/**
 * Watches `ourData()` so another window's catch, purchase or published scan reaches this one
 * in about a second rather than at the next tick — up to two minutes away, or ten.
 *
 * **The timer stays the floor.** `fs.watch` sees nothing when the home directory lives on NFS
 * or SMB and the write happens on the machine that owns the filesystem, so a design that
 * trusted the watcher would stop updating entirely for exactly the users least able to
 * diagnose it. This only closes the gap between ticks; `scheduleTimer` still runs untouched.
 *
 * The handler is a `sync`, never a `refresh`. A refresh ends in `CompanionStore.transact`,
 * which writes on every hold whether anything changed or not — so two watching windows would
 * answer each other's writes for ever at the debounce interval. A `sync` re-reads and
 * recomposes without writing, and the exchange stops after one round.
 */
function startDataWatcher(): void {
  if (dataWatcherWanted) return
  dataWatcherWanted = true
  const directory = ourData()
  // `fs.watch` on a directory that does not exist throws, and the helper swallows that — so
  // starting the watcher *before* awaiting the creation would leave a fresh install with no
  // watcher at all until the next window reload. Detached rather than awaited: nothing on the
  // activation path may wait on the filesystem.
  void fs
    .mkdir(directory, { recursive: true })
    .catch(() => undefined)
    .then(() => {
      if (!dataWatcherWanted) return // the window closed while the directory was being made
      dataWatcher = watchDataDirectory({
        directory,
        onChange: () => {
          void syncFromDisk()
          // Read-only, as the watcher requires: it only hands the worker the switch as it now is.
          void configureWorkerSync()
        },
      })
    })
}

function stopDataWatcher(): void {
  dataWatcherWanted = false
  dataWatcher?.close()
  dataWatcher = undefined
}

/**
 * Answers a change another window made: re-read the save (and, for a follower, the published
 * scan), then repaint.
 *
 * Skipped while a scan is in flight — that scan is about to re-read the same file and repaint
 * anyway, and the dispatcher would only queue this behind it.
 */
async function syncFromDisk(): Promise<void> {
  if (scanInFlight) return
  const response = await requestSync()
  if (!response.ok) {
    output?.warn(`sync failed: ${response.error}`)
    return
  }
  if (!('snapshot' in response)) return
  lastSnapshot = response.snapshot
  render(response.snapshot)
  if (anySurfaceOpen()) void handlePanelRequest({ kind: 'refresh' })
}

// MARK: - Development bundle watcher

let bundleWatcher: FSWatcher | undefined
let bundleDebounce: NodeJS.Timeout | undefined

/**
 * Starts or stops the `dist` watcher to match `tokendex.devMode`.
 *
 * Both directions, and that is the point: the previous version only ever started one, so
 * turning dev mode off left a watcher running against `dist` until the window was reloaded.
 * Called on activation and from the configuration listener, so the setting is the only state
 * that decides whether the watcher exists.
 */
function syncBundleWatcher(context: vscode.ExtensionContext): void {
  if (!devModeOn()) {
    stopBundleWatcher()
    return
  }
  if (bundleWatcher !== undefined) return

  let webviewChanged = false
  let hostChanged = false

  try {
    // With dev mode on, a rebuilt `dist/webview.{js,css}` repaints an open panel by itself: UI
    // work then iterates at esbuild speed with no keystroke and no host restart. The host's own
    // bundles cannot be swapped under a running extension, so those only log a reminder —
    // silently doing nothing is what makes you debug a change that was never loaded.
    bundleWatcher = watch(join(context.extensionPath, 'dist'), (_event, file) => {
      const name = typeof file === 'string' ? file : ''
      if (name === '' || name.endsWith('.map')) return
      if (name.startsWith('webview.')) webviewChanged = true
      else if (name === 'extension.js' || name === 'scanWorker.js') hostChanged = true
      else return

      // One rebuild writes several files; debouncing keeps it to a single repaint.
      if (bundleDebounce !== undefined) clearTimeout(bundleDebounce)
      bundleDebounce = setTimeout(() => {
        if (webviewChanged) {
          reloadSurfaces()
          output?.info('dev: webview reloaded')
        }
        if (hostChanged) {
          output?.warn(
            'dev: dist/extension.js or scanWorker.js changed — "Developer: Restart Extension Host"',
          )
        }
        webviewChanged = false
        hostChanged = false
      }, 150)
    })
  } catch {
    bundleWatcher = undefined // no dist yet, or a filesystem without watch support
  }
}

function stopBundleWatcher(): void {
  if (bundleDebounce !== undefined) clearTimeout(bundleDebounce)
  bundleDebounce = undefined
  bundleWatcher?.close()
  bundleWatcher = undefined
}

// MARK: - Worker

function startWorker(context: vscode.ExtensionContext): void {
  const workerPath = join(context.extensionPath, 'dist', 'scanWorker.js')
  // Every handler below closes over `instance` rather than the module-level `worker`. A
  // restart starts the replacement while the old thread is still winding down, and an exit
  // handler that cleared whatever `worker` happened to hold would null the new one.
  const instance = new Worker(workerPath)
  worker = instance

  instance.on('message', (response: ScanResponse | CelebrateBroadcast | SyncBroadcast) => {
    if ('syncStatus' in response || 'syncGistID' in response || 'syncReport' in response) {
      void onSyncBroadcast(response)
      return
    }
    // Celebrations arrive outside the request/response ids. On a surface on screen they are
    // news the panel draws with the catch's card (plan 08 §7: one way to celebrate); only when
    // none is do they become toasts, each carrying a way into the panel.
    if ('celebrate' in response) {
      if (deliverNews(response.news)) return
      for (const message of response.celebrate) {
        void vscode.window.showInformationMessage(message, response.openLabel).then((choice) => {
          if (choice === response.openLabel) void vscode.commands.executeCommand('tokendex.open')
        })
      }
      return
    }
    const resolve = pending.get(response.id)
    if (resolve === undefined) return
    pending.delete(response.id)
    resolve(response)
  })

  instance.on('error', (error) => {
    output?.error(`worker error: ${error.message}`)
    showError('the worker failed')
    // Reject everything waiting rather than leaving callers hanging forever.
    for (const [id, resolve] of pending) resolve({ id, ok: false, error: error.message })
    pending.clear()
  })

  instance.on('exit', (code) => {
    if (worker === instance) worker = undefined
    // `error` does not always precede an exit; anything still waiting must resolve here or
    // its caller awaits forever and `scanInFlight` would leak set.
    for (const [id, resolve] of pending)
      resolve({ id, ok: false, error: `worker exited with code ${code}` })
    pending.clear()
    if (workerStopping) {
      workerStopping = false
      return
    }
    if (code === 0) return
    output?.error(`worker exited with code ${code}`)
    // A crashed worker used to be permanent — every later request answered "worker
    // unavailable" until the window was reloaded. Restart it, capped so a worker that dies
    // on startup cannot spin: past the cap the warning state stays, which is at least honest.
    const now = Date.now()
    workerRestarts = workerRestarts.filter((t) => now - t < 3_600_000)
    if (workerRestarts.length >= MAX_WORKER_RESTARTS_PER_HOUR || extensionContext === undefined) {
      showError('the worker crashed repeatedly')
      return
    }
    workerRestarts.push(now)
    startWorker(extensionContext)
    void refresh(false)
  })

  // A new worker holds no credential: every start (activation, a crash restart, an import) hands
  // it the current one.
  syncConfigured = undefined
  void configureWorkerSync()
}

function send(build: (id: number) => WorkerRequest): Promise<ScanResponse> {
  const current = worker
  if (current === undefined) {
    return Promise.resolve({ id: 0, ok: false, error: 'worker unavailable' })
  }
  const id = nextRequestID++
  return new Promise<ScanResponse>((resolve) => {
    pending.set(id, resolve)
    current.postMessage(build(id))
  })
}

const requestScan = (): Promise<ScanResponse> =>
  send((id) => ({
    id,
    type: 'scan',
    locale: vscode.env.language,
    // Piggybacked on the request because the worker cannot read configuration. Sticky in the
    // worker, so they also cover the action requests that trigger a scan — and carrying them
    // on the scan too means the Settings picker is populated even when the first panel is
    // built by an action rather than a render.
    encounterToasts: encounterToastsOn(),
    refreshSeconds: refreshSeconds(),
  }))

/**
 * Asks the worker to persist what it still holds and hand back the scan lease. Sent once,
 * from `deactivate`.
 */
const requestFlush = (): Promise<ScanResponse> => send((id) => ({ id, type: 'flush' }))

/** Re-read what another window wrote and recompose, without scanning and without writing. */
const requestSync = (): Promise<ScanResponse> =>
  send((id) => ({ id, type: 'sync', locale: vscode.env.language }))

/** `tokendex.encounterNotifications`: 'rare' (the default — shiny/legendary only) or 'off'. */
function encounterToastsOn(): boolean {
  return vscode.workspace.getConfiguration('tokendex').get<string>('encounterNotifications') !== 'off'
}

/**
 * Whether the development surface (the panel's Dev tab, the scenario menu, the `dist` watcher)
 * is available.
 *
 * On unless this is a released build: an Extension Development Host is, by definition, a place
 * where you want the test controls, and asking every developer to flip a setting after every
 * fresh profile is friction with no upside. `ExtensionMode` is VS Code's own signal for that, so
 * nothing here depends on a build flag we would have to remember to set.
 *
 * An explicit setting always wins, in both directions — that is how a packaged install turns it
 * on, and how you turn it off inside a dev host to see what a user sees.
 */
function devModeOn(): boolean {
  const inspected = vscode.workspace.getConfiguration('tokendex').inspect<boolean>('devMode')
  const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue
  if (explicit !== undefined) return explicit
  return extensionMode !== vscode.ExtensionMode.Production
}

const requestPanel = (): Promise<ScanResponse> =>
  send((id) => ({ id, type: 'panel', locale: vscode.env.language, devMode: devModeOn() }))

/**
 * Rebuilds the panel from the scan that already ran, instead of scanning again.
 *
 * This is what every panel repaint wants. A `panel` request re-scans, so with a surface open the
 * old code paid for the whole scan twice per tick — once for the status bar, once for the page —
 * and reopening the sidebar cost a full scan before it drew anything. The worker falls back to a
 * real scan when it has nothing to re-render, so a first open is still correct.
 */
const requestRender = (): Promise<ScanResponse> =>
  send((id) => ({
    id,
    type: 'render',
    locale: vscode.env.language,
    devMode: devModeOn(),
    refreshSeconds: refreshSeconds(),
  }))

/**
 * `fromLastScan` skips the disk pass after the action — set for the game actions whose reply an
 * animation is waiting on (a ball throw). The usage half genuinely did not change in those.
 */
const requestAction = (payload: WorkerAction, fromLastScan = false): Promise<ScanResponse> =>
  send((id) => ({
    id,
    type: 'action',
    locale: vscode.env.language,
    devMode: devModeOn(),
    payload,
    fromLastScan,
  }))

/**
 * Translates an opaque panel id back into a typed action. Unknown ids are ignored rather than
 * trusted: the webview is a separate bundle and could be stale after an update.
 *
 * The quantity segment (`item:pokeBall:30`) is accepted only when it names a pack quantity the
 * shop sells (`parsePackQuantity`: ×10 … ×100) — any other number is a stale or hand-crafted id
 * and fails closed, so the bundle discount can never be claimed for an arbitrary count.
 */
function parseEntryID(id: string): WorkerAction | undefined {
  const [kind, value, quantityRaw] = id.split(':')
  if (kind === 'item') {
    const item = ITEM_KINDS.find((i) => i === value)
    if (item === undefined) return undefined
    if (quantityRaw === undefined) return { action: 'buyItem', item }
    const quantity = parsePackQuantity(quantityRaw)
    if (quantity === undefined || !itemIsBundled(item)) return undefined
    return { action: 'buyItem', item, quantity }
  }
  if (kind === 'egg') {
    const tiers: Rarity[] = ['common', 'uncommon', 'rare', 'legendary']
    const tier = tiers.find((t) => t === value)
    return tier === undefined ? { action: 'buyEgg' } : { action: 'buyEgg', tier }
  }
  return undefined
}

/**
 * The single entry point for everything a surface asks for.
 *
 * Nothing here may reject silently: these run detached from any await, so an unhandled
 * rejection would leave the user with a button that does nothing and a log that says nothing.
 */
function dispatchPanelRequest(request: PanelRequestKind): void {
  void handlePanelRequest(request).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error)
    output?.error(`panel request "${request.kind}" failed: ${detail}`)
    void vscode.window.showErrorMessage(`Tokendex: ${detail}`)
  })
}

/**
 * The panel requests that ask the worker to *change* the save, as opposed to re-render it.
 * A failure in one of these has to reach the user; a failed re-render only reaches the log.
 */
const CHANGING_REQUESTS: ReadonlySet<PanelRequestKind['kind']> = new Set([
  'buy',
  'use',
  'setLanguage',
  'throw',
  'feed',
  'collect',
  'collectAll',
  'track',
  'run',
  'setTrainer',
  'setKeepCompleted',
  'boostShiny',
  'setLure',
  'setCompanion',
  'chooseStarter',
  'incubateEgg',
])

/** Ids echoed back by the webview are opaque, but a bounded string is the least they must be. */
const isSpeciesID = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ANIMATED_SPECIES_MAX

function isOpaqueID(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80
}

async function handlePanelRequest(request: PanelRequestKind): Promise<void> {
  let response: ScanResponse
  switch (request.kind) {
    case 'dexEntry': {
      // Read-only, and for the asking card alone: no panel state, no broadcast.
      if (!isSpeciesID(request.speciesID)) return
      const answer = await send((id) => ({ id, type: 'dexEntry', speciesID: request.speciesID }))
      if (answer.ok && 'dexEntry' in answer) request.reply(answer.dexEntry)
      return
    }
    case 'refresh':
      // Rebuilt from the last scan: this path runs on every `ready` handshake, every time the
      // sidebar becomes visible again and after every action, and none of those need fresh I/O.
      response = await requestRender()
      break

    case 'buy': {
      const action = parseEntryID(request.id)
      if (action === undefined) return
      // Confirmed with a native modal rather than inside the webview: this spends real
      // progress, and a modal cannot be dismissed by a stray click on the page. The button's
      // word travels with the message because the host does not know the game's language —
      // display-only text in a modal the user still has to approve, so a stale webview can at
      // worst mislabel a button, and the length cap keeps a hostile one from filling the modal.
      // Whether to ask at all is the core's call on the parsed action, never the webview's: a
      // single ball or berry goes straight through, everything harder to take back still asks.
      const entry =
        action.action === 'buyItem'
          ? {
              kind: 'item' as const,
              item: action.item,
              ...(action.quantity === undefined ? {} : { quantity: action.quantity }),
            }
          : action.action === 'buyEgg'
            ? { kind: 'egg' as const, tier: action.tier }
            : undefined
      if (entry === undefined || purchaseNeedsConfirmation(entry)) {
        const confirmLabel = (request.confirmLabel ?? 'Buy').slice(0, 30) || 'Buy'
        const confirm = await vscode.window.showWarningMessage(
          `${request.title} — ${request.priceText}`,
          { modal: true },
          confirmLabel,
        )
        if (confirm !== confirmLabel) return
      }
      response = await requestAction(action)
      break
    }

    case 'use': {
      const parsed = parseEntryID(request.id)
      if (parsed === undefined || parsed.action !== 'buyItem') return
      response = await requestAction({ action: 'useItem', item: parsed.item })
      break
    }

    case 'setLanguage': {
      const languages: AppLanguage[] = ['ko', 'en', 'ja', 'es']
      const language = languages.find((l) => l === request.language)
      if (language === undefined) return
      response = await requestAction({ action: 'setLanguage', language })
      break
    }

    case 'throw': {
      // The ball slug comes from the webview and is validated here, not trusted: an unknown
      // one would otherwise reach the store as an inventory key.
      const ball = BALL_KINDS.find((b) => b === request.ball)
      if (ball === undefined) return
      // `fromLastScan`: the animation is airborne and waiting on this reply.
      response = await requestAction(
        { action: 'throwBall', encounterID: request.encounterID, ball },
        true,
      )
      break
    }

    case 'feed': {
      // Same rule as the ball: the slug is checked here, never trusted into the inventory.
      if (!isBerryKind(request.berry) || !isOpaqueID(request.encounterID)) return
      response = await requestAction(
        { action: 'feedBerry', encounterID: request.encounterID, berry: request.berry },
        true,
      )
      break
    }

    case 'collect': {
      if (!isOpaqueID(request.findID)) return
      response = await requestAction({ action: 'collectFind', findID: request.findID }, true)
      break
    }

    case 'collectAll':
      response = await requestAction({ action: 'collectAllFinds' }, true)
      break

    case 'track': {
      if (!isOpaqueID(request.trailID)) return
      // Spends tokens, so it is confirmed natively like a purchase — same capped, display-only copy.
      const confirmLabel = (request.confirmLabel ?? 'Track').slice(0, 30) || 'Track'
      const confirm = await vscode.window.showWarningMessage(
        `${request.title.slice(0, 160)} — ${request.priceText.slice(0, 30)}`,
        { modal: true },
        confirmLabel,
      )
      if (confirm !== confirmLabel) return
      response = await requestAction({ action: 'trackLegendary', trailID: request.trailID })
      break
    }

    case 'run': {
      // The core marks the encounters that hurt to lose (rare, legendary, shiny) with a
      // pre-localised confirmation; a common stays one click. Display-only text from the
      // webview, length-capped like the buy label.
      if (request.confirmText !== undefined) {
        const label = (request.confirmLabel ?? 'Run').slice(0, 30) || 'Run'
        const choice = await vscode.window.showWarningMessage(
          request.confirmText.slice(0, 160),
          { modal: true },
          label,
        )
        if (choice !== label) return
      }
      response = await requestAction({ action: 'runFrom', encounterID: request.encounterID }, true)
      break
    }

    case 'setTrainer': {
      if (!isTrainerID(request.trainerID)) return
      response = await requestAction({ action: 'setTrainer', trainerID: request.trainerID }, true)
      break
    }

    case 'setKeepCompleted': {
      if (typeof request.keep !== 'boolean') return
      response = await requestAction({ action: 'setKeepCompleted', keep: request.keep }, true)
      break
    }

    // A purchase like any other: a native modal labelled with the core's text (length-capped),
    // and the worker re-checks in the hold that charges it.
    case 'setLure': {
      if (!isSpeciesID(request.speciesID)) return
      const confirmLabel = (request.confirmLabel ?? 'Buy').slice(0, 30) || 'Buy'
      const confirm = await vscode.window.showWarningMessage(
        `${String(request.title).slice(0, 120)} — ${String(request.priceText).slice(0, 20)}`,
        { modal: true },
        confirmLabel,
      )
      if (confirm !== confirmLabel) return
      response = await requestAction({ action: 'setLure', speciesID: request.speciesID }, true)
      break
    }

    // Spends the wallet, so it asks like a purchase: a native modal the user approves, labelled
    // with the core's text (length-capped, as `buy` does). The amount is only shape-checked here;
    // the worker re-checks it against the room in the same hold that charges it.
    case 'boostShiny': {
      if (!isSpeciesID(request.speciesID)) return
      if (!Number.isSafeInteger(request.amount) || request.amount <= 0) return
      const confirmLabel = (request.confirmLabel ?? 'Buy').slice(0, 30) || 'Buy'
      const confirm = await vscode.window.showWarningMessage(
        `${String(request.title).slice(0, 80)} — ${String(request.priceText).slice(0, 20)}`,
        { modal: true },
        confirmLabel,
      )
      if (confirm !== confirmLabel) return
      response = await requestAction(
        { action: 'boostShiny', speciesID: request.speciesID, amount: request.amount },
        true,
      )
      break
    }

    // A species id, not an opaque string: an integer inside the Pokédex, or nothing happens.
    case 'setCompanion':
    case 'chooseStarter': {
      if (!isSpeciesID(request.speciesID)) return
      response = await requestAction({ action: request.kind, speciesID: request.speciesID }, true)
      break
    }

    case 'incubateEgg': {
      response = await requestAction({ action: 'incubateEgg' }, true)
      break
    }

    case 'setRefreshInterval': {
      if (!REFRESH_PRESETS.includes(request.seconds)) return
      await vscode.workspace
        .getConfiguration('tokendex')
        .update('refreshInterval', request.seconds, vscode.ConfigurationTarget.Global)
      // The config listener reschedules the timer; this rebuild is what makes the picker in the
      // panel reflect the new value immediately.
      response = await requestRender()
      break
    }

    case 'openPanel':
      // The compact card asking to be taken to the real thing. `tokendex.open` focuses the
      // sidebar view, which is also what the status bar item does.
      await vscode.commands.executeCommand('tokendex.open')
      return

    case 'dev':
      await runDevControl(request.id, request.value)
      return

    case 'exportSave':
      await exportSave()
      return

    case 'importSave':
      await importSave()
      return
  }

  if (!response.ok) {
    output?.error(`panel action failed: ${response.error}`)
    // Shown, not only logged — this is the end of the road for a user action that did not
    // commit, a purchase the save's lock refused above all (`docs/multi-window.md` §5(d)).
    // Logging it alone left the panel re-rendering the old state, which is precisely the "it
    // looked like it worked" outcome the contention policy exists to prevent. The worker has
    // already localised the text; the host must not compose one of its own.
    //
    // Only for the kinds that *changed* something. A failed re-render is a background
    // refresh: it retries on the next tick, and an error toast every two minutes would train
    // the user to dismiss the one that matters.
    if (CHANGING_REQUESTS.has(request.kind)) void vscode.window.showErrorMessage(response.error)
    return
  }
  if ('panel' in response) {
    updateSurfaces(response.panel)
    // The outcome follows the state on purpose: the webview defers applying the new state
    // until the animation this outcome drives has landed.
    if ('extra' in response && response.extra !== undefined) broadcastThrow(response.extra)
    // The status bar and its tooltip are built at scan time, so after a state-changing action
    // (a catch bumps the dex count, a purchase moves the balance) they are up to two minutes
    // stale. A background refresh closes that gap; `scanInFlight` already coalesces it with
    // any timer scan running. Pure re-renders skip it — nothing changed.
    if (request.kind !== 'refresh') void refresh(false)
  }
}

/**
 * Runs one control from the panel's Dev tab.
 *
 * The id is resolved against the scenario table rather than trusted: the webview is a separate
 * bundle, so a stale one must fail closed instead of dispatching something that no longer exists.
 * Anything destructive is confirmed with a native modal, which a stray click on the page cannot
 * dismiss.
 */
async function runDevControl(id: string, value: string | undefined): Promise<void> {
  if (!devModeOn()) return
  const scenario = devScenarioByID(id)
  if (scenario === undefined) {
    output?.warn(`dev: unknown scenario "${id}" (stale webview?)`)
    return
  }

  if (scenario.confirm !== undefined) {
    const confirmed = await vscode.window.showWarningMessage(
      scenario.label,
      { modal: true, detail: scenario.confirm },
      'Run',
    )
    if (confirmed !== 'Run') return
  }

  const action = scenario.build(value ?? '')
  if (action === undefined) {
    void vscode.window.showWarningMessage(
      `Tokendex: "${value ?? ''}" is not a valid amount. Use 1500, 250M or 1.5B.`,
    )
    return
  }

  const steps = scenario.steps ?? 1
  for (let step = 0; step < steps; step++) {
    const response = await requestAction(action)
    if (!response.ok) {
      output?.error(`dev: ${scenario.id} failed — ${response.error}`)
      void vscode.window.showErrorMessage(`Simulation failed: ${response.error}`)
      return
    }
    if ('panel' in response) updateSurfaces(response.panel)
    output?.info(`dev: ${scenario.id} (${step + 1}/${steps})`)
    // A short gap so a multi-step scenario reads as progress rather than one jump.
    if (step < steps - 1) await new Promise((resolve) => setTimeout(resolve, 450))
  }
  await refresh(true)
}

/** Where this machine keeps the companion state the worker reads and writes. */
function savePath(): string {
  return join(ourData(), 'companion-state.json')
}

/** The game's language, read from this machine's save: what the player chose here. */
async function gameLanguage(): Promise<AppLanguage> {
  return (
    parseCompanionState(await fs.readFile(savePath(), 'utf8').catch(() => '')) ??
    freshCompanionState(vscode.env.language)
  ).language
}

// MARK: - Cross-device sync

/**
 * Whether sync is on for this machine (`docs/sync.md`), and apart from it the gist in use.
 *
 * In `ourData()` rather than `globalState`, because every window and profile on the machine shares
 * that directory, the save and the device id — they are one device, and the scan lease holder,
 * whichever window it is, must see the same switch. Two files, because two writers set them: the
 * switch is the player's, the gist id the worker's broadcast. One file read-modified-written by
 * both lost whichever write landed first. The gist id is not the credential: the token comes from
 * VS Code's GitHub sign-in and is never written anywhere by this extension.
 */
const syncSwitchPath = (): string => join(ourData(), 'sync.json')
const syncGistPath = (): string => join(ourData(), 'sync-gist.json')

async function readJSONField(path: string, field: string): Promise<unknown> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[field] : undefined
  } catch {
    return undefined
  }
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await fs.mkdir(ourData(), { recursive: true })
  await atomicWriteFile(path, JSON.stringify(value), 'utf8')
}

const syncEnabled = async (): Promise<boolean> =>
  (await readJSONField(syncSwitchPath(), 'enabled')) === true
const setSyncEnabled = (enabled: boolean): Promise<void> => writeJSON(syncSwitchPath(), { enabled })
async function syncGistID(): Promise<string | undefined> {
  const id = await readJSONField(syncGistPath(), 'gistID')
  return typeof id === 'string' ? id : undefined
}

/**
 * The GitHub session with the `gist` scope. `silent` never asks; `ask` signs in if there is no
 * session; `renew` asks for a new one even if there is — what a refused credential needs, since
 * `ask` would hand back the very session GitHub just refused.
 */
async function githubSession(
  mode: 'silent' | 'ask' | 'renew',
): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession(
      'github',
      ['gist'],
      mode === 'silent'
        ? { silent: true }
        : mode === 'ask'
          ? { createIfNone: true }
          : { forceNewSession: true },
    )
  } catch (error) {
    output?.warn(`sync: GitHub sign-in failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** What the worker was last configured with, so a refresh tick only re-sends on a change. */
let syncConfigured: string | undefined
/**
 * Set across `enableSync`. The switch is not written until its first round succeeds, so a refresh
 * tick in between would read "off" and turn off the very engine the flow is using.
 */
let syncEnabling = false
/** "Turn off" while `enableSync` runs: the flow must not write the switch on afterwards. */
let syncEnableCancelled = false

/**
 * Hands the worker the current credential, or turns sync off in it. Idempotent: called on every
 * worker start, every refresh tick (another window may have flipped the switch) and every
 * sign-in change, and only sends when the credential or the switch differs — not the gist id,
 * which the worker's transport already follows.
 */
async function configureWorkerSync(
  options: { paused?: boolean; fromEnable?: boolean } = {},
): Promise<boolean> {
  if (syncEnabling && options.paused !== true && options.fromEnable !== true) return false
  // `paused` is the enable flow, before the switch is written: it configures regardless.
  const wanted = (await syncEnabled()) || options.paused === true
  const session = wanted ? await githubSession('silent') : undefined
  const key = session === undefined ? 'off' : `${session.id}:${session.accessToken}`
  if (key === syncConfigured && options.paused !== true) return session !== undefined
  if (wanted && session === undefined)
    output?.warn('sync: on, but there is no GitHub session with the gist scope')
  const gistID = await syncGistID()
  const answer = await send((id) => ({
    id,
    type: 'syncConfigure',
    appVersion: version(),
    ...(session === undefined ? {} : { token: session.accessToken }),
    ...(gistID === undefined ? {} : { gistID }),
    ...(options.paused === true ? { paused: true } : {}),
  }))
  if (answer.ok) {
    syncConfigured = key
    // A credential handed over is a fresh start: a later refusal deserves its own prompt.
    if (session !== undefined) syncAuthPrompted = false
  }
  return answer.ok && session !== undefined
}

/** "Sync now": the first time, it is turning sync on; after that, one round. */
async function syncNowCommand(): Promise<void> {
  if (!(await syncEnabled())) return enableSync()
  await runSyncRound({ context: 'manual' })
}

/**
 * Turning sync on, on this machine: consent naming what leaves it, a GitHub sign-in, and — when
 * this machine and another both have a game — the question of which companion continues.
 *
 * The worker is configured `paused`, so nothing syncs on its own before that answer, and the
 * switch is written only once the first round has gone through with it. Written earlier, a
 * failed first round would leave sync on with the question unanswered, and the next start would
 * settle the fork by the rule.
 */
async function enableSync(): Promise<void> {
  if (syncEnabling) return
  syncEnabling = true
  syncEnableCancelled = false
  try {
    await enableSyncFlow()
  } finally {
    syncEnabling = false
  }
}

async function enableSyncFlow(): Promise<void> {
  const lang = await gameLanguage()
  const consent = await vscode.window.showInformationMessage(
    syncConsentText(lang),
    { modal: true, detail: syncConsentDetail(lang) },
    syncEnableLabel(lang),
  )
  if (consent === undefined) return
  if ((await githubSession('ask')) === undefined) return

  if (!(await configureWorkerSync({ paused: true }))) {
    void vscode.window.showWarningMessage(syncNotTurnedOnText(lang))
    await configureWorkerSync({ fromEnable: true })
    return
  }

  const peek = await send((id) => ({ id, type: 'syncPeek' }))
  if (!peek.ok) {
    output?.warn(`sync: could not read the gist: ${peek.error}`)
    void vscode.window.showWarningMessage(syncNotTurnedOnText(lang))
    await configureWorkerSync({ fromEnable: true })
    return
  }
  const preview = 'sync' in peek ? peek.sync.preview : undefined
  // The question names a peer that would fork; joining with nothing of our own, the one with the
  // most progress.
  const peer =
    preview?.forkPeer ??
    [...(preview?.peers ?? [])].sort((a, b) => b.summary.lifetimeTokens - a.summary.lifetimeTokens)[0]
  let fork: { onFork: 'local' | 'remote'; forkPeer: string } | undefined
  if (preview !== undefined && peer !== undefined) {
    if (preview.wouldFork) {
      const keepLocal = syncKeepLocalLabel(lang)
      const keepRemote = syncKeepRemoteLabel(lang, peer.label)
      const choice = await vscode.window.showWarningMessage(
        syncChoiceText(
          lang,
          { dexCount: preview.local.dexCount, tokens: preview.local.lifetimeTokens },
          { label: peer.label, dexCount: peer.summary.dexCount, tokens: peer.summary.lifetimeTokens },
        ),
        { modal: true, detail: syncChoiceDetail(lang) },
        keepLocal,
        keepRemote,
      )
      if (choice === undefined) {
        // Asked and not answered: sync stays off rather than deciding for the player.
        await configureWorkerSync({ fromEnable: true })
        return
      }
      fork = { onFork: choice === keepLocal ? 'local' : 'remote', forkPeer: peer.deviceID }
    } else if (!preview.hasOwnGame) {
      // Nothing of its own to lose — an egg, an empty Pokédex — so this machine joins the game that
      // exists. Left to the rule, a new machine that scanned a lot could win and replace it.
      fork = { onFork: 'remote', forkPeer: peer.deviceID }
    }
  }
  if ((await runSyncRound({ context: 'enable', ...fork })) && !syncEnableCancelled) {
    await setSyncEnabled(true)
  }
  // Either way the worker follows the switch: on and running, or off again.
  syncConfigured = undefined
  await configureWorkerSync({ fromEnable: true })
}

/**
 * One round, now. A failure is said for what it is: in the enable flow sync stays off, so "it will
 * retry" would be untrue; with sync on, the runner does retry a network failure, and a refused or
 * missing credential needs a sign-in.
 */
async function runSyncRound(round: {
  context: 'enable' | 'manual'
  onFork?: 'local' | 'remote'
  forkPeer?: string
}): Promise<boolean> {
  const answer = await send((id) => ({
    id,
    type: 'syncNow',
    ...(round.onFork === undefined ? {} : { onFork: round.onFork }),
    ...(round.forkPeer === undefined ? {} : { forkPeer: round.forkPeer }),
  }))
  const lang = await gameLanguage()
  if (!answer.ok) {
    output?.warn(`sync: round failed (${answer.reason ?? 'unknown'}): ${answer.error}`)
    // A refused credential is said by the sign-in prompt: the round's error status reached
    // `onSyncBroadcast` before this answer. Only when that prompt is already open or was already
    // shown for this credential does a manual round say it here — with the way to sign in.
    if (answer.reason === 'auth' && round.context === 'manual') {
      void promptSignIn(Promise.resolve(lang))
      return false
    }
    void vscode.window.showWarningMessage(
      round.context === 'enable'
        ? syncNotTurnedOnText(lang)
        : syncFailedText(lang, answer.reason ?? 'unknown'),
    )
    return false
  }
  const report = 'sync' in answer ? answer.sync.report : undefined
  if (report !== undefined) {
    void vscode.window.showInformationMessage(syncDoneText(lang, report.dexAdded, report.peers.length))
  }
  return true
}

async function disableSync(): Promise<void> {
  // Mid-enable, the configure below is skipped and the flow would write the switch on after it.
  if (syncEnabling) syncEnableCancelled = true
  await setSyncEnabled(false)
  await configureWorkerSync()
  void vscode.window.showInformationMessage(syncDisabledText(await gameLanguage()))
}

/** Said once per credential (reset when a new one is handed over) and once per window. */
let syncAuthPrompted = false
/** The sign-in prompt is on screen: nothing else needs to say the credential was refused. */
let syncAuthPromptOpen = false
let syncNewerPeerWarned = false

/**
 * "GitHub refused the credential", with the way to sign in again. One on screen at a time, and
 * marked open before anything is awaited: the error status arrives just ahead of the round's own
 * answer, and the answer must already see the prompt as open.
 */
async function promptSignIn(language: Promise<AppLanguage>): Promise<void> {
  if (syncAuthPromptOpen) return
  syncAuthPromptOpen = true
  try {
    const lang = await language
    const signIn = syncSignInLabel(lang)
    const choice = await vscode.window.showWarningMessage(syncFailedText(lang, 'auth'), signIn)
    if (choice === signIn && (await githubSession('renew')) !== undefined) {
      syncConfigured = undefined
      await configureWorkerSync()
    }
  } finally {
    syncAuthPromptOpen = false
  }
}

async function onSyncBroadcast(message: SyncBroadcast): Promise<void> {
  if ('syncGistID' in message) {
    await writeJSON(syncGistPath(), { gistID: message.syncGistID }).catch(() => undefined)
    return
  }
  if ('syncStatus' in message) {
    const status = message.syncStatus
    if (status.phase !== 'error') return
    output?.warn(`sync: ${status.lastError ?? 'unknown'}: ${status.errorMessage ?? ''}`)
    if (status.lastError !== 'auth' || syncAuthPrompted) return
    syncAuthPrompted = true
    await promptSignIn(gameLanguage())
    return
  }
  const report = message.syncReport
  output?.info(
    `sync: ${report.peers.length} other device(s), pushed=${report.pushed}, dex+${report.dexAdded}` +
      (report.continuedFrom === undefined ? '' : `, continued from ${report.continuedFrom}`),
  )
  // The save is read for its language only when there is something to say.
  if (report.continuedFrom !== undefined) {
    void vscode.window.showInformationMessage(
      syncContinuedFromText(await gameLanguage(), report.continuedFrom),
    )
  }
  if (report.newerPeer && !syncNewerPeerWarned) {
    syncNewerPeerWarned = true
    void vscode.window.showWarningMessage(syncNewerPeerText(await gameLanguage()))
  }
}

/**
 * This machine's usage as the ledger sees it, taken from the last completed scan.
 *
 * Built from the same helper the worker feeds the ledger from, so an import anchors its
 * baseline against exactly the providers a scan would credit. With no scan yet (`undefined`),
 * `hasUsageData: false` hands the baseline decision back to the fresh-install path, which is
 * the correct answer rather than a guess.
 */
function ledgerObservation(): {
  todayTokensByProvider: Record<string, number>
  todayDate: string
  hasUsageData: boolean
} {
  return {
    todayTokensByProvider:
      lastSnapshot === undefined ? {} : todayTokensByProvider(lastSnapshot.providers),
    todayDate: todayKey(Date.now()),
    hasUsageData: lastSnapshot !== undefined,
  }
}

/**
 * Copies the save file to a location the user picks.
 *
 * The file is read from disk rather than re-serialised from memory: the worker owns the
 * state, and a second serialisation path here would be a second format to keep in step.
 */
async function exportSave(): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(savePath(), 'utf8')
  } catch {
    void vscode.window.showWarningMessage('There is no save to export yet.')
    return
  }
  // Parsed before the dialog: asking where to put a file we cannot produce wastes the user's
  // time, and a corrupt save must say so rather than throwing into a detached promise.
  const state = parseCompanionState(raw)
  if (state === undefined) {
    output?.error('export failed: the save file could not be parsed')
    void vscode.window.showErrorMessage('Your save file could not be read, so it was not exported.')
    return
  }

  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Export',
    defaultUri: vscode.Uri.file(join(homedir(), suggestedFileName(Date.now()))),
    filters: { JSON: ['json'] },
  })
  if (target === undefined) return

  try {
    // The device label, never `hostname()`: a hostname often carries its owner's real name, and
    // this file is made to be handed to someone else's machine.
    const { label } = await deviceIdentity(ourData())
    const envelope = encodeSave(sanitized(state), version(), label, Date.now())
    await fs.writeFile(target.fsPath, envelope, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    output?.error(`export failed: ${detail}`)
    void vscode.window.showErrorMessage(`The save could not be written: ${detail}`)
    return
  }
  void vscode.window.showInformationMessage(`Save exported to ${target.fsPath}`)
}

/**
 * Replaces this machine's save with an imported one.
 *
 * Three things have to hold, and each one has bitten:
 *
 *  - **The worker is stopped before the file is touched.** It holds the state in memory and
 *    persists it at the end of every scan, so a scan finishing mid-import writes the
 *    pre-import state straight back over the file — and the user is told the import worked.
 *  - **The previous state is backed up**, and the import is abandoned if that backup cannot
 *    be written: the confirmation promises the old progress survives.
 *  - **The imported state is rebased onto this machine.** A save carries the *other* machine's
 *    daily ledger; taking it verbatim credits this machine's whole day in one go at the next
 *    scan, and hands the local UI the exporting machine's language.
 */
async function importSave(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Import',
    filters: { JSON: ['json'] },
  })
  const source = picked?.[0]
  if (source === undefined) return

  let envelope: SaveEnvelope
  try {
    envelope = decodeSave(await fs.readFile(source.fsPath, 'utf8'), vscode.env.language)
  } catch (error) {
    const detail = error instanceof SaveTransferFailure ? error.detail : undefined
    void vscode.window.showErrorMessage(
      detail?.kind === 'newerSchema'
        ? 'That save comes from a newer version. Update the extension.'
        : detail?.kind === 'fileTooLarge'
          ? 'That file is too large to be a save.'
          : 'That file is not a Tokendex save.',
    )
    return
  }

  const summary = summarize(envelope.state)
  // The copy is the core's, in the game's language — read from this machine's save, which is the
  // language the player chose here (an imported save never changes it).
  const lang = await gameLanguage()
  const mergeLabel = importMergeLabel(lang)
  const replaceLabel = importReplaceLabel(lang)
  const answer = await vscode.window.showWarningMessage(
    importSourceText(lang, envelope.sourceDevice, envelope.exportedAt, summary.dexCount),
    { modal: true, detail: importChoiceDetail(lang) },
    mergeLabel,
    replaceLabel,
  )
  if (answer !== mergeLabel && answer !== replaceLabel) return
  const choice = answer === mergeLabel ? 'Merge' : 'Replace'
  const device = await deviceIdentity(ourData())
  let mergeReport: ReturnType<typeof mergeSaves> | undefined

  // Everything below owns the save file exclusively, which is why the worker goes first.
  await stopWorker()
  try {
    const target = savePath()
    // The same lock every `CompanionStore` write takes. Stopping this window's worker was
    // never enough — the comment above describes exactly the bug another window reproduces,
    // verbatim, complete with the "Save imported." confirmation. The lock makes the
    // backup-and-replace one transaction; what makes it *stick* is that every other window's
    // next write re-reads this file before folding anything into it.
    const lock = new FileLock({ path: lockPathFor(target) })
    const done = await lock.withLock(async () => {
      let previous: string | undefined
      try {
        previous = await fs.readFile(target, 'utf8')
      } catch (error) {
        // No save yet is fine; anything else means we cannot promise a way back.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }

      if (previous !== undefined) {
        await fs.mkdir(ourData(), { recursive: true })
        await fs.writeFile(join(ourData(), backupFileName(Date.now())), previous, 'utf8')
      }

      const current = parseCompanionState(previous ?? '') ?? freshCompanionState(vscode.env.language)
      let rebased
      if (choice === 'Merge') {
        mergeReport = mergeSaves(current, envelope.state)
        // A merge is a change made here, so this device's counter moves: the other machine then
        // sees a save that contains its own history and adopts it rather than forking again.
        rebased = withRevision(mergeReport.state, device.id)
      } else {
        rebased = rebasedForThisDevice(envelope.state, current, ledgerObservation())
      }

      // The live save, so it goes through the shared atomic helper like every other writer of
      // it: this window stops its own worker first, but every *other* window's is still running.
      await atomicWriteFile(target, JSON.stringify(rebased), 'utf8')
      await pruneBackups(ourData())
    })
    // A user action, so contention fails visibly: replacing someone's whole save is the last
    // thing that may quietly not happen.
    if (!done.acquired) throw new Error('another window is writing the save')
    void vscode.window.showInformationMessage(
      mergeReport === undefined
        ? importedText(lang)
        : mergedText(lang, mergeReport.dexAdded, mergeReport.narrative),
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    output?.error(`import failed: ${detail}`)
    void vscode.window.showErrorMessage(`Nothing was imported: ${detail}`)
  } finally {
    // Whatever happened above, the window must not be left without a worker.
    await startWorkerAndRefresh()
  }
}

function version(): string {
  return vscode.extensions.getExtension('diegomarty.tokendex')?.packageJSON?.version ?? '0.0.0'
}

/**
 * Stops the worker and waits for it to be gone.
 *
 * Callers that are about to touch a file the worker owns — the save, above all — must await
 * this **before** writing: the worker holds the companion state in memory and persists it at
 * the end of every scan, so a scan finishing mid-import writes the pre-import state straight
 * back over the file the user just chose.
 */
async function stopWorker(): Promise<void> {
  const current = worker
  if (current === undefined) return
  workerStopping = true
  worker = undefined
  await current.terminate()
}

async function startWorkerAndRefresh(): Promise<void> {
  const context = extensionContext
  if (context === undefined) return
  startWorker(context)
  await refresh(true)
  if (anySurfaceOpen()) await handlePanelRequest({ kind: 'refresh' })
}

/**
 * Runs a development scenario and shows the result immediately.
 *
 * Actions are dispatched in order and each one rescans, so a multi-step scenario is visibly
 * animated rather than collapsing into a single jump.
 */
async function runDevScenario(): Promise<void> {
  if (!devModeOn()) {
    const enable = await vscode.window.showWarningMessage('Development mode is off.', 'Turn it on')
    if (enable !== 'Turn it on') return
    // Workspace, never Global: settings are shared between the dev host and the user's real
    // VS Code, so a Global write here leaked the Dev tab into a marketplace install of the
    // extension on the same machine — it looked exactly like a build shipped in dev mode.
    await vscode.workspace
      .getConfiguration('tokendex')
      .update('devMode', true, vscode.ConfigurationTarget.Workspace)
  }

  const actions = await pickScenario()
  if (actions.length === 0) return

  for (const [index, action] of actions.entries()) {
    const response = await requestAction(action)
    if (!response.ok) {
      output?.error(`dev scenario failed: ${response.error}`)
      void vscode.window.showErrorMessage(`Simulation failed: ${response.error}`)
      return
    }
    if ('panel' in response) updateSurfaces(response.panel)
    output?.info(`dev: ${action.action} (${index + 1}/${actions.length})`)
    // A short gap so a multi-step scenario reads as progress rather than one jump.
    if (index < actions.length - 1) await new Promise((r) => setTimeout(r, 450))
  }
  await refresh(true)
  if (anySurfaceOpen()) await handlePanelRequest({ kind: 'refresh' })
}

async function refresh(manual: boolean): Promise<void> {
  // Another window may have turned sync on or off; the lease holder is the one that must know.
  void configureWorkerSync()
  // Never two scans at once: the first cold scan takes ~30 seconds and overlapping them
  // would just multiply the I/O.
  if (scanInFlight) {
    if (manual) output?.info('refresh skipped: a scan is already running')
    return
  }
  scanInFlight = true
  if (manual && statusBar !== undefined) statusBar.text = '$(sync~spin) Tokendex'

  try {
    const started = Date.now()
    const response = await requestScan()
    if (!response.ok) {
      output?.error(`scan failed: ${response.error}`)
      showError(response.error)
      return
    }
    if (!('snapshot' in response)) return // a panel reply, handled by the panel path
    lastSnapshot = response.snapshot
    render(response.snapshot)
    output?.info(`scan finished in ${Date.now() - started} ms`)
    // Keep an open panel in step with the status bar without paying for it when it is closed.
    if (anySurfaceOpen()) void handlePanelRequest({ kind: 'refresh' })
  } finally {
    scanInFlight = false
  }
}

function render(snapshot: UsageSnapshot): void {
  if (statusBar === undefined) return
  // Every property assignment posts across to the renderer, and between two idle scans most
  // of this is unchanged. The gates read the item's own properties back, so the manual
  // refresh spinner and `showError` — which write through the same properties — are seen
  // here and repainted rather than needing to invalidate anything.
  if (statusBar.text !== snapshot.statusText) {
    statusBar.text = snapshot.statusText
    // Codicon markup is meaningless read aloud; the mood it stands for is not.
    statusBar.accessibilityInformation = { label: `Tokendex: ${plainText(snapshot.statusText)}` }
  }

  // The sidebar's title carries the same summary, so the view answers "where am I" without the
  // user having to look at the bottom of the window. The title bar renders plain text only.
  view?.setDescription(plainText(snapshot.statusText))

  // The encounter feature's primary signal: a count on the activity-bar icon, never a toast.
  view?.setBadge(snapshot.companion?.wildCount ?? 0, snapshot.companion?.wildTooltip ?? '')

  const current = statusBar.tooltip
  if (typeof current === 'string' || current?.value !== snapshot.tooltipMarkdown) {
    const tooltip = new vscode.MarkdownString(snapshot.tooltipMarkdown)
    // Command links only render when the Markdown is trusted, and a blanket `isTrusted = true`
    // would enable *any* command a string could name. The allowlist keeps that to the three the
    // core actually writes, so a species name arriving from PokéAPI can never become a link that
    // runs something.
    tooltip.isTrusted = {
      enabledCommands: ['tokendex.refresh', 'tokendex.open', 'tokendex.showOutput'],
    }
    statusBar.tooltip = tooltip
  }

  // Prominent colours are for "do something", so they follow the snapshot's own severity rather
  // than being decided here — a second threshold would drift from the one the tooltip explains.
  const warning = snapshot.severity === 'warning'
  if (warning !== (statusBar.backgroundColor !== undefined)) {
    statusBar.backgroundColor = warning
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined
  }

  if (snapshot.errors.length > 0) {
    output?.warn(`scan with warnings: ${snapshot.errors.join(' · ')}`)
  }
}

/** Drops codicon markup, so `$(zap) 42% · Charizard` reads as `42% · Charizard`. */
function plainText(text: string): string {
  return text.replace(/\$\([a-z0-9-~]+\)\s*/gi, '').trim()
}

/** Failure must be visible in the status bar, never silent. */
function showError(message: string): void {
  if (statusBar === undefined) return
  // Keep the last good numbers on screen when we have them, but mark the state.
  statusBar.text =
    lastSnapshot === undefined ? '$(warning) Tokendex' : `$(warning) ${lastSnapshot.statusText}`
  statusBar.tooltip = `Tokendex: ${message}\nRun "Tokendex: Show log" for detail.`
  statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
}

// MARK: - Timer

function refreshSeconds(): number {
  const configured = vscode.workspace
    .getConfiguration('tokendex')
    .get<number>('refreshInterval', DEFAULT_REFRESH_SECONDS)
  return REFRESH_PRESETS.includes(configured) ? configured : DEFAULT_REFRESH_SECONDS
}

/** Ticks skipped while unfocused before scanning anyway. */
const UNFOCUSED_BACKOFF_TICKS = 3
let ticksSinceScan = 0

function scheduleTimer(): void {
  stopTimer()
  ticksSinceScan = 0
  const seconds = refreshSeconds()
  timer = setInterval(() => {
    ticksSinceScan += 1
    // Back off while the window is unfocused, but never stop: usage accrues regardless, and
    // coming back after a while must not show stale numbers.
    if (!vscode.window.state.focused && ticksSinceScan < UNFOCUSED_BACKOFF_TICKS) return
    ticksSinceScan = 0
    void refresh(false)
  }, seconds * 1000)
}

function stopTimer(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
}
