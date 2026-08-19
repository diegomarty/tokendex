/**
 * The panel's static skeleton, shared by the real webview and the development bench.
 *
 * It lives here rather than inside `panel.ts` so the bench renders **the same** DOM the
 * extension does. Two copies of this markup would drift, and the drift would only show up as
 * "it looked right in the bench" — which is exactly the failure mode a bench is supposed to
 * prevent.
 *
 * No imports on purpose: this file is pulled into the extension bundle (through `panel.ts`)
 * and into the bench bundle, so it must stay free of both `vscode` and the DOM.
 */

export const PANEL_TABS = ['home', 'shop', 'bag', 'dex', 'settings', 'dev'] as const
export type PanelTabID = (typeof PANEL_TABS)[number]

/**
 * Codicon for each tab.
 *
 * Icons rather than words because the sidebar is ~300 px wide and six labels do not fit there;
 * icons also make the strip read as part of the editor rather than as a web page. The accessible
 * name is not lost: `main.ts` sets `title` and `aria-label` from the localised tab labels, so
 * hovering and a screen reader both say the word.
 */
const TAB_ICONS: Record<PanelTabID, string> = {
  home: 'home',
  shop: 'tag',
  bag: 'package',
  dex: 'book',
  settings: 'settings-gear',
  dev: 'beaker',
}

export const PANEL_BODY_HTML = `  <nav class="tabs">
${PANEL_TABS.map(
  (tab, index) =>
    `    <button id="tab-${tab}" class="tab" data-tab="${tab}" aria-selected="${index === 0}"${
      tab === 'dev' ? ' hidden' : ''
    }><i class="codicon codicon-${TAB_ICONS[tab]}"></i></button>`,
).join('\n')}
  </nav>
  <main>
    <div id="errors"></div>
${PANEL_TABS.map((tab, index) => `    <section id="${tab}"${index === 0 ? '' : ' hidden'}></section>`).join('\n')}
  </main>`
