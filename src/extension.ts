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
import type { UsageSnapshot } from './core/snapshot.js'
import type { ScanResponse, WorkerAction, WorkerRequest } from './worker/scanWorker.js'
import { GamePanel, type PanelRequestKind } from './panel.js'
import { pickScenario } from './dev.js'
import { promises as fs } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { ourData } from './core/appPaths.js'
import { decodeCompanionState } from './core/companion/persistence.js'
import {
  type SaveEnvelope,
  SaveTransferFailure,
  backupFileName,
  decodeSave,
  encodeSave,
  sanitized,
  suggestedFileName,
  summarize,
} from './core/companion/saveTransfer.js'
import type { AppLanguage, ItemKind, Rarity } from './core/companion/model.js'

const DEFAULT_REFRESH_SECONDS = 120
/** Matches `UsageStore.intervalPresets` in the Swift original. */
const REFRESH_PRESETS = [30, 60, 120, 300, 600]

let statusBar: vscode.StatusBarItem | undefined
let worker: Worker | undefined
let timer: NodeJS.Timeout | undefined
let pending: Map<number, (r: ScanResponse) => void> = new Map()
let nextRequestID = 1
let scanInFlight = false
let lastSnapshot: UsageSnapshot | undefined
let output: vscode.LogOutputChannel | undefined
let extensionContext: vscode.ExtensionContext | undefined

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context
  output = vscode.window.createOutputChannel('Tokendex', { log: true })
  context.subscriptions.push(output)

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.name = 'Tokendex'
  statusBar.command = 'tokendex.open'
  statusBar.text = '$(sync~spin) Tokendex'
  statusBar.tooltip = 'Leyendo el uso local…'
  statusBar.show()
  context.subscriptions.push(statusBar)

  context.subscriptions.push(
    vscode.commands.registerCommand('tokendex.refresh', () => void refresh(true)),
    vscode.commands.registerCommand('tokendex.showOutput', () => output?.show()),
    vscode.commands.registerCommand('tokendex.open', () => {
      GamePanel.show(context.extensionUri, (request) => void handlePanelRequest(request))
    }),
    vscode.commands.registerCommand('tokendex.dev', () => void runDevScenario()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tokendex.refreshInterval')) scheduleTimer()
    }),
  )

  startWorker(context)
  scheduleTimer()
  void refresh(false)
}

export function deactivate(): void {
  stopTimer()
  void worker?.terminate()
  worker = undefined
}

// MARK: - Worker

function startWorker(context: vscode.ExtensionContext): void {
  const workerPath = join(context.extensionPath, 'dist', 'scanWorker.js')
  worker = new Worker(workerPath)

  worker.on('message', (response: ScanResponse) => {
    const resolve = pending.get(response.id)
    if (resolve === undefined) return
    pending.delete(response.id)
    resolve(response)
  })

  worker.on('error', (error) => {
    output?.error(`worker error: ${error.message}`)
    showError('el worker falló')
    // Reject everything waiting rather than leaving callers hanging forever.
    for (const [id, resolve] of pending) resolve({ id, ok: false, error: error.message })
    pending.clear()
  })

  worker.on('exit', (code) => {
    if (code !== 0) output?.error(`worker exited with code ${code}`)
    worker = undefined
  })
}

function send(build: (id: number) => WorkerRequest): Promise<ScanResponse> {
  const current = worker
  if (current === undefined) {
    return Promise.resolve({ id: 0, ok: false, error: 'worker no disponible' })
  }
  const id = nextRequestID++
  return new Promise<ScanResponse>((resolve) => {
    pending.set(id, resolve)
    current.postMessage(build(id))
  })
}

const requestScan = (): Promise<ScanResponse> =>
  send((id) => ({ id, type: 'scan', locale: vscode.env.language }))

const requestPanel = (): Promise<ScanResponse> =>
  send((id) => ({ id, type: 'panel', locale: vscode.env.language }))

const requestAction = (payload: WorkerAction): Promise<ScanResponse> =>
  send((id) => ({ id, type: 'action', locale: vscode.env.language, payload }))

