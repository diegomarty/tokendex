/**
 * The default surface: the panel as a view in its own activity bar container.
 *
 * This is where the extension lives now. A sidebar view is the container VS Code users reach for
 * without thinking — it survives switching files, it has a title bar for actions, and it costs no
 * editor tab. The editor-tab panel (`panel.ts`) stays as the wide view for the Pokédex.
 *
 * The page itself is `PanelSurface`, shared with the tab.
 */

import * as vscode from 'vscode'
import { PanelSurface, type PanelRequestKind, type SurfaceOptions } from './surface.js'

export const VIEW_ID = 'tokendex.view'

export class GameViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private disposables: vscode.Disposable[] = []

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onRequest: (request: PanelRequestKind) => void,
    private readonly options: SurfaceOptions = {},
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    new PanelSurface(view.webview, this.extensionUri, this.onRequest, this.disposables, this.options)

    view.onDidDispose(
      () => {
        for (const d of this.disposables) d.dispose()
        this.disposables = []
        this.view = undefined
      },
      undefined,
      this.disposables,
    )

    view.onDidChangeVisibility(
      () => {
        // A hidden view is not rendered, so there is nothing to refresh into; asking on the way
        // back is what keeps the numbers from being minutes stale when the sidebar reopens.
        if (view.visible) this.onRequest({ kind: 'refresh' })
      },
      undefined,
      this.disposables,
    )
  }

  /**
   * The greyed text beside the view title.
   *
   * The same summary the status bar shows, so the sidebar answers "where am I" without the user
   * having to look at the bottom of the window. Codicon markup is stripped: the title bar renders
   * plain text, and `$(zap)` there would appear literally.
   */
  setDescription(text: string): void {
    if (this.view === undefined) return
    this.view.description = text
  }
}
