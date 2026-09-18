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

/**
 * The tab strip is a real ARIA tablist.
 *
 * `aria-selected` on a bare `<button>` is not just useless, it is invalid: without
 * `role="tab"` inside a `role="tablist"` a screen reader announces five unlabelled buttons and
 * never says which one is current, or that they control anything. The roving `tabindex` is set
 * by `render` alongside `aria-selected`, so the strip is one tab stop like the Pokédex grid.
 */
export const PANEL_BODY_HTML = `  <nav class="tabs" role="tablist">
${PANEL_TABS.map(
  (tab, index) =>
    `    <button id="tab-${tab}" class="tab" role="tab" data-tab="${tab}" aria-controls="${tab}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}"${
      tab === 'dev' ? ' hidden' : ''
    }><i class="codicon codicon-${TAB_ICONS[tab]}"></i></button>`,
).join('\n')}
  </nav>
  <main>
    <div id="errors" role="alert"></div>
    <!-- Persistent, and deliberately outside the tab sections: a live region only announces
         changes to a node that was already in the document, and every section here is replaced
         wholesale on a repaint. This is how a wild Pokémon arriving reaches a screen reader. -->
    <p id="announce" class="visually-hidden" aria-live="polite" aria-atomic="true"></p>
${PANEL_TABS.map(
  (tab, index) =>
    `    <section id="${tab}" role="tabpanel" aria-labelledby="tab-${tab}"${index === 0 ? '' : ' hidden'}></section>`,
).join('\n')}
  </main>`
