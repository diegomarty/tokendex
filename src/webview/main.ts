/**
 * Webview script. Runs in the panel's isolated context, so it has no access to Node, the
 * filesystem or the core modules — everything it renders arrives pre-formatted in the
 * snapshot, and every action is a message.
 *
 * That is the same rule the status bar follows: the UI never re-derives a number. A second
 * formatting path would be a second source of truth that drifts.
 */

import type { PanelLineItem, PanelState } from './protocol.js'
import { spriteURL } from './sprite.js'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

const vscode = acquireVsCodeApi()

type TabID = 'home' | 'shop' | 'bag' | 'dex' | 'settings' | 'dev'
type DexSegment = 'species' | 'log'
let current: PanelState | undefined
let tab: TabID = 'home'
let dexSegment: DexSegment = 'species'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function escapeHTML(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

// MARK: - Rendering

/**
 * The evolution strip. A not-yet-revealed branch is one question mark, never the candidates —
 * the branch is decided at hatch, but showing it early spoils the reveal.
 */
function renderLine(items: PanelLineItem[]): string {
  if (items.length === 0) return ''
  const slots = items
    .map((item) => {
      const art =
        item.speciesID === undefined
          ? '<span class="mystery">?</span>'
          : `<img src="${spriteURL(item.speciesID, false, false)}" alt="" loading="lazy">`
      return `<div class="slot ${item.state}">${art}</div>`
    })
    .join('<span class="arrow">›</span>')
  return `<div class="evoline">${slots}</div>`
}

function renderCompanion(state: PanelState): string {
  const c = state.companion
  if (c === undefined) return ''

  // The animated Gen-V sprite is 96px, and `image-rendering: pixelated` only looks right at whole
  // multiples of that, so it is never scaled — it is *placed*, on a soft platform, which is what
  // stops it reading as a broken image in the middle of a card.
  const art =
    c.speciesID === undefined
      ? '<div class="egg">🥚</div>'
      : `<img class="bob" src="${spriteURL(c.speciesID, c.isShiny, true)}" alt="" data-fallback="${spriteURL(c.speciesID, c.isShiny, false)}">`

  const name = c.name ?? state.strings.incubating
  // One dimmed line instead of three bordered pills: VS Code's own surfaces carry hierarchy with
  // type and spacing, and every extra border makes an extension look like a web page in a panel.
  const meta = [c.stageText, c.rarityText, c.natureText]
    .filter((part): part is string => part !== undefined && part !== '')
    .map(escapeHTML)
    .join(' · ')

  const percent = Math.round(c.progress * 100)

  return `
    <section class="hero">
      <div class="stage">${art}</div>
      <h1 class="hero-name">${escapeHTML(name)}${c.isShiny ? ' <span class="shiny-mark" title="shiny">✨</span>' : ''}</h1>
      ${meta === '' ? '' : `<div class="hero-meta">${meta}</div>`}
      <div class="progress">
        <div class="meta">
          <span>${escapeHTML(c.toNextText)}</span>
          <span class="pct">${percent}%</span>
        </div>
        <div class="bar"><i data-fill="${percent}"></i></div>
      </div>
      ${renderLine(c.line)}
    </section>`
}

/** One usage row: label, value, and the cost trailing it dimmed on the same line. */
function statRow(label: string, value: string, note?: string, exact?: string): string {
  const title = exact === undefined ? '' : ` title="${escapeHTML(exact)}"`
  return `<div class="row-stat">
      <span class="label">${escapeHTML(label)}</span>
      <span class="value"${title}>${escapeHTML(value)}</span>
      ${note === undefined ? '' : `<span class="note">${escapeHTML(note)}</span>`}
    </div>`
}

/**
 * The official limit windows.
 *
 * A bar per window rather than a list of numbers: the question these answer is "how much is left",
 * which is a proportion, and a proportion is read faster as a length than as digits. The colour
 * comes from the severity the core assigned, so it cannot disagree with the status bar's warning
 * background.
 *
 * Absent entirely when nothing is known — an empty "Limits" heading would read as a provider that
 * has stopped reporting, when the truth is that no limits have loaded yet.
 */
function renderLimits(state: PanelState): string {
  if (state.limits.length === 0) return ''
  const rows = state.limits
    .map(
      (limit) => `<div class="limit ${limit.severity}">
        <div class="limit-head">
          <span class="limit-label">${escapeHTML(limit.label)}</span>
          <span class="limit-value">${escapeHTML(limit.value)}</span>
        </div>
        <div class="bar"><i data-fill="${Math.max(0, Math.min(100, Math.round(limit.percent)))}"></i></div>
      </div>`,
    )
    .join('')
  return `<h2 class="section">${escapeHTML(state.strings.limits)}</h2><div class="limits">${rows}</div>`
}

function renderHome(state: PanelState): string {
  const t = state.totals
  const rows = state.providers
    .map(
      (p) => `<tr>
        <td>${escapeHTML(p.displayName)}</td>
        <td class="num">${escapeHTML(p.todayText)}</td>
        <td class="num dim">${escapeHTML(p.monthText)}</td>
      </tr>`,
    )
    .join('')

  // The spendable balance is currency, and a number with nothing to spend it on is a dead end —
  // so it carries the way to the shop. `data-tab` reuses the tab handler, no round trip.
  const shopLink = `<button class="link" data-tab="shop">${escapeHTML(state.strings.buy)} →</button>`

  return `
    ${renderCompanion(state)}
    <div class="stats">
      ${statRow(state.strings.today, t.todayText, t.todayCostText, t.todayExactText)}
      ${statRow(state.strings.month, t.monthText, t.monthCostText, t.monthExactText)}
      <div class="row-stat">
        <span class="label">${escapeHTML(state.strings.spendable)}</span>
        <span class="value">${escapeHTML(state.spendableText)}</span>
        <span class="note">${shopLink}</span>
      </div>
    </div>
    ${renderLimits(state)}
    <table>
      <thead><tr>
        <th>${escapeHTML(state.strings.provider)}</th>
        <th class="num">${escapeHTML(state.strings.today)}</th>
        <th class="num">${escapeHTML(state.strings.month)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
}

function renderShop(state: PanelState): string {
  if (state.shop.length === 0) return `<p class="empty">${escapeHTML(state.strings.empty)}</p>`
  return state.shop
    .map(
      (item) => `
      <div class="row">
        <div class="icon">${escapeHTML(item.emoji)}</div>
        <div class="body">
          <div class="title">${escapeHTML(item.title)}</div>
          <div class="desc">${escapeHTML(item.description)}</div>
        </div>
        <div class="desc">${escapeHTML(item.priceText)}</div>
        <button class="action" data-buy="${escapeHTML(item.id)}"
                data-title="${escapeHTML(item.title)}" data-price="${escapeHTML(item.priceText)}"
                ${item.enabled ? '' : 'disabled'}>
          ${escapeHTML(item.owned ? state.strings.owned : state.strings.buy)}
        </button>
      </div>`,
    )
    .join('')
}

function renderBag(state: PanelState): string {
  if (state.bag.length === 0) return `<p class="empty">${escapeHTML(state.strings.bagEmpty)}</p>`
  return state.bag
    .map(
      (item) => `
      <div class="row">
        <div class="icon">${escapeHTML(item.emoji)}</div>
        <div class="body">
          <div class="title">${escapeHTML(item.title)} ×${item.count}</div>
          <div class="desc">${escapeHTML(item.description)}</div>
        </div>
        ${
          item.usable
            ? `<button class="action" data-use="${escapeHTML(item.id)}">${escapeHTML(state.strings.use)}</button>`
            : `<span class="desc">${escapeHTML(item.hint ?? '')}</span>`
        }
      </div>`,
    )
    .join('')
}

function renderDex(state: PanelState): string {
  const segments = `
    <div class="segments">
      <button class="seg" data-seg="species" aria-selected="${dexSegment === 'species'}">
        ${escapeHTML(state.strings.segmentSpecies)} (${state.dexSpecies.length})
      </button>
      <button class="seg" data-seg="log" aria-selected="${dexSegment === 'log'}">
        ${escapeHTML(state.strings.segmentLog)} (${state.dexLog.length})
      </button>
    </div>`

  const list = state.dexSpecies.length === 0 && state.dexLog.length === 0
  if (list) {
    return `${segments}
      <p class="empty">${escapeHTML(state.strings.dexEmpty)}<br>
      <span class="desc">${escapeHTML(state.strings.dexEmptyHint)}</span></p>`
  }

  if (dexSegment === 'species') {
    const cells = state.dexSpecies
      .map(
        (sp) => `
        <div class="cell${sp.isShiny ? ' shiny' : ''}${sp.isRaising ? ' raising' : ''}"
             title="${escapeHTML(sp.rarityText)}">
          <img src="${spriteURL(sp.id, sp.isShiny, false)}" alt="" loading="lazy">
          <div class="name">${escapeHTML(sp.name)}</div>
          ${sp.isRaising ? `<div class="badge">${escapeHTML(state.strings.raisingBadge)}</div>` : ''}
        </div>`,
      )
      .join('')
    return `${segments}<div class="dex">${cells}</div>`
  }

  const rows = state.dexLog
    .map(
      (e) => `
      <div class="row${e.isActive ? ' active' : ''}">
        <img class="thumb" src="${spriteURL(e.finalID, e.isShiny, false)}" alt="" loading="lazy">
        <div class="body">
          <div class="title">${escapeHTML(e.name)}${e.isShiny ? ' ✨' : ''}</div>
          <div class="desc">${escapeHTML(e.rarityText)}${e.caughtText === undefined ? '' : ` · ${escapeHTML(e.caughtText)}`}</div>
        </div>
        ${e.isActive ? `<span class="desc">${escapeHTML(state.strings.raisingBadge)}</span>` : ''}
      </div>`,
    )
    .join('')
  return `${segments}${rows}`
}

function renderSettings(state: PanelState): string {
  const options = state.languages
    .map(
      (l) =>
        `<option value="${escapeHTML(l.id)}"${l.id === state.language ? ' selected' : ''}>${escapeHTML(l.label)}</option>`,
    )
    .join('')
  return `
    <label class="setting">
      <span>${escapeHTML(state.strings.language)}</span>
      <select id="language">${options}</select>
    </label>
    <div class="setting">
      <button class="action secondary" id="export">${escapeHTML(state.strings.exportSave)}</button>
      <button class="action secondary" id="import">${escapeHTML(state.strings.importSave)}</button>
    </div>
    <p class="desc">${escapeHTML(state.strings.settingsHint)}</p>`
}

/**
 * The Dev tab: every scenario as a control, driven entirely by `state.dev`.
 *
 * The webview does not know what any of these do — it echoes the control id (and the value of
 * its input) back to the host, which validates it against the scenario table. That is the same
 * contract the shop uses, and it is what lets a stale webview fail closed after an update.
 */
function renderDev(state: PanelState): string {
  const dev = state.dev
  if (dev === undefined) return ''

  const summary = dev.summary
    .map(
      (row) => `<div class="dev-row">
        <span class="label">${escapeHTML(row.label)}</span>
        <span class="value">${escapeHTML(row.value)}</span>
      </div>`,
    )
    .join('')

  const groups = dev.groups
    .map((group) => {
      const controls = group.controls
        .map((control) => {
          const field =
            control.input === 'amount'
              ? `<input class="dev-input" type="text" data-dev-input="${escapeHTML(control.id)}"
                        value="${escapeHTML(control.defaultValue ?? '')}"
                        placeholder="${escapeHTML(control.prompt ?? '')}"
                        aria-label="${escapeHTML(control.prompt ?? control.label)}">`
              : control.input === 'choice'
                ? `<select class="dev-input" data-dev-input="${escapeHTML(control.id)}"
                           aria-label="${escapeHTML(control.prompt ?? control.label)}">
                     ${(control.options ?? [])
                       .map(
                         (option) =>
                           `<option value="${escapeHTML(option.value)}"${option.value === control.defaultValue ? ' selected' : ''}>${escapeHTML(option.label)}</option>`,
                       )
                       .join('')}
                   </select>`
                : ''
          return `<div class="row">
            <div class="body">
              <div class="title">${escapeHTML(control.label)}</div>
              ${control.description === '' ? '' : `<div class="desc">${escapeHTML(control.description)}</div>`}
            </div>
            ${field}
            <button class="action${control.destructive ? ' danger' : ''}" data-dev="${escapeHTML(control.id)}">
              Run
            </button>
          </div>`
        })
        .join('')
      return `<h2>${escapeHTML(group.title)}</h2>${controls}`
    })
    .join('')

  return `<div class="dev-summary">${summary}</div>${groups}`
}

function render(): void {
  const state = current
  if (state === undefined) return

  el('errors').innerHTML =
    state.errors.length === 0
      ? ''
      : `<div class="error">${state.errors.map(escapeHTML).join('<br>')}</div>`

  el('home').innerHTML = renderHome(state)
  el('shop').innerHTML = renderShop(state)
  el('bag').innerHTML = renderBag(state)
  el('dex').innerHTML = renderDex(state)
  el('settings').innerHTML = renderSettings(state)
  el('dev').innerHTML = renderDev(state)
  // The tab button ships hidden: without a dev section there is nothing behind it, and a
  // visible-but-empty tab reads as a broken panel.
  el('tab-dev').hidden = state.dev === undefined
  if (state.dev === undefined && tab === 'dev') tab = 'home'

  // Bar widths are applied through the CSSOM, never as style attributes: the CSP's
  // style-src has no 'unsafe-inline', so an inline style in the HTML string is silently
  // dropped — the bars rendered at zero width for as long as they relied on one.
  for (const bar of document.querySelectorAll<HTMLElement>('[data-fill]')) {
    const fill = Math.max(0, Math.min(100, Number(bar.dataset['fill'])))
    bar.style.width = `${Number.isFinite(fill) ? fill : 0}%`
  }

  for (const id of ['home', 'shop', 'bag', 'dex', 'settings', 'dev'] as TabID[]) {
    el(id).hidden = id !== tab
    const button = el(`tab-${id}`)
    button.setAttribute('aria-selected', String(id === tab))
    // The label is localised in the core; here it becomes the hover text and the accessible
    // name, because the visible tab is an icon.
    const label = state.strings.tabs[id]
    button.title = label
    button.setAttribute('aria-label', label)
  }
  vscode.setState({ tab, dexSegment })
}

// MARK: - Events

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const tabButton = target.closest('[data-tab]')
  if (tabButton !== null) {
    tab = (tabButton as HTMLElement).dataset['tab'] as TabID
    render()
    return
  }
  const segment = target.closest('[data-seg]')
  if (segment !== null) {
    dexSegment = (segment as HTMLElement).dataset['seg'] as DexSegment
    render()
    return
  }
  const buy = target.closest('[data-buy]')
  if (buy !== null) {
    const el = buy as HTMLElement
    // The confirmation is a native VS Code modal, raised on the extension side: a webview
    // dialog would be trivially dismissable and this spends real progress.
    vscode.postMessage({
      type: 'buy',
      id: el.dataset['buy'],
      title: el.dataset['title'] ?? '',
      priceText: el.dataset['price'] ?? '',
    })
    return
  }
  const use = target.closest('[data-use]')
  if (use !== null) {
    vscode.postMessage({ type: 'use', id: (use as HTMLElement).dataset['use'] })
    return
  }
  const devControl = target.closest('[data-dev]')
  if (devControl !== null) {
    const id = (devControl as HTMLElement).dataset['dev'] ?? ''
    // The value is read from the control's own row, so two amount fields cannot cross wires.
    const field = (devControl as HTMLElement)
      .closest('.row')
      ?.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-dev-input="${id}"]`)
    vscode.postMessage({ type: 'dev', id, value: field?.value })
    return
  }
  if (target.id === 'export') vscode.postMessage({ type: 'exportSave' })
  if (target.id === 'import') vscode.postMessage({ type: 'importSave' })
})

