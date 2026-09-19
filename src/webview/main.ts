/**
 * Webview script. Runs in the panel's isolated context, so it has no access to Node, the
 * filesystem or the core modules — everything it renders arrives pre-formatted in the
 * snapshot, and every action is a message.
 *
 * That is the same rule the status bar follows: the UI never re-derives a number. A second
 * formatting path would be a second source of truth that drifts.
 */

import type { PanelLineItem, PanelShopAction, PanelState, PanelThrowResult } from './protocol.js'
import { PANEL_TABS, type PanelTabID } from './shell.js'
import { ANIMATED_SPRITE_MAX, itemSpriteURL, sceneSpriteURL, spriteURL, trainerURL } from './sprite.js'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

const vscode = acquireVsCodeApi()

/** One list for the skeleton, the renderers and the restore guard — shell.ts owns it. */
type TabID = PanelTabID
type DexSegment = 'species' | 'log'
let current: PanelState | undefined
let tab: TabID = 'home'
let dexSegment: DexSegment = 'species'
/** The species opened in the dex detail card. Locked ones are selectable too — number only. */
let dexSelected: number | undefined
/** Pokédex narrowing. Panel-owned view state, so it survives a repaint but not a reload. */
let dexQuery = ''
let dexOwnedOnly = false
/** Catch-log rarity chip: 'all', or a rarity token matching `PanelDexEntry.rarity`. */
let dexLogFilter = 'all'
/**
 * The last throw's result line, plus the encounter it belongs to. Shown only while that
 * encounter is still (or was last) on stage: without the pairing, "Gotcha! Meowth was caught!"
 * kept standing under the *next* Pokémon that stepped up.
 */
let wildResult: { text: string; encounterID: string } | undefined
/** The last state actually painted, serialised — identical pushes skip the re-render. */
let lastRenderedState: string | undefined
/** Wild count at the last announcement, so only an *arrival* is spoken. */
let announcedWildCount = 0

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

/**
 * The compact card's one line about the wild queue.
 *
 * The compact card is the DEFAULT surface (`tokendex.companionLocation` is `explorer`), and it
 * used to say nothing at all about wild Pokémon — so the game's active loop was invisible
 * exactly where most people look. A badge on the activity-bar icon was the only signal, and a
 * queue can sit full for days without anyone noticing it is there.
 *
 * It leads somewhere on purpose: this card has no tab strip, so it can report the queue but
 * never resolve it. Clicking opens the real panel.
 */
function renderWildStrip(state: PanelState): string {
  const staged = state.wild.encounters[0]
  if (staged === undefined) return ''
  return `
    <button class="wild-strip" data-open-panel aria-label="${escapeHTML(state.wild.waitingText)}">
      <img src="${spriteURL(staged.speciesID, staged.isShiny, false)}" alt="">
      <span class="body">
        <span class="title">${escapeHTML(staged.name)}${staged.isShiny ? ' <span class="shiny-mark">✨</span>' : ''}</span>
        <span class="desc">${escapeHTML(state.wild.waitingText)}</span>
      </span>
      <i class="codicon codicon-chevron-right"></i>
    </button>`
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
  const game = compact ? renderCompanion(state) + renderWildStrip(state) : renderGame(state)

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
  invalidate('home')

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
  if (flight.deferred !== undefined) applyState(flight.deferred)
  // Even with nothing deferred: the result line is panel-owned view state, not part of a push.
  invalidate('home')
  render()
}

