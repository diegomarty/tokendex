/**
 * The game panel: a webview created on demand, serialised rather than retained.
 *
 * `retainContextWhenHidden` is deliberately NOT used — it keeps the whole webview alive in
 * memory for a panel that is closed most of the day. The state is small, so restoring it is
 * cheaper than holding it.
 */

import * as vscode from 'vscode'
import { join } from 'node:path'
import type { PanelMessage, PanelState } from './webview/protocol.js'

export const PANEL_VIEW_TYPE = 'tokendex.panel'

export type PanelRequestKind =
  | { kind: 'refresh' }
  | { kind: 'buy'; id: string; title: string; priceText: string }
  | { kind: 'use'; id: string }
  | { kind: 'setLanguage'; language: string }
  | { kind: 'exportSave' }
  | { kind: 'importSave' }

export class GamePanel {
  private static current: GamePanel | undefined

  private disposables: vscode.Disposable[] = []
  private latest: PanelState | undefined

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly onRequest: (request: PanelRequestKind) => void,
  ) {
    this.panel.webview.html = this.html()

    this.panel.webview.onDidReceiveMessage(
      (message: PanelMessage) => this.handle(message),
      undefined,
      this.disposables,
    )
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables)
    this.panel.onDidChangeViewState(
      () => {
        // Only ask for fresh data when the panel actually becomes visible again.
        if (this.panel.visible) this.onRequest({ kind: 'refresh' })
      },
      undefined,
      this.disposables,
    )
  }

  static show(
    extensionUri: vscode.Uri,
    onRequest: (request: PanelRequestKind) => void,
  ): GamePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One

    if (GamePanel.current !== undefined) {
      GamePanel.current.panel.reveal(column)
      return GamePanel.current
    }

    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'Tokendex',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    )
    GamePanel.current = new GamePanel(panel, extensionUri, onRequest)
    return GamePanel.current
  }

  static get isOpen(): boolean {
    return GamePanel.current !== undefined
  }

  static update(state: PanelState): void {
    GamePanel.current?.setState(state)
  }

  setState(state: PanelState): void {
    this.latest = state
    void this.panel.webview.postMessage({ type: 'state', state })
  }

  private handle(message: PanelMessage): void {
    switch (message.type) {
      case 'ready':
        // The webview can start before the first snapshot arrives; replay what we have.
        if (this.latest !== undefined) this.setState(this.latest)
        this.onRequest({ kind: 'refresh' })
        break
      case 'buy':
        this.onRequest({
          kind: 'buy',
          id: message.id,
          title: message.title,
          priceText: message.priceText,
        })
        break
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
    }
  }

  private html(): string {
    const webview = this.panel.webview
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'))
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'))
    const nonce = makeNonce()

    // Strict CSP. Sprites are the single remote source, and they are fetched from PokéAPI at
    // runtime rather than bundled — a licence obligation, not a size decision.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https://raw.githubusercontent.com data:`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styles.toString()}" rel="stylesheet">
  <title>Tokendex</title>
</head>
<body>
  <nav class="tabs">
    <button id="tab-home" data-tab="home" aria-selected="true">Inicio</button>
    <button id="tab-shop" data-tab="shop" aria-selected="false">Tienda</button>
    <button id="tab-bag" data-tab="bag" aria-selected="false">Bolsa</button>
    <button id="tab-dex" data-tab="dex" aria-selected="false">Pokédex</button>
    <button id="tab-settings" data-tab="settings" aria-selected="false">Ajustes</button>
  </nav>
  <main>
    <div id="errors"></div>
    <section id="home"></section>
    <section id="shop" hidden></section>
    <section id="bag" hidden></section>
    <section id="dex" hidden></section>
    <section id="settings" hidden></section>
  </main>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`
  }

  private dispose(): void {
    GamePanel.current = undefined
    this.panel.dispose()
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}

export { join }
