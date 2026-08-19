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
 * Initial labels, replaced on the first render by `PanelState.strings.tabs` — which follows the
 * user's language like the rest of the chrome. They are English here because the skeleton is
 * rendered before any state arrives, and a blank tab bar for that instant looks broken.
 */
const TAB_LABELS: Record<PanelTabID, string> = {
  home: 'Home',
  shop: 'Shop',
  bag: 'Bag',
  dex: 'Pokédex',
  settings: 'Settings',
  dev: 'Dev',
}

export const PANEL_BODY_HTML = `  <nav class="tabs">
${PANEL_TABS.map(
  (tab, index) =>
    `    <button id="tab-${tab}" data-tab="${tab}" aria-selected="${index === 0}"${tab === 'dev' ? ' hidden' : ''}>${TAB_LABELS[tab]}</button>`,
).join('\n')}
  </nav>
  <main>
    <div id="errors"></div>
${PANEL_TABS.map((tab, index) => `    <section id="${tab}"${index === 0 ? '' : ' hidden'}></section>`).join('\n')}
  </main>`
