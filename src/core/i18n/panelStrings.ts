/**
 * The panel's chrome labels, resolved in one place.
 *
 * Lives in the core because the core is what emits already-localised text — the webview cannot
 * import these tables, and the development bench must show the same labels as the extension.
 * `PanelStrings` is imported as a **type only**, so there is no runtime edge from the core to
 * the webview bundle; it is just the shape the core promises to emit.
 */

import type { PanelStrings } from '../../webview/protocol.js'
import type { AppLanguage } from '../companion/model.js'
import { providerColumn } from './dispatch.js'
import { s } from './strings.js'

export function panelStrings(lang: AppLanguage): PanelStrings {
  return {
    tabs: {
      home: s(lang, 'home'),
      shop: s(lang, 'shop'),
      bag: s(lang, 'bag'),
      dex: s(lang, 'dexTitle'),
      settings: s(lang, 'settings'),
      dev: 'Dev',
    },
    today: s(lang, 'todayTokens'),
    month: s(lang, 'thisMonth'),
    spendable: s(lang, 'spendableTokens'),
    limits: s(lang, 'limitsOfficial'),
    provider: providerColumn(lang),
    buy: s(lang, 'buy'),
    owned: s(lang, 'ownedAlready'),
    use: s(lang, 'use'),
    empty: s(lang, 'shopHint'),
    bagEmpty: s(lang, 'bagEmptyTitle'),
    dexEmpty: s(lang, 'dexEmptyTitle'),
    dexEmptyHint: s(lang, 'dexEmptyHint'),
    segmentSpecies: s(lang, 'collection'),
    segmentLog: s(lang, 'catchLogTitle'),
    raisingBadge: s(lang, 'dexRaising'),
    confirmBuy: s(lang, 'buy'),
    exportSave: s(lang, 'exportSaveButton'),
    importSave: s(lang, 'importSaveButton'),
    incubating: s(lang, 'eggIncubating'),
    language: s(lang, 'language'),
    settingsHint: s(lang, 'dexEmptyHint'),
  }
}