/**
 * The unified game block: one scene for trainer, companion and — when one is waiting — the
 * wild encounter, with the block beneath switching between the companion's progress and the
 * capture controls.
 *
 * Everyone standing in it goes through `sceneSpriteURL`: one rule, native ×1, feet on one
 * ground line. The follower used to be the exception — a still pinned to 48px, half Game
 * Freak's own scale, which read as a speck beside a full-size trainer. Growing that still to
 * the whole 96px sheet is not enough on its own, because the sheet's transparent floor varies
 * per species; the animated frame is cropped to the feet, which is exactly why the wild has
 * always used it. The cost is a second GIF in the scene while an encounter is on stage.
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
        : `<div class="companion-mon${celebrate}"><img class="bob" src="${sceneSpriteURL(c.speciesID, c.isShiny)}" alt=""
             data-fallback="${spriteURL(c.speciesID, c.isShiny, false)}"></div>`

  const wildPart =
    selected === undefined
      ? ''
      : `
      <div class="wild-mon">
        <img class="mon bob" src="${sceneSpriteURL(selected.speciesID, selected.isShiny)}" alt=""
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
    // A miniature of the compact card: portrait, name, stage line and the bar. The bare
    // one-line strip it replaces read as a caption, not as "your companion is still here".
    const meta =
      c === undefined
        ? ''
        : [c.stageText, c.rarityText]
            .filter((part): part is string => part !== undefined && part !== '')
            .map(escapeHTML)
            .join(' · ')
    const card =
      c === undefined
        ? ''
        : `<div class="companion-card">
        <div class="thumb">${
          c.speciesID === undefined
            ? '<span class="egg-small">🥚</span>'
            : `<img src="${spriteURL(c.speciesID, c.isShiny, false)}" alt="">`
        }</div>
        <div class="body">
          <div class="title">${escapeHTML(c.name ?? state.strings.incubating)}${c.isShiny ? ' <span class="shiny-mark">✨</span>' : ''}</div>
          ${meta === '' ? '' : `<div class="desc">${meta}</div>`}
          <div class="progress">
            <div class="meta">
              <span>${escapeHTML(c.toNextText)}</span>
              <span class="pct">${Math.round(c.progress * 100)}%</span>
            </div>
            <div class="bar"><i data-fill="${Math.round(c.progress * 100)}"></i></div>
          </div>
        </div>
      </div>`
    return `${scene}${more}${card}`
  }

  // The same progress component the companion uses, rather than a second, narrower, centred
  // bar with no figure on it: two bars stacked in two shapes, for two different meanings, read
  // as a layout accident.
  return `${scene}
    <section class="scene-info">
      ${companionInfo(state)}
      <div class="progress next-encounter">
        <div class="meta">
          <span>${escapeHTML(wild.nextText)}</span>
          <span class="pct">${wild.progressPercent}%</span>
        </div>
        <div class="bar"><i data-fill="${wild.progressPercent}"></i></div>
        ${streakRow(wild.streak)}
      </div>
    </section>`
}

/**
 * The streak row: one dot per day of the rolling window, with the short line beside it.
 *
 * Every decision arrived already made — which dots are filled, which one was the payout,
 * whether the week is spent, and what the line says. Nothing here counts a day or compares a
 * date, which is the only reason the row cannot drift from the rule that pays the reward.
 *
 * Unlike the bars, the ARIA is written into the markup rather than applied in a pass like
 * `paintBars`: that function exists because the CSP drops inline *styles*, and these dots need
 * none. Attributes in the string survive, and they come back automatically when a tab is
 * repainted from `current` after being switched away from.
 *
 * `streak` is read defensively because the webview is a separate bundle: an updated host is
 * the normal case, but a stale panel restored from a serialised state is not, and a missing
 * row must leave the bar alone rather than throw through the whole render.
 */
function streakRow(streak: PanelState['wild']['streak'] | undefined): string {
  if (streak === undefined || streak.days.length === 0) return ''
  const dots = streak.days.map((day) => `<i class="dot ${escapeHTML(day)}"></i>`).join('')
  return `<div class="streak${streak.earned ? ' earned' : ''}" role="progressbar"
       aria-label="${escapeHTML(streak.label)}" aria-valuemin="0"
       aria-valuemax="${streak.max}" aria-valuenow="${streak.value}"
       aria-valuetext="${escapeHTML(streak.text)}">
      <span class="label">${escapeHTML(streak.text)}</span>
      <span class="dots">${dots}</span>
    </div>`
}

/** An item's icon: the real PokéAPI sprite when there is one, the emoji otherwise (and as the
 *  on-error fallback — see the delegated error listener). */