document.addEventListener('change', (event) => {
  const target = event.target as HTMLElement
  if (target.id === 'language') {
    vscode.postMessage({ type: 'setLanguage', language: (target as HTMLSelectElement).value })
  }
})

// The panel keeps rendering while hidden unless told otherwise, and an always-running sprite
// animation was measured as the single biggest idle cost.
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('paused', document.hidden)
})

// CSP forbids inline handlers, so the animated-sprite fallback is delegated here. Without it a
// species whose GIF is missing shows a broken image instead of its still sprite.
document.addEventListener(
  'error',
  (event) => {
    const img = event.target as HTMLImageElement | null
    const fallback = img?.dataset?.['fallback']
    if (img === null || img === undefined || fallback === undefined) return
    delete img.dataset['fallback']
    img.src = fallback
  },
  true,
)

window.addEventListener('message', (event: MessageEvent<{ type: string; state?: PanelState }>) => {
  if (event.data.type === 'state' && event.data.state !== undefined) {
    current = event.data.state
    render()
  }
})

// Restore the tab the user was on when the panel was serialised. A compact surface (the
// Explorer's mini card) has no tab strip, so it always renders Home.
const saved = vscode.getState() as { tab?: TabID; dexSegment?: DexSegment } | undefined
if (saved?.tab !== undefined) tab = saved.tab
if (saved?.dexSegment !== undefined) dexSegment = saved.dexSegment
if (document.body.classList.contains('compact')) tab = 'home'

vscode.postMessage({ type: 'ready' })
