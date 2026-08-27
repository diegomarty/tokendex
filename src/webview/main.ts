/**
 * Webview script. Runs in the panel's isolated context, so it has no access to Node, the
 * filesystem or the core modules — everything it renders arrives pre-formatted in the
 * snapshot, and every action is a message.
 *
 * That is the same rule the status bar follows: the UI never re-derives a number. A second
 * formatting path would be a second source of truth that drifts.
 */

import type { PanelLineItem, PanelState, PanelThrowResult } from './protocol.js'
import { ANIMATED_SPRITE_MAX, itemSpriteURL, spriteURL, trainerURL } from './sprite.js'

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
/**
 * The last throw's result line, plus the encounter it belongs to. Shown only while that
 * encounter is still (or was last) on stage: without the pairing, "Gotcha! Meowth was caught!"
 * kept standing under the *next* Pokémon that stepped up.
 */
let wildResult: { text: string; encounterID: string } | undefined

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

/** Name, meta line, progress bar and evolution strip — everything about the companion except
 *  its portrait, which in the unified Home lives inside the scene beside the trainer. */
function companionInfo(state: PanelState): string {
  const c = state.companion
  if (c === undefined) return ''

  const name = c.name ?? state.strings.incubating
  // One dimmed line instead of three bordered pills: VS Code's own surfaces carry hierarchy with
  // type and spacing, and every extra border makes an extension look like a web page in a panel.
  const meta = [c.stageText, c.rarityText, c.natureText]
    .filter((part): part is string => part !== undefined && part !== '')
    .map(escapeHTML)
    .join(' · ')

  const percent = Math.round(c.progress * 100)

  return `
      <h1 class="hero-name">${escapeHTML(name)}${c.isShiny ? ' <span class="shiny-mark" title="shiny">✨</span>' : ''}</h1>
      ${meta === '' ? '' : `<div class="hero-meta">${meta}</div>`}
      <div class="progress">
        <div class="meta">
          <span>${escapeHTML(c.toNextText)}</span>
          <span class="pct">${percent}%</span>
        </div>
        <div class="bar"><i data-fill="${percent}"></i></div>
      </div>
      ${renderLine(c.line)}`
}

/**
 * The compact card's hero: portrait on a platform plus the info block. Only the compact
 * surfaces render this — the full panel puts the companion *into the scene* instead, standing
 * beside the trainer, because a portrait card and a scene showing the same creature twice
 * reads as a bug.
 */