/**
 * Translates an opaque panel id back into a typed action. Unknown ids are ignored rather than
 * trusted: the webview is a separate bundle and could be stale after an update.
 */
function parseEntryID(id: string): WorkerAction | undefined {
  const [kind, value] = id.split(':')
  if (kind === 'item') {
    const items: ItemKind[] = ['rareCandy', 'mint', 'shinyCharm']
    const item = items.find((i) => i === value)
    return item === undefined ? undefined : { action: 'buyItem', item }
  }
  if (kind === 'egg') {
    const tiers: Rarity[] = ['common', 'uncommon', 'rare', 'legendary']
    const tier = tiers.find((t) => t === value)
    return tier === undefined ? { action: 'buyEgg' } : { action: 'buyEgg', tier }
  }
  return undefined
}

async function handlePanelRequest(request: PanelRequestKind): Promise<void> {
  let response: ScanResponse
  switch (request.kind) {
    case 'refresh':
      response = await requestPanel()
      break

    case 'buy': {
      const action = parseEntryID(request.id)
      if (action === undefined) return
      // Confirmed with a native modal rather than inside the webview: this spends real
      // progress, and a modal cannot be dismissed by a stray click on the page.
      const confirm = await vscode.window.showWarningMessage(
        `${request.title} — ${request.priceText}`,
        { modal: true },
        'Comprar',
      )
      if (confirm !== 'Comprar') return
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

    case 'exportSave':
      await exportSave()
      return

    case 'importSave':
      await importSave()
      return
  }

  if (!response.ok) {
    output?.error(`acción del panel fallida: ${response.error}`)
    return
  }
  if ('panel' in response) GamePanel.update(response.panel)
}

/**
 * Copies the save file to a location the user picks.
 *
 * The file is read from disk rather than re-serialised from memory: the worker owns the
 * state, and a second serialisation path here would be a second format to keep in step.
 */
async function exportSave(): Promise<void> {
  const source = join(ourData(), 'companion-state.json')
  let raw: Buffer
  try {
    raw = await fs.readFile(source)
  } catch {
    void vscode.window.showWarningMessage('Todavía no hay partida que exportar.')
    return
  }

  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Exportar',
    defaultUri: vscode.Uri.file(join(homedir(), suggestedFileName(Date.now()))),
    filters: { JSON: ['json'] },
  })
  if (target === undefined) return

  const envelope = encodeSave(
    sanitized(decodeCompanionState(JSON.parse(raw.toString('utf8')) as unknown)),
    version(),
    hostname(),
    Date.now(),
  )
  await fs.writeFile(target.fsPath, envelope, 'utf8')
  void vscode.window.showInformationMessage(`Partida exportada a ${target.fsPath}`)
}

/**
 * Replaces this machine's save with an imported one.
 *
 * The previous state is backed up first, and the import is abandoned if that backup cannot be
 * written — the confirmation promises the old progress survives, and overwriting without
 * being able to keep that promise leaves the user with no way back.
 */
async function importSave(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Importar',
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
        ? 'Esa partida es de una versión más reciente. Actualiza la extensión.'
        : detail?.kind === 'fileTooLarge'
          ? 'Ese fichero es demasiado grande para ser una partida.'
          : 'Ese fichero no es una partida de Tokendex.',
    )
    return
  }

  const summary = summarize(envelope.state)
  const confirmed = await vscode.window.showWarningMessage(
    `Se reemplazará tu progreso actual por esta partida (${summary.dexCount} en la Pokédex).`,
    { modal: true, detail: 'Se guardará una copia de seguridad de tu estado actual antes de reemplazarlo.' },
    'Reemplazar',
  )
  if (confirmed !== 'Reemplazar') return

  const target = join(ourData(), 'companion-state.json')
  try {
    const previous = await fs.readFile(target)
    await fs.writeFile(join(ourData(), backupFileName(Date.now())), previous)
  } catch (error) {
    // No previous save is fine; a failed backup is not.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      void vscode.window.showErrorMessage(
        'No se pudo guardar la copia de seguridad, así que no se ha importado nada.',
      )
      return
    }
  }

  await fs.mkdir(ourData(), { recursive: true })
  await fs.writeFile(target, JSON.stringify(envelope.state), 'utf8')
  // The worker holds the old state in memory, so it must be restarted to pick this up.
  await restartWorker()
  void vscode.window.showInformationMessage('Partida importada.')
}

