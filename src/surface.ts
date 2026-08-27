/**
 * One panel, two containers.
 *
 * The panel lives in the activity bar as a `WebviewView` (the default) and can also be opened
 * wide in an editor tab as a `WebviewPanel`. Both are the *same* page: same skeleton, same
 * stylesheet, same script, same `PanelState`. This module owns everything they share so neither
 * container can drift from the other — which is the failure mode that makes a second surface
 * cost twice as much to maintain instead of once.
 *
 * Container-specific lifecycle (revealing a tab, a view's title actions) stays in `panel.ts` and
 * `view.ts`.
 */

import * as vscode from 'vscode'
import type { PanelMessage, PanelState, PanelThrowResult } from './webview/protocol.js'
import { PANEL_BODY_HTML } from './webview/shell.js'

export type PanelRequestKind =
  | { kind: 'refresh' }
  | { kind: 'buy'; id: string; title: string; priceText: string; confirmLabel?: string }
  | { kind: 'use'; id: string }
  | { kind: 'setLanguage'; language: string }
  | { kind: 'exportSave' }
  | { kind: 'importSave' }
  | { kind: 'dev'; id: string; value?: string }
  | { kind: 'throw'; encounterID: string; ball: string }
  | { kind: 'run'; encounterID: string; confirmText?: string; confirmLabel?: string }
  | { kind: 'setTrainer'; trainerID: string }
  | { kind: 'setRefreshInterval'; seconds: number }

/** Every live surface, so a refresh reaches the sidebar and the editor tab in one call. */
const surfaces = new Set<PanelSurface>()

/** The last state built, replayed into a surface that opens later. */
let lastState: PanelState | undefined

export interface SurfaceOptions {
  /** A glanceable mini card (the Explorer view): Home only, no tabs, half-scale sprite. */
  compact?: boolean
}

export class PanelSurface {
  private disposed = false

  constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    private readonly onRequest: (request: PanelRequestKind) => void,
    disposables: vscode.Disposable[],
    private readonly options: SurfaceOptions = {},
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    }
    webview.html = this.html()
    webview.onDidReceiveMessage((message: PanelMessage) => this.handle(message), undefined, disposables)

    surfaces.add(this)
    disposables.push({
      dispose: () => {
        this.disposed = true
        surfaces.delete(this)
      },
    })
  }

  setState(state: PanelState): void {
    if (this.disposed) return
    void this.webview.postMessage({ type: 'state', state })
  }

  postThrow(result: PanelThrowResult): void {
    if (this.disposed) return
    void this.webview.postMessage({ type: 'throw', result })
  }

  /** Rebuilds the page, picking up a freshly built bundle without restarting the host. */
  reload(): void {
    if (this.disposed) return
    this.webview.html = this.html()
  }

  private handle(message: PanelMessage): void {
    switch (message.type) {
      case 'ready':
        // A surface can start before the first snapshot arrives; replay what we have and ask for
        // a fresh one.
        if (lastState !== undefined) this.setState(lastState)
        this.onRequest({ kind: 'refresh' })
        break
      case 'buy': {
        const request: PanelRequestKind = {
          kind: 'buy',
          id: message.id,
          title: message.title,
          priceText: message.priceText,
        }
        if (message.confirmLabel !== undefined) request.confirmLabel = message.confirmLabel
        this.onRequest(request)
        break
      }
      case 'use':
        this.onRequest({ kind: 'use', id: message.id })
        break
      case 'setLanguage':
        this.onRequest({ kind: 'setLanguage', language: message.language })
        break
      case 'exportSave':
        this.onRequest({ kind: 'exportSave' })
        break
      case 'importSave':
        this.onRequest({ kind: 'importSave' })
        break
      case 'dev': {
        // Forwarded as-is; the host validates the id against the scenario table. The webview is a
        // separate bundle and may be stale after an update, so it is never trusted.
        const request: PanelRequestKind = { kind: 'dev', id: message.id }
        if (message.value !== undefined) request.value = message.value
        this.onRequest(request)
        break
      }
      case 'throw':
        // The ball slug is validated on the extension side against `BALL_KINDS`; the encounter
        // id fails closed in the core if the queue no longer holds it.
        this.onRequest({ kind: 'throw', encounterID: message.encounterID, ball: message.ball })
        break
      case 'run': {
        const request: PanelRequestKind = { kind: 'run', encounterID: message.encounterID }
        if (message.confirmText !== undefined) request.confirmText = message.confirmText
        if (message.confirmLabel !== undefined) request.confirmLabel = message.confirmLabel
        this.onRequest(request)
        break
      }
      case 'setTrainer':
        this.onRequest({ kind: 'setTrainer', trainerID: message.trainerID })
        break
      case 'setRefreshInterval':
        this.onRequest({ kind: 'setRefreshInterval', seconds: message.seconds })
        break
    }
  }

  private html(): string {
    const webview = this.webview
    // The query string is what makes a reload actually show new code: the webview caches
    // resources by URI, so rebuilding the page with identical URIs serves the old bundle.
    const version = `v=${Date.now().toString(36)}`
    const asset = (...path: string[]) =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', ...path))
        .with({ query: version })
    const script = asset('webview.js')
    const styles = asset('webview.css')
    // VS Code's own icon font, copied into `dist` at build time. Webviews do not get it for
    // free, and it is what makes the tab strip read as part of the editor rather than as emoji.
    const codicons = asset('codicons', 'codicon.css')
    const nonce = makeNonce()

    // Strict CSP. Sprites are the only remote sources, fetched at runtime rather than bundled —
    // a licence obligation, not a size decision. Two image hosts exactly: PokéAPI (species and
    // item sprites) and Pokémon Showdown (the trainer avatar). `font-src` is required for the
    // codicon font; without it the glyphs silently fall back to boxes.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https://raw.githubusercontent.com https://play.pokemonshowdown.com data:`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codicons.toString()}" rel="stylesheet">
  <link href="${styles.toString()}" rel="stylesheet">
  <title>Tokendex</title>
</head>
<body class="${this.options.compact === true ? 'compact' : ''}">
${PANEL_BODY_HTML}
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`
  }
}

/** Pushes a new state to every open surface, and remembers it for ones that open later. */
export function updateSurfaces(state: PanelState): void {
  lastState = state
  for (const surface of surfaces) surface.setState(state)
}

/**
 * Delivers a throw's outcome. Sent *after* the state push and never remembered: a surface that
 * opens later must not replay an animation for a die cast minutes ago. The webview defers
 * applying the accompanying state until the animation lands, so the order here is what lets it
 * pair the two.
 */
export function broadcastThrow(result: PanelThrowResult): void {
  for (const surface of surfaces) surface.postThrow(result)
}

/** True when at least one surface exists, so a scan can skip building the panel state. */
export function anySurfaceOpen(): boolean {
  return surfaces.size > 0
}

export function reloadSurfaces(): void {
  for (const surface of surfaces) surface.reload()
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}