function itemIcon(sprite: string | undefined, emoji: string): string {
  if (sprite === undefined) return `<div class="icon">${escapeHTML(emoji)}</div>`
  return `<div class="icon"><img src="${itemSpriteURL(sprite)}" alt="" data-emoji-fallback="${escapeHTML(emoji)}"></div>`
}

/**
 * One buyable price, as a button.
 *
 * Everything on it was decided in the core: the visible word, the accessible name, the price,
 * the saving and whether it is affordable. `owned` is the row's, not the action's — it only
 * picks which of the two disabled looks applies.
 */
function shopAction(
  state: PanelState,
  item: PanelState['shop'][number],
  action: PanelShopAction,
  withPrice: boolean,
): string {
  // Dimmed and italic, never struck through: a line through a price reads as a discount, and
  // this row has a real one two millimetres away.
  const cant = !action.enabled && !item.owned ? ' cant' : ''
  const price = withPrice
    ? `<span class="cost${cant}">${escapeHTML(action.priceText)}</span>` +
      (action.saveText === undefined ? '' : `<span class="save">${escapeHTML(action.saveText)}</span>`)
    : ''
  return `<button class="action${withPrice ? ' priced' : ''}" data-buy="${escapeHTML(action.id)}"
                data-title="${escapeHTML(action.confirmTitle)}" data-price="${escapeHTML(action.priceText)}"
                data-confirm="${escapeHTML(state.strings.buy)}"
                aria-label="${escapeHTML(action.label)}"
                ${action.enabled ? '' : 'disabled'}>
          <span class="verb">${escapeHTML(action.text)}</span>${price}
        </button>`
}