function version(): string {
  return vscode.extensions.getExtension('diegomarty.tokendex')?.packageJSON?.version ?? '0.0.0'
}

async function restartWorker(): Promise<void> {
  const context = extensionContext
  if (context === undefined) return
  await worker?.terminate()
  worker = undefined
  startWorker(context)
  await refresh(true)
  if (GamePanel.isOpen) await handlePanelRequest({ kind: 'refresh' })
}

/**
 * Runs a development scenario and shows the result immediately.
 *
 * Actions are dispatched in order and each one rescans, so a multi-step scenario is visibly
 * animated rather than collapsing into a single jump.
 */
async function runDevScenario(): Promise<void> {
  if (!vscode.workspace.getConfiguration('tokendex').get<boolean>('devMode', false)) {
    const enable = await vscode.window.showWarningMessage(
      'El modo desarrollo está desactivado.',
      'Activarlo',
    )
    if (enable !== 'Activarlo') return
    await vscode.workspace
      .getConfiguration('tokendex')
      .update('devMode', true, vscode.ConfigurationTarget.Global)
  }

  const actions = await pickScenario()
  if (actions.length === 0) return

  for (const [index, action] of actions.entries()) {
    const response = await requestAction(action)
    if (!response.ok) {
      output?.error(`escenario dev fallido: ${response.error}`)
      void vscode.window.showErrorMessage(`Simulación fallida: ${response.error}`)
      return
    }
    if ('panel' in response) GamePanel.update(response.panel)
    output?.info(`dev: ${action.action} (${index + 1}/${actions.length})`)
    // A short gap so a multi-step scenario reads as progress rather than one jump.
    if (index < actions.length - 1) await new Promise((r) => setTimeout(r, 450))
  }
  await refresh(true)
  if (GamePanel.isOpen) await handlePanelRequest({ kind: 'refresh' })
}

async function refresh(manual: boolean): Promise<void> {
  // Never two scans at once: the first cold scan takes ~30 seconds and overlapping them
  // would just multiply the I/O.
  if (scanInFlight) {
    if (manual) output?.info('refresco ignorado: ya hay un escaneo en curso')
    return
  }
  scanInFlight = true
  if (manual && statusBar !== undefined) statusBar.text = '$(sync~spin) Tokendex'

  try {
    const started = Date.now()
    const response = await requestScan()
    if (!response.ok) {
      output?.error(`escaneo fallido: ${response.error}`)
      showError(response.error)
      return
    }
    if (!('snapshot' in response)) return // a panel reply, handled by the panel path
    lastSnapshot = response.snapshot
    render(response.snapshot)
    output?.info(`escaneo completado en ${Date.now() - started} ms`)
    // Keep an open panel in step with the status bar without paying for it when it is closed.
    if (GamePanel.isOpen) void handlePanelRequest({ kind: 'refresh' })
  } finally {
    scanInFlight = false
  }
}

function render(snapshot: UsageSnapshot): void {
  if (statusBar === undefined) return
  statusBar.text = snapshot.statusText
  const tooltip = new vscode.MarkdownString(snapshot.tooltipMarkdown)
  tooltip.isTrusted = false
  statusBar.tooltip = tooltip
  statusBar.backgroundColor = undefined

  if (snapshot.errors.length > 0) {
    output?.warn(`escaneo con avisos: ${snapshot.errors.join(' · ')}`)
  }
}

/** Failure must be visible in the status bar, never silent. */
function showError(message: string): void {
  if (statusBar === undefined) return
  // Keep the last good numbers on screen when we have them, but mark the state.
  statusBar.text = lastSnapshot === undefined ? '$(warning) Tokendex' : `$(warning) ${lastSnapshot.statusText}`
  statusBar.tooltip = `Tokendex: ${message}\nEjecuta "Tokendex: mostrar registro" para más detalle.`
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