function renderCompanion(state: PanelState): string {
  const c = state.companion
  if (c === undefined) return ''

  // The animated Gen-V sprite is integer-scaled on load; see the 'load' listener below.
  const art =
    c.speciesID === undefined
      ? '<div class="egg">🥚</div>'
      : `<img class="bob" src="${spriteURL(c.speciesID, c.isShiny, true)}" alt="" data-fallback="${spriteURL(c.speciesID, c.isShiny, false)}">`

  return `
    <section class="hero">
      <div class="stage${c.celebrating === true ? ' celebrate' : ''}">${art}</div>
      ${companionInfo(state)}
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

/**
 * Home: the whole game on one screen, then the numbers.
 *
 * One scene — your trainer with the companion at their side — is the constant; a wild
 * encounter walks into it when one is waiting, and the block under the scene switches from
 * the companion's progress to the capture controls. Capture is the game's active loop and
 * Home is the centre of everything, so it lives here, not behind a tab.
 *
 * The compact card keeps the old portrait hero: at 48px-sprite scale a scene is unreadable,
 * and the card's whole job is a glance.
 */
function renderHome(state: PanelState): string {
  const t = state.totals
  // The burn column appears only while someone is actually burning: a permanent column of
  // dashes is furniture, but during a session it answers "which CLI is doing this".
  const anyBurn = state.providers.some((p) => p.burnText !== undefined)
  const rows = state.providers
    .map(
      (p) => `<tr>
        <td>${escapeHTML(p.displayName)}</td>
        <td class="num">${escapeHTML(p.todayText)}</td>
        <td class="num dim">${escapeHTML(p.monthText)}</td>
        ${anyBurn ? `<td class="num dim">${p.burnText === undefined ? '' : escapeHTML(p.burnText)}</td>` : ''}
      </tr>`,
    )
    .join('')

  // The spendable balance is currency, and a number with nothing to spend it on is a dead end —
  // so it carries the way to the shop. `data-tab` reuses the tab handler, no round trip.
  const shopLink = `<button class="link" data-tab="shop">${escapeHTML(state.strings.buy)} →</button>`

  const compact = document.body.classList.contains('compact')
  const game = compact ? renderCompanion(state) : renderGame(state)

  // First run, before any CLI has been found: an empty three-column table reads as broken.
  const breakdown =
    state.providers.length === 0
      ? `<p class="empty no-usage">${escapeHTML(state.strings.noUsage)}</p>`
      : `<table>
      <thead><tr>
        <th>${escapeHTML(state.strings.provider)}</th>
        <th class="num">${escapeHTML(state.strings.today)}</th>
        <th class="num">${escapeHTML(state.strings.month)}</th>
        ${anyBurn ? '<th class="num">/min</th>' : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`

  return `
    <div class="game">${game}</div>
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
    ${breakdown}`
}

// MARK: - Wild encounters

/**
 * A throw in flight. While one exists, incoming state pushes are *deferred* rather than
 * rendered: applying them would rebuild the scene mid-animation — the caught Pokémon vanishing
 * an instant before the ball lands on it. `finishThrow` applies the newest deferred state.
 */
interface ThrowInFlight {
  encounterID: string
  startedAt: number
  deferred?: PanelState
  /** Hard deadline: a lost reply must never freeze the panel. */
  deadline: ReturnType<typeof setTimeout>
}
let throwing: ThrowInFlight | undefined

// Durations mirrored in styles.css. Drift between the two shows as motion cut short or a beat
// of stillness — annoying, never broken — which is the acceptable cost of not being able to
// share constants with a stylesheet.
const ARC_MS = 550
const ABSORB_MS = 300
const SHAKE_MS = 450
const RESULT_HOLD_MS = 1000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Reduced motion or a hidden panel both mean: no theatre, results as text. */
function motionOff(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden
}

function beginThrow(encounterID: string, ball: string, sprite: string): void {
  if (throwing !== undefined) return // one ball in the air at a time
  wildResult = undefined

  throwing = {
    encounterID,
    startedAt: performance.now(),
    deadline: setTimeout(() => finishThrow(), 8_000),
  }

  // The arc starts *now*, before the host answers: it looks identical whatever the outcome, and
  // the reply (~100 ms) arrives long before the ball lands (~550 ms). The distance is
  // re-measured here — the click proves the scene is visible, which render() cannot.
  measureThrowDistance()
  const scene = document.querySelector<HTMLElement>('.wild-scene')
  if (scene !== null && !motionOff()) {
    const ballImg = scene.querySelector<HTMLImageElement>('.throw-ball img')
    if (ballImg !== null) ballImg.src = itemSpriteURL(sprite)
    scene.classList.add('throwing')
  }

  vscode.postMessage({ type: 'throw', encounterID, ball })
}

async function playThrow(result: PanelThrowResult): Promise<void> {
  const flight = throwing
  const scene = document.querySelector<HTMLElement>('.wild-scene')
  if (flight === undefined) return
  if (scene === null || motionOff() || result.kind === 'noBall' || result.kind === 'unknownEncounter') {
    finishThrow(result)
    return
  }

  // Let the arc that started on click land first.
  await sleep(Math.max(0, ARC_MS - (performance.now() - flight.startedAt)))
  scene.classList.remove('throwing')
  scene.classList.add('absorbing')
  await sleep(ABSORB_MS)
  scene.classList.remove('absorbing')
  scene.classList.add('landed')

  // A catch shows three wobbles and then the click; a break shows exactly the wobbles the core
  // rolled. The count comes from the reply — the dice were cast once, in the worker.
  const wobbles = result.kind === 'caught' ? 3 : Math.min(result.shakes, 3)
  for (let i = 0; i < wobbles; i++) {
    scene.classList.remove('shake-now')
    void scene.offsetWidth // restart the animation: same class, new run
    scene.classList.add('shake-now')
    await sleep(SHAKE_MS)
  }
  scene.classList.remove('shake-now')

  if (result.kind === 'caught') {
    scene.classList.add('caught')
  } else {
    scene.classList.remove('landed')
    scene.classList.add(result.kind === 'fled' ? 'fled-out' : 'broke-out')
  }

  const line = scene.querySelector<HTMLElement>('.wild-result')
  if (line !== null) line.textContent = result.resultText

  await sleep(RESULT_HOLD_MS)
  finishThrow(result)
}

/** Ends the flight: applies whatever state arrived meanwhile and repaints. */
function finishThrow(result?: PanelThrowResult): void {
  const flight = throwing
  if (flight === undefined) return
  clearTimeout(flight.deadline)
  throwing = undefined
  if (result !== undefined && result.resultText !== '') {
    wildResult = { text: result.resultText, encounterID: result.encounterID }
  }
  if (flight.deferred !== undefined) current = flight.deferred
  render()
}

/**
 * The unified game block: one scene for trainer, companion and — when one is waiting — the
 * wild encounter, with the block beneath switching between the companion's progress and the
 * capture controls. The animated GIF is only used for the wild; the companion at the
 * trainer's side is a 48px still (exactly half of the 96px sheet, the documented clean
 * scale), which keeps the scene to one GIF and the follower legible at sidebar width.
 */
function renderGame(state: PanelState): string {
  const wild = state.wild
  const strings = state.strings
  // Always the head of the queue: encounters are faced one at a time, in order of arrival.
  // The rest are deliberately NOT listed — a count is shown, never the species, so what turns
  // up next stays a surprise instead of a menu.
  const selected = wild.encounters[0]
  const c = state.companion

  // A result line belongs to the throw it reports: it shows while its own encounter is still
  // on stage (a break), or when the stage emptied (the catch/flee that ended the queue) —
  // never under the *next* Pokémon that stepped up.
  const resultLine =
    wildResult === undefined
      ? undefined
      : selected === undefined || selected.id === wildResult.encounterID
        ? wildResult.text
        : undefined

  // `celebrating` is the core's 4-6s hatch/evolve/graduate window finally reaching the panel —
  // before this, the toast fired while the page you were looking at showed nothing.
  const celebrate = c?.celebrating === true ? ' celebrate' : ''
  const follower =
    c === undefined
      ? ''
      : c.speciesID === undefined
        ? `<div class="companion-mon${celebrate}"><div class="egg-small">🥚</div></div>`
        : `<div class="companion-mon${celebrate}"><img class="bob" src="${spriteURL(c.speciesID, c.isShiny, false)}" alt=""></div>`

  const wildPart =
    selected === undefined
      ? ''
      : `
      <div class="wild-mon">
        <img class="mon bob" src="${spriteURL(selected.speciesID, selected.isShiny, true)}" alt=""
             data-fallback="${spriteURL(selected.speciesID, selected.isShiny, false)}">
      </div>
      <div class="throw-ball"><span class="throw-ball-y"><img alt=""></span></div>`

  const scene = `
    <div class="wild-scene${selected === undefined ? '' : ` has-wild rarity-${escapeHTML(selected.rarity)}`}">
      <img class="trainer" src="${trainerURL(state.trainerID)}" alt="">
      ${follower}
      ${wildPart}
      ${
        selected === undefined
          ? ''
          : `<div class="wild-title">
        <span class="title">${escapeHTML(selected.name)}${selected.isShiny ? ' <span class="shiny-mark">✨</span>' : ''}</span>
        <span class="desc">${escapeHTML(selected.rarityText)} · ${escapeHTML(selected.appearedText)}</span>
      </div>`
      }
      <p class="wild-result" aria-live="polite">${resultLine === undefined ? '' : escapeHTML(resultLine)}</p>
      ${
        selected === undefined
          ? ''
          : `<div class="ball-rack">
        ${wild.balls
          .map(
            (ball) => `
        <button class="ball${ball.count === 0 ? ' none' : ''}" data-throw="${escapeHTML(selected.id)}"
                data-ball="${escapeHTML(ball.kind)}" data-sprite="${escapeHTML(ball.sprite)}"
                ${ball.count === 0 ? 'disabled' : ''}
                title="${escapeHTML(ball.name)}${ball.oddsText === undefined ? '' : ` — ${escapeHTML(ball.oddsText)}`}"
                aria-label="${escapeHTML(ball.name)} ×${ball.count}${ball.oddsText === undefined ? '' : `, ${escapeHTML(ball.oddsText)}`}">
          <img src="${itemSpriteURL(ball.sprite)}" alt="">
          ${ball.oddsText === undefined ? '' : `<span class="odds">${escapeHTML(ball.oddsText)}</span>`}
          ${ball.count === 0 ? '' : `<span class="count">×${ball.count}</span>`}
        </button>`,
          )
          .join('')}
        <button class="action secondary" data-run="${escapeHTML(selected.id)}">${escapeHTML(strings.run)}</button>
      </div>
      ${
        wild.balls.every((b) => b.count === 0)
          ? `<div class="no-balls">
        <p class="desc">${escapeHTML(wild.noBallsText)}</p>
        <button class="action" data-tab="shop">🛒 ${escapeHTML(strings.getBalls)}</button>
      </div>`
          : ''
      }`
      }
    </div>`

  // Under the scene: mid-capture, how many more are waiting (a count, never the species) plus
  // a one-line companion strip — a heavy user can have encounters queued for days, and without
  // this the egg's incubation and the companion's progress would simply vanish from Home.
  if (selected !== undefined) {
    const more =
      wild.encounters.length < 2 ? '' : `<p class="desc wild-more">${escapeHTML(wild.waitingText)}</p>`
    const strip =
      c === undefined
        ? ''
        : `<div class="companion-strip">
        <span class="name">${escapeHTML(c.name ?? state.strings.incubating)}${c.isShiny ? ' ✨' : ''}</span>
        <span class="desc">${escapeHTML(c.toNextText)}</span>
        <div class="bar"><i data-fill="${Math.round(c.progress * 100)}"></i></div>
      </div>`
    return `${scene}${more}${strip}`
  }

  return `${scene}
    <section class="scene-info">
      ${companionInfo(state)}
      <div class="next-encounter">
        <span class="desc">${escapeHTML(wild.emptyText)}</span>
        <div class="bar"><i data-fill="${wild.progressPercent}"></i></div>
      </div>
    </section>`
}

/** An item's icon: the real PokéAPI sprite when there is one, the emoji otherwise (and as the
 *  on-error fallback — see the delegated error listener). */
function itemIcon(sprite: string | undefined, emoji: string): string {
  if (sprite === undefined) return `<div class="icon">${escapeHTML(emoji)}</div>`
  return `<div class="icon"><img src="${itemSpriteURL(sprite)}" alt="" data-emoji-fallback="${escapeHTML(emoji)}"></div>`
}

function renderShop(state: PanelState): string {
  if (state.shop.length === 0) return `<p class="empty">${escapeHTML(state.strings.empty)}</p>`

  const row = (item: PanelState['shop'][number]): string => `
      <div class="row">
        ${itemIcon(item.sprite, item.emoji)}
        <div class="body">
          <div class="title">${escapeHTML(item.title)}</div>
          <div class="desc">${escapeHTML(item.description)}</div>
        </div>
        <div class="desc price${!item.enabled && !item.owned ? ' cant' : ''}">${escapeHTML(item.priceText)}</div>
        <button class="action" data-buy="${escapeHTML(item.id)}"
                data-title="${escapeHTML(item.title)}" data-price="${escapeHTML(item.priceText)}"
                data-confirm="${escapeHTML(state.strings.buy)}"
                ${item.enabled ? '' : 'disabled'}>
          ${escapeHTML(item.owned ? state.strings.owned : state.strings.buy)}
        </button>
      </div>`

  // The wallet on top: every price below is judged against this number, so making the reader
  // hop back to Home to know it is a dead end.
  const wallet = `
    <div class="shop-wallet">
      <span class="label">${escapeHTML(state.strings.spendable)}</span>
      <span class="value">${escapeHTML(state.spendableText)}</span>
    </div>`

  const groups: { id: PanelState['shop'][number]['group']; title: string }[] = [
    { id: 'balls', title: state.strings.shopBalls },
    { id: 'items', title: state.strings.shopItems },
    { id: 'eggs', title: state.strings.shopEggs },
  ]
  const sections = groups
    .map((group) => {
      const items = state.shop.filter((item) => item.group === group.id)
      if (items.length === 0) return ''
      return `<h2 class="section">${escapeHTML(group.title)}</h2>${items.map(row).join('')}`
    })
    .join('')

  return `${wallet}${sections}`
}

function renderBag(state: PanelState): string {
  if (state.bag.length === 0) return `<p class="empty">${escapeHTML(state.strings.bagEmpty)}</p>`
  return state.bag
    .map(
      (item) => `
      <div class="row">
        ${itemIcon(item.sprite, item.emoji)}
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
    // The denominator is the huntable pool (the Gen-V animated ceiling both hatches and wilds
    // draw from), so this is a real completion figure, not decoration.
    const done = state.dexSpecies.length
    const completion = `
      <div class="dex-progress">
        <span class="desc">${done} / ${ANIMATED_SPRITE_MAX}</span>
        <div class="bar"><i data-fill="${Math.min(100, Math.round((100 * done) / ANIMATED_SPRITE_MAX))}"></i></div>
      </div>`
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
    return `${segments}${completion}<div class="dex">${cells}</div>`
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
        ${e.isWild ? `<span class="badge wild">${escapeHTML(state.strings.wildBadge)}</span>` : ''}
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
  // The roster comes from the state, so retiring a slug in the core removes it here too. The
  // slug doubles as the accessible name — these are proper names (Red, Lass), not UI copy.
  const trainers = state.trainers
    .map(
      (id) => `
      <button class="trainer-cell" data-trainer="${escapeHTML(id)}"
              aria-selected="${id === state.trainerID}" title="${escapeHTML(id)}" aria-label="${escapeHTML(id)}">
        <img src="${trainerURL(id)}" alt="" loading="lazy">
      </button>`,
    )
    .join('')
  const refresh =
    state.refresh === undefined
      ? ''
      : `
    <label class="setting">
      <span>${escapeHTML(state.strings.refreshInterval)}</span>
      <select id="refresh-interval">${state.refresh.options
        .map(
          (option) =>
            `<option value="${option.seconds}"${option.seconds === state.refresh?.seconds ? ' selected' : ''}>${escapeHTML(option.label)}</option>`,
        )
        .join('')}</select>
    </label>`
  return `
    <label class="setting">
      <span>${escapeHTML(state.strings.language)}</span>
      <select id="language">${options}</select>
    </label>
    ${refresh}
    <div class="setting trainer-setting">
      <span>${escapeHTML(state.strings.trainer)}</span>
      <div class="trainer-grid">${trainers}</div>
    </div>
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
  // Home wears the waiting count: the scene with the queue lives there now.
  el('tab-home').dataset['count'] =
    state.wild.encounters.length === 0 ? '' : String(state.wild.encounters.length)
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

  // Measured only now, after the section visibility flags above: inside a hidden section every
  // offset reads 0, and measuring there was exactly how the first throw's arc came out 60px
  // long. `beginThrow` measures again at click time as the authoritative value.
  if (tab === 'home') measureThrowDistance()
}

/**
 * The throw arc's length depends on the panel's width (sidebar ~300 px, editor tab ~900 px), so
 * it is measured from the live layout and set through the CSSOM — the CSP's style-src has no
 * 'unsafe-inline', the same reason the bars use the CSSOM. Only meaningful while the scene is
 * actually visible; offsets inside a hidden section are all zero.
 */
function measureThrowDistance(): void {
  const scene = document.querySelector<HTMLElement>('.wild-scene')
  const mon = scene?.querySelector<HTMLElement>('.wild-mon')
  const ballOrigin = scene?.querySelector<HTMLElement>('.throw-ball')
  if (scene == null || mon == null || ballOrigin == null) return
  if (mon.offsetWidth === 0) return // hidden: keep whatever a visible pass measured
  const distance = mon.offsetLeft + mon.offsetWidth / 2 - 15 - ballOrigin.offsetLeft
  scene.style.setProperty('--throw-distance', `${Math.max(60, Math.round(distance))}px`)
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
      // The native modal's button, localised: the host has no access to the game's language.
      confirmLabel: el.dataset['confirm'],
    })
    return
  }
  const use = target.closest('[data-use]')
  if (use !== null) {
    vscode.postMessage({ type: 'use', id: (use as HTMLElement).dataset['use'] })
    return
  }
  const throwButton = target.closest('[data-throw]')
  if (throwButton !== null) {
    const b = throwButton as HTMLElement
    beginThrow(b.dataset['throw'] ?? '', b.dataset['ball'] ?? '', b.dataset['sprite'] ?? 'poke-ball')
    return
  }
  const runButton = target.closest('[data-run]')
  if (runButton !== null && throwing === undefined) {
    wildResult = undefined
    const encounterID = (runButton as HTMLElement).dataset['run']
    const encounter = current?.wild.encounters.find((e) => e.id === encounterID)
    vscode.postMessage({
      type: 'run',
      encounterID,
      // Present only when the core marked this one as worth a native confirmation.
      confirmText: encounter?.runConfirmText,
      confirmLabel: current?.strings.run,
    })
    return
  }
  const trainerButton = target.closest('[data-trainer]')
  if (trainerButton !== null) {
    vscode.postMessage({
      type: 'setTrainer',
      trainerID: (trainerButton as HTMLElement).dataset['trainer'],
    })
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
  if (target.id === 'refresh-interval') {
    const seconds = Number((target as HTMLSelectElement).value)
    if (Number.isFinite(seconds)) vscode.postMessage({ type: 'setRefreshInterval', seconds })
  }
})

// The panel keeps rendering while hidden unless told otherwise, and an always-running sprite
// animation was measured as the single biggest idle cost.
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('paused', document.hidden)
})

// Gen-V sprites are drawn to a shared relative scale — Game Freak's own proportionality: Aron
// is 32px because Aron is small, Wailord is 103px because Wailord is not. The wild scene keeps
// them at native ×1, which is exactly the scale of an 80px Showdown trainer (Showdown pairs
// the two the same way in battle) — normalising them toward one size is what briefly made an
// Aron tower over the trainer. The HERO is different: a portrait with no human beside it, so a
// 32px companion would just look lost — there, and only there, small sprites are integer-scaled
// up toward ~80px. Whole multiples only, the condition under which `pixelated` is exact.
// Delegated in capture phase ('load' does not bubble), like the error fallback below.
document.addEventListener(
  'load',
  (event) => {
    const img = event.target as HTMLElement | null
    if (!(img instanceof HTMLImageElement)) return
    // The compact card pins its sprite to 48px in CSS; an inline size set here would win over
    // that rule and break the mini layout.
    if (document.body.classList.contains('compact')) return
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (w === 0 || h === 0) return
    if (img.matches('.stage img')) {
      const scale = Math.min(3, Math.max(1, Math.round(80 / h)))
      img.style.width = `${w * scale}px`
      img.style.height = `${h * scale}px`
    } else if (img.matches('.wild-mon img')) {
      // Native size (×1): the size just settled, so the arc's landing point may have moved.
      measureThrowDistance()
    }
  },
  true,
)

// CSP forbids inline handlers, so the animated-sprite fallback is delegated here. Without it a
// species whose GIF is missing shows a broken image instead of its still sprite.
document.addEventListener(
  'error',
  (event) => {
    const img = event.target as HTMLImageElement | null
    if (img === null || img === undefined) return
    const fallback = img.dataset['fallback']
    if (fallback !== undefined) {
      delete img.dataset['fallback']
      img.src = fallback
      return
    }
    // Item sprites degrade to their emoji — set as text, never markup, so nothing re-enters HTML.
    const emoji = img.dataset['emojiFallback']
    if (emoji !== undefined) {
      const span = document.createElement('span')
      span.textContent = emoji
      img.replaceWith(span)
    }
  },
  true,
)

window.addEventListener(
  'message',
  (event: MessageEvent<{ type: string; state?: PanelState; result?: PanelThrowResult }>) => {
    if (event.data.type === 'state' && event.data.state !== undefined) {
      // Mid-throw, the fresh state already shows the outcome (the Pokémon gone, the ball
      // spent); rendering it now would spoil the animation still playing. It applies when the
      // ball lands.
      if (throwing !== undefined) {
        throwing.deferred = event.data.state
        return
      }
      current = event.data.state
      render()
    }
    if (event.data.type === 'throw' && event.data.result !== undefined) {
      // A result for a throw this surface did not start (another surface's, or a replay to a
      // stale view) is ignored: without a flight there is no scene mid-animation to resolve.
      if (throwing === undefined || throwing.encounterID !== event.data.result.encounterID) return
      void playThrow(event.data.result)
    }
  },
)

// Restore the tab the user was on when the panel was serialised. A compact surface (the
// Explorer's mini card) has no tab strip, so it always renders Home.
const saved = vscode.getState() as { tab?: string; dexSegment?: DexSegment } | undefined
// Validated, not cast: a session serialised before a tab was removed (the old Wild tab) would
// otherwise restore into a tab that no longer exists and hide every section.
const KNOWN_TABS: readonly TabID[] = ['home', 'shop', 'bag', 'dex', 'settings', 'dev']
if (saved?.tab !== undefined && (KNOWN_TABS as readonly string[]).includes(saved.tab)) {
  tab = saved.tab as TabID
}
if (saved?.dexSegment !== undefined) dexSegment = saved.dexSegment
if (document.body.classList.contains('compact')) tab = 'home'

// Until the first state arrives the page is blank, and on a first-ever install that can last
// the whole cold scan. English literal by necessity: the localised strings live in the state
// this placeholder is waiting for. It is replaced by the first render.
if (current === undefined) {
  el('home').innerHTML = '<p class="empty">Reading your local AI usage…</p>'
}

vscode.postMessage({ type: 'ready' })