function renderShop(state: PanelState): string {
  if (state.shop.length === 0) return `<p class="empty">${escapeHTML(state.strings.empty)}</p>`

  /**
   * Two layouts, chosen by how many prices the row carries rather than by what it sells.
   *
   * One price keeps the shape the whole shop has always had — name and sentence left, price and
   * button right, two lines. Two prices cannot fit that: at 300px the buttons would leave the
   * name a column narrow enough to break "モンスターボール" across four lines. So the pair drops
   * to its own line under the name, and the prices move inside the buttons, which is also what
   * lets the two be told apart without reading the same word twice.
   */
  const row = (item: PanelState['shop'][number]): string => {
    const stat =
      item.stat === undefined
        ? ''
        : `<span class="stat"${item.statLabel === undefined ? '' : ` title="${escapeHTML(item.statLabel)}"`}>${escapeHTML(item.stat)}</span>`
    const desc =
      item.description === undefined ? '' : `<div class="desc">${escapeHTML(item.description)}</div>`
    const body = `<div class="body">
          <div class="title">${escapeHTML(item.title)}${stat}</div>
          ${desc}
        </div>`
    if (item.actions.length === 1) {
      const only = item.actions[0]!
      return `
      <div class="row">
        ${itemIcon(item.sprite, item.emoji)}
        ${body}
        <div class="desc price${!only.enabled && !item.owned ? ' cant' : ''}">${escapeHTML(only.priceText)}</div>
        ${shopAction(state, item, only, false)}
      </div>`
    }
    return `
      <div class="row multi">
        ${itemIcon(item.sprite, item.emoji)}
        ${body}
        <div class="buys">${item.actions.map((a) => shopAction(state, item, a, true)).join('')}</div>
      </div>`
  }

  // The wallet on top: every price below is judged against this number, so making the reader
  // hop back to Home to know it is a dead end.
  const wallet = `
    <div class="shop-wallet">
      <span class="label">${escapeHTML(state.strings.spendable)}</span>
      <span class="value">${escapeHTML(state.spendableText)}</span>
    </div>`

  // `note` is what every card in the group would otherwise repeat. Only the eggs have one so
  // far, and saying it once is the entire reason they each fit on one line now.
  const groups: { id: PanelState['shop'][number]['group']; title: string; note?: string }[] = [
    { id: 'balls', title: state.strings.shopBalls },
    { id: 'items', title: state.strings.shopItems },
    { id: 'eggs', title: state.strings.shopEggs, note: state.strings.shopEggsNote },
  ]
  // Each group is its own element, with its own row list inside it. Flat, the wide layout's
  // auto-fill grid swallowed the headings as cells: "ITEMS" landed in a column beside a ball,
  // and rows sat under a heading they did not belong to.
  const sections = groups
    .map((group) => {
      const items = state.shop.filter((item) => item.group === group.id)
      if (items.length === 0) return ''
      const note = group.note === undefined ? '' : `<p class="section-note">${escapeHTML(group.note)}</p>`
      return `<section class="shop-group">
        <h2 class="section">${escapeHTML(group.title)}</h2>${note}
        <div class="shop-rows">${items.map(row).join('')}</div>
      </section>`
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

/** The dex number the games print: three digits, hash first. */
const dexNumber = (id: number): string => `#${String(id).padStart(3, '0')}`

/**
 * The card above the grid for the selected species. For an unlocked one: the animated sprite,
 * number, name, rarity, a gold star when shiny, and its catch-log entries. For a locked one:
 * the silhouette and its number — enough to want it, not enough to spoil it.
 */
function renderDexDetail(state: PanelState, sp: PanelState['dexSpecies'][number] | undefined): string {
  if (dexSelected === undefined) return ''
  const close = `<button class="dex-close" data-dex-close aria-label="${escapeHTML(state.strings.close)}">✕</button>`

  if (sp === undefined) {
    return `
    <div class="dex-detail locked">
      <div class="portrait"><img src="${spriteURL(dexSelected, false, false)}" alt=""></div>
      <div class="body">
        <div class="title">${dexNumber(dexSelected)}</div>
        <div class="desc">?????</div>
      </div>
      ${close}
    </div>`
  }

  // Every catch-log entry whose final form is this species: dates, wild badge, shiny star —
  // all pre-formatted fields, laid out here rather than re-derived.
  const entries = state.dexLog
    .filter((e) => e.finalID === sp.id)
    .slice(0, 4)
    .map((e) => {
      // Escaped once, at the join below. Escaping here as well double-encodes anything a
      // translation happens to contain (`&`, an apostrophe) into visible `&amp;#39;`.
      const parts = [
        e.isActive ? state.strings.raisingBadge : (e.caughtText ?? ''),
        e.isWild ? state.strings.wildBadge : '',
      ].filter((part) => part !== '')
      return `<div class="desc">${parts.map(escapeHTML).join(' · ')}${e.isShiny ? ' <span class="star-inline">★</span>' : ''}</div>`
    })
    .join('')

  return `
    <div class="dex-detail${sp.isShiny ? ' shiny' : ''}">
      <div class="portrait">
        <img src="${spriteURL(sp.id, sp.isShiny, true)}" alt=""
             data-fallback="${spriteURL(sp.id, sp.isShiny, false)}">
      </div>
      <div class="body">
        <div class="title">
          <span class="num">${dexNumber(sp.id)}</span> ${escapeHTML(sp.name)}
          ${sp.isShiny ? '<span class="star-inline" title="shiny">★</span>' : ''}
        </div>
        <div class="desc">${escapeHTML(sp.rarityText)}${sp.isRaising ? ` · ${escapeHTML(state.strings.raisingBadge)}` : ''}</div>
        ${entries}
      </div>
      ${close}
    </div>`
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

  if (dexSegment === 'species') {
    // The whole huntable pool, silhouettes included: an all-caught-species list reads as an
    // archive, but 625 dark shapes read as a goal. Locked cells carry only the silhouette and
    // the number — what is behind them stays a surprise, the same rule the wild queue follows.
    const done = state.dexSpecies.length
    const byID = new Map(state.dexSpecies.map((sp) => [sp.id, sp]))
    const completion = `
      <div class="dex-progress">
        <span class="desc">${done} / ${ANIMATED_SPRITE_MAX}</span>
        <div class="bar"><i data-fill="${Math.min(100, Math.round((100 * done) / ANIMATED_SPRITE_MAX))}"></i></div>
      </div>`
    const hint =
      done === 0
        ? `<p class="empty">${escapeHTML(state.strings.dexEmpty)}<br>
      <span class="desc">${escapeHTML(state.strings.dexEmptyHint)}</span></p>`
        : ''

    // 649 cells is ~217 rows in a sidebar. Scrolling to a species is not something anyone does
    // twice, so the grid narrows instead. A numeric query matches the *number*, locked entries
    // included — you can look up #025 before you have ever seen it; a text query can only match
    // a name, and a locked cell has none to match.
    const query = dexQuery.trim().toLowerCase()
    const numeric = /^#?\d+$/.test(query) ? String(Number(query.replace('#', ''))) : undefined
    const matches = (id: number, sp: PanelState['dexSpecies'][number] | undefined): boolean => {
      if (dexOwnedOnly && sp === undefined) return false
      if (query === '') return true
      if (numeric !== undefined) return String(id).includes(numeric)
      return sp !== undefined && sp.name.toLowerCase().includes(query)
    }

    const controls = `
      <div class="dex-controls">
        <input id="dex-search" type="search" class="dex-search" value="${escapeHTML(dexQuery)}"
               placeholder="${escapeHTML(state.strings.dexSearch)}"
               aria-label="${escapeHTML(state.strings.dexSearch)}">
        <button class="chip" data-dex-owned aria-pressed="${dexOwnedOnly}">
          ${escapeHTML(state.strings.dexOwnedOnly)}
        </button>
      </div>`

    const cells: string[] = []
    for (let id = 1; id <= ANIMATED_SPRITE_MAX; id++) {
      const sp = byID.get(id)
      if (!matches(id, sp)) continue
      const selected = id === dexSelected ? ' selected' : ''
      // Roving tabindex: 649 buttons must be ONE tab stop, not 649 — Tab enters the grid at the
      // open (or first) cell and the arrow keys move inside it; Tab again leaves it.
      const tabIndex = ` tabindex="${id === (dexSelected ?? 1) ? 0 : -1}"`
      if (sp === undefined) {
        cells.push(`
        <button class="cell locked${selected}" data-dex="${id}"${tabIndex} title="${dexNumber(id)}">
          <img src="${spriteURL(id, false, false)}" alt="" loading="lazy">
          <div class="num">${dexNumber(id)}</div>
        </button>`)
      } else {
        cells.push(`
        <button class="cell${sp.isShiny ? ' shiny' : ''}${sp.isRaising ? ' raising' : ''}${selected}"
                data-dex="${id}"${tabIndex} title="${escapeHTML(sp.name)} · ${escapeHTML(sp.rarityText)}">
          ${sp.isShiny ? '<span class="star" title="shiny">★</span>' : ''}
          <img src="${spriteURL(sp.id, sp.isShiny, false)}" alt="" loading="lazy">
          <div class="num">${dexNumber(id)}</div>
          <div class="name">${escapeHTML(sp.name)}</div>
          ${sp.isRaising ? `<div class="badge">${escapeHTML(state.strings.raisingBadge)}</div>` : ''}
        </button>`)
      }
    }
    const grid =
      cells.length === 0
        ? `<p class="empty">${escapeHTML(state.strings.dexNoMatches)}</p>`
        : `<div class="dex">${cells.join('')}</div>`
    // The detail renders after the grid but floats fixed at the bottom of the view: a card at
    // the top of a 649-cell grid opens off-screen when the click happened four screens down.
    return `${segments}${controls}${completion}${hint}${grid}${renderDexDetail(state, byID.get(dexSelected ?? -1))}`
  }

  if (state.dexLog.length === 0) {
    return `${segments}
      <p class="empty">${escapeHTML(state.strings.dexEmpty)}<br>
      <span class="desc">${escapeHTML(state.strings.dexEmptyHint)}</span></p>`
  }

  // Rarity chips, counted by the core. The log itself stays chronological — this is the
  // narrowing that replaced rarity as its sort key.
  const chips = `
    <div class="dex-controls">
      ${state.dexLogFilters
        .map(
          (filter) => `<button class="chip" data-dex-filter="${escapeHTML(filter.id)}"
            aria-pressed="${filter.id === dexLogFilter}">${escapeHTML(filter.label)} ${filter.count}</button>`,
        )
        .join('')}
    </div>`

  const visible =
    dexLogFilter === 'all' ? state.dexLog : state.dexLog.filter((e) => e.rarity === dexLogFilter)
  if (visible.length === 0) {
    return `${segments}${chips}<p class="empty">${escapeHTML(state.strings.dexNoMatches)}</p>`
  }

  const rows = visible
    .map(
      (e) => `
      <div class="row${e.isActive ? ' active' : ''}">
        <img class="thumb" src="${spriteURL(e.finalID, e.isShiny, false)}" alt="" loading="lazy">
        <div class="body">
          <div class="title">${escapeHTML(e.name)}${e.isShiny ? ' <span class="star-inline">★</span>' : ''}</div>
          <div class="desc">${escapeHTML(e.rarityText)}${e.caughtText === undefined ? '' : ` · ${escapeHTML(e.caughtText)}`}</div>
        </div>
        ${e.isActive ? `<span class="desc">${escapeHTML(state.strings.raisingBadge)}</span>` : ''}
        ${e.isWild ? `<span class="badge wild">${escapeHTML(state.strings.wildBadge)}</span>` : ''}
      </div>`,
    )
    .join('')
  return `${segments}${chips}${rows}`
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
    <h2 class="section">${escapeHTML(state.strings.saveSection)}</h2>
    <div class="setting save-actions">
      <button class="action secondary" id="export">${escapeHTML(state.strings.exportSave)}</button>
      <button class="action secondary" id="import">${escapeHTML(state.strings.importSave)}</button>
    </div>`
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

/** One renderer per tab, so `render` can paint the visible one and leave the rest alone. */
const RENDERERS: Record<TabID, (state: PanelState) => string> = {
  home: renderHome,
  shop: renderShop,
  bag: renderBag,
  dex: renderDex,
  settings: renderSettings,
  dev: renderDev,
}

/**
 * Tabs already painted from the state currently in `current`. Cleared whenever a new state
 * arrives, so a tab is rebuilt the first time it is looked at and never again until something
 * actually changed.
 */
let painted = new Set<TabID>()

/** Repaints a tab the next time it is shown, for view state the panel owns (dex selection). */
function invalidate(tab: TabID): void {
  painted.delete(tab)
}

/**
 * The one way a new state gets in.
 *
 * There are two callers — a push from the host, and a throw landing on a state that was
 * deferred while the animation played — and the second used to assign `current` directly.
 * Every tab already painted from the pre-throw state then kept its stale markup: the catch
 * missing from the Pokédex, the spent ball still in the Bag, until some *later* push happened
 * to differ from the state before the throw. One entry point, one invalidation.
 */
function applyState(state: PanelState, serialized?: string): void {
  current = state
  lastRenderedState = serialized ?? JSON.stringify(state)
  painted = new Set()
}

/**
 * Bars are drawn through the CSSOM, never as style attributes: the CSP's `style-src` has no
 * 'unsafe-inline', so an inline style in the HTML string is silently dropped — the bars
 * rendered at zero width for as long as they relied on one.
 *
 * The ARIA is applied here too rather than in six markup strings: every bar in the panel is
 * this same pair of elements, and a progress bar with no role is invisible to a screen reader
 * however many of them there are.
 */
function paintBars(root: HTMLElement): void {
  for (const fillElement of root.querySelectorAll<HTMLElement>('[data-fill]')) {
    const raw = Number(fillElement.dataset['fill'])
    const fill = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0
    fillElement.style.width = `${fill}%`
    const bar = fillElement.parentElement
    if (bar === null) continue
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', '100')
    bar.setAttribute('aria-valuenow', String(Math.round(fill)))
  }
}

function render(): void {
  const state = current
  if (state === undefined) return

  // innerHTML replacement can shift the page (images collapse until they re-load); putting the
  // scroll back is what keeps a refresh from stealing the reader's place mid-Pokédex.
  const scroller = document.scrollingElement
  const scrollTop = scroller?.scrollTop ?? 0

  el('errors').innerHTML =
    state.errors.length === 0
      ? ''
      : `<div class="error">${state.errors.map(escapeHTML).join('<br>')}</div>`

  // The tab button ships hidden: without a dev section there is nothing behind it, and a
  // visible-but-empty tab reads as a broken panel.
  el('tab-dev').hidden = state.dev === undefined
  if (state.dev === undefined && tab === 'dev') tab = 'home'

  // Only the tab being looked at. Painting all six cost the Pokédex's 649 cells on every state
  // push — measured at 3.3 ms against 0.4 ms for Home, plus ~650 img nodes parked in the DOM
  // of a sidebar — for a grid nobody was looking at.
  if (!painted.has(tab)) {
    const section = el(tab)
    section.innerHTML = RENDERERS[tab](state)
    painted.add(tab)
    paintBars(section)
  }

  // Home wears the waiting count: the scene with the queue lives there now.
  const waiting = state.wild.encounters.length
  el('tab-home').dataset['count'] = waiting === 0 ? '' : String(waiting)
  // Only on the way up: a queue shrinking is the player's own doing and they watched it happen,
  // whereas an arrival is the one thing that occurs while they are looking somewhere else.
  if (waiting > announcedWildCount) el('announce').textContent = state.wild.waitingText
  announcedWildCount = waiting

  for (const id of PANEL_TABS) {
    el(id).hidden = id !== tab
    const button = el(`tab-${id}`)
    button.setAttribute('aria-selected', String(id === tab))
    button.setAttribute('tabindex', id === tab ? '0' : '-1')
    // The label is localised in the core; here it becomes the hover text and the accessible
    // name, because the visible tab is an icon.
    const label = state.strings.tabs[id]
    button.title = label
    button.setAttribute('aria-label', label)
  }
  vscode.setState({ tab, dexSegment, dexSelected })

  if (scroller !== null && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop

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
    invalidate('dex')
    render()
    return
  }
  if (target.closest('[data-dex-close]') !== null) {
    dexSelected = undefined
    invalidate('dex')
    render()
    return
  }
  const ownedChip = target.closest('[data-dex-owned]')
  if (ownedChip !== null) {
    dexOwnedOnly = !dexOwnedOnly
    invalidate('dex')
    render()
    return
  }
  const logChip = target.closest('[data-dex-filter]')
  if (logChip !== null) {
    dexLogFilter = (logChip as HTMLElement).dataset['dexFilter'] ?? 'all'
    invalidate('dex')
    render()
    return
  }
  const dexCell = target.closest('[data-dex]')
  if (dexCell !== null) {
    const id = Number((dexCell as HTMLElement).dataset['dex'])
    // Clicking the open one closes it — the card has a ✕, but this is the gesture people try.
    dexSelected = Number.isInteger(id) && id !== dexSelected ? id : undefined
    invalidate('dex')
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
    invalidate('home')
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
  if (target.closest('[data-open-panel]') !== null) {
    vscode.postMessage({ type: 'openPanel' })
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

/**
 * Live filtering as the query is typed.
 *
 * The grid is rebuilt around the input, which throws focus and the caret away with it, so both
 * are put back. Cheap enough to do on every keystroke now that a repaint touches one tab.
 */
function applyDexQuery(field: HTMLInputElement): void {
  const caret = field.selectionStart
  dexQuery = field.value
  invalidate('dex')
  render()
  const restored = document.getElementById('dex-search') as HTMLInputElement | null
  if (restored === null) return
  restored.focus()
  if (caret !== null) restored.setSelectionRange(caret, caret)
}

document.addEventListener('input', (event) => {
  const target = event.target as HTMLElement
  if (target.id !== 'dex-search') return
  // Rebuilding the field mid-composition destroys the IME state with it, so in ko/ja — two of
  // the four languages this ships in — a name could never be typed at all. The composition's
  // own end event below is what runs the filter for those.
  if ((event as InputEvent).isComposing) return
  applyDexQuery(target as HTMLInputElement)
})

document.addEventListener('compositionend', (event) => {
  const target = event.target as HTMLElement
  if (target.id !== 'dex-search') return
  applyDexQuery(target as HTMLInputElement)
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

/**
 * Arrow keys move between tabs.
 *
 * Not decoration: `render` gives the strip a roving tabindex, so without this Tab reaches the
 * selected tab and the other five become unreachable by keyboard entirely. Roving tabindex and
 * arrow keys are one mechanism — shipping half of it is worse than shipping neither.
 *
 * Selection follows focus, which is the right pattern now that showing a tab paints only that
 * tab. Hidden tabs (Dev, outside dev mode) are skipped rather than focused into nothing.
 */
document.addEventListener('keydown', (event) => {
  const button = (event.target as HTMLElement | null)?.closest?.('[role="tab"]')
  if (button == null) return
  const order = PANEL_TABS.filter((id) => !el(`tab-${id}`).hidden)
  const from = order.indexOf((button as HTMLElement).dataset['tab'] as TabID)
  if (from === -1) return

  let to = from
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') to = from + 1
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') to = from - 1
  else if (event.key === 'Home') to = 0
  else if (event.key === 'End') to = order.length - 1
  else return

  event.preventDefault()
  const target = order[(to + order.length) % order.length]
  if (target === undefined) return
  tab = target
  render()
  el(`tab-${target}`).focus()
})

// Arrow keys walk the Pokédex grid (roving tabindex: the cells share one tab stop). The column
// count comes from the rendered grid, so it stays honest across every width breakpoint.
document.addEventListener('keydown', (event) => {
  const cell = (event.target as HTMLElement | null)?.closest?.('.dex [data-dex]')
  if (cell == null) return
  const grid = cell.parentElement
  if (grid === null) return

  let delta = 0
  if (event.key === 'ArrowRight') delta = 1
  else if (event.key === 'ArrowLeft') delta = -1
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length
    delta = event.key === 'ArrowDown' ? columns : -columns
  } else {
    return
  }
  event.preventDefault()

  const cells = Array.from(grid.querySelectorAll<HTMLElement>('[data-dex]'))
  const next = cells[cells.indexOf(cell as HTMLElement) + delta]
  if (next === undefined) return
  ;(cell as HTMLElement).tabIndex = -1
  next.tabIndex = 0
  next.focus()
  next.scrollIntoView({ block: 'nearest' })
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
      // Idle refreshes usually deliver a byte-identical state; rebuilding the whole DOM for
      // them made the page jump under the reader every two minutes — worst four screens deep
      // into the Pokédex. One string compare (~50KB, every ~2min) is far cheaper than a paint.
      const incoming = JSON.stringify(event.data.state)
      if (incoming === lastRenderedState) return
      applyState(event.data.state, incoming)
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
const saved = vscode.getState() as
  { tab?: string; dexSegment?: DexSegment; dexSelected?: number } | undefined
// Validated, not cast: a session serialised before a tab was removed (the old Wild tab) would
// otherwise restore into a tab that no longer exists and hide every section.
if (saved?.tab !== undefined && (PANEL_TABS as readonly string[]).includes(saved.tab)) {
  tab = saved.tab as TabID
}
if (saved?.dexSegment !== undefined) dexSegment = saved.dexSegment
if (
  typeof saved?.dexSelected === 'number' &&
  Number.isInteger(saved.dexSelected) &&
  saved.dexSelected >= 1 &&
  saved.dexSelected <= ANIMATED_SPRITE_MAX
) {
  dexSelected = saved.dexSelected
}
if (document.body.classList.contains('compact')) tab = 'home'

// Until the first state arrives the page is blank, and on a first-ever install that can last
// the whole cold scan. English literal by necessity: the localised strings live in the state
// this placeholder is waiting for. It is replaced by the first render.
if (current === undefined) {
  el('home').innerHTML = '<p class="empty">Reading your local AI usage…</p>'
}

vscode.postMessage({ type: 'ready' })
