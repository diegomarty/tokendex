/**
 * The wide surface: the panel in an editor tab.
 *
 * Secondary to the sidebar view — this is the one you open when the Pokédex grid deserves more
 * than 300 pixels. Everything it renders comes from `PanelSurface`, so it cannot drift from the
 * sidebar.
 *
 * `retainContextWhenHidden` is deliberately NOT used: it keeps the whole webview alive in memory
 * for a tab that is closed most of the day, and the state is small enough that replaying it on
 * `ready` is cheaper than holding it.
 */

import * as vscode from 'vscode'
import { PanelSurface, type PanelRequestKind } from './surface.js'

export const PANEL_VIEW_TYPE = 'tokendex.panel'

export class GamePanel {
  private static current: GamePanel | undefined

  private disposables: vscode.Disposable[] = []

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    onRequest: (request: PanelRequestKind) => void,
  ) {
    new PanelSurface(panel.webview, extensionUri, onRequest, this.disposables)

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables)
    this.panel.onDidChangeViewState(
      () => {
        // Only ask for fresh data when the tab actually becomes visible again.
        if (this.panel.visible) onRequest({ kind: 'refresh' })
      },
      undefined,
      this.disposables,
    )
  }

  static show(extensionUri: vscode.Uri, onRequest: (request: PanelRequestKind) => void): GamePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One

    if (GamePanel.current !== undefined) {
      GamePanel.current.panel.reveal(column)
      return GamePanel.current
    }

    const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, 'Tokendex', column, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    })
    GamePanel.current = new GamePanel(panel, extensionUri, onRequest)
    return GamePanel.current
  }

  static get isOpen(): boolean {
    return GamePanel.current !== undefined
  }

  private dispose(): void {
    GamePanel.current = undefined
    this.panel.dispose()
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}
