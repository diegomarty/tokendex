/**
 * Webview script. Runs in the panel's isolated context, so it has no access to Node, the
 * filesystem or the core modules — everything it renders arrives pre-formatted in the
 * snapshot, and every action is a message.
 *
 * That is the same rule the status bar follows: the UI never re-derives a number. A second
 * formatting path would be a second source of truth that drifts.
 */

import type {
  PanelLineItem,
  PanelShopAction,
  PanelState,
  PanelEncounterResult,
  PanelDexSpecies,
  PanelMoodMeter,
  PanelWildEncounter,
  PanelWalletChange,
} from './protocol.js'
import { PANEL_TABS, type PanelTabID } from './shell.js'
import {
  ANIMATED_SPRITE_MAX,
  itemSpriteIsSheet,
  itemSpriteURL,
  sceneSpriteURL,
  spriteURL,
  trainerURL,
} from './sprite.js'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

const vscode = acquireVsCodeApi()

/** One list for the skeleton, the renderers and the restore guard — shell.ts owns it. */
type TabID = PanelTabID
type DexSegment = 'species' | 'shiny' | 'log'
const DEX_SEGMENTS: readonly DexSegment[] = ['species', 'shiny', 'log']
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
/**
 * A catch's news, shown over the scene like a level-up once the catch animation is over. Kept
 * as view state because the scene is rebuilt right after (the caught Pokémon leaves the stage);
 * `played` stops the entrance from replaying on every later paint.
 */
let catchBanner:
  (NonNullable<PanelEncounterResult['catchNews']> & { until: number; played: boolean }) | undefined
let catchBannerTimer: ReturnType<typeof setTimeout> | undefined
/** How long the banner stays: long enough to read two lines, short enough not to linger. */
const CATCH_BANNER_MS = 2800
/** A new species plays its reveal and its bar filling first (~1.9 s), so it stays longer. */
const NEW_SPECIES_BANNER_MS = 4200
/** Which level of the battle menu is open, and for which encounter. View state only. */
let wildMenu: 'main' | 'bag' = 'main'
/** The starter picked on the first-run screen, before it is confirmed. View state only. */
let starterSelected: number | undefined
/** The bag's open pocket and selected item. View state only. */
let bagPocket: 'balls' | 'berries' | 'items' | undefined
let bagSelected: string | undefined
let stagedID: string | undefined
/**
 * The encounter whose entrance has already played. Home is repainted wholesale — by every state
 * push, and it used to be by every menu click — and the entrance hung off the scene's own class,
 * so each repaint walked the same Pokémon back on stage as if it had just appeared. It plays
 * once per encounter now: only a Pokémon this panel has not shown yet gets the `entering` class.
 */
let enteredID: string | undefined
/** The last balance change seen, so a re-sent state never replays it. See `noteWalletChange`. */
let seenWalletChangeID: number | undefined
let walletPrimed = false
let pendingWallet: PanelWalletChange | undefined
/** As `wallet-float` in styles.css. */
const WALLET_CHANGE_MS = 1600
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

  // The figure beside the bar is that bar's own — EXP, as on the scene's plate — so the number
  // and the fill can never tell two stories.
  return `
      <h1 class="hero-name">${escapeHTML(name)}${c.isShiny ? ' <span class="shiny-mark" title="shiny">✨</span>' : ''}</h1>
      ${meta === '' ? '' : `<div class="hero-meta">${meta}</div>`}
      <div class="progress">
        <div class="meta">
          <span>${escapeHTML(c.toNextText)}</span>
          <span class="pct">${c.expPercent}%</span>
        </div>
        <div class="bar"><i data-fill="${c.expPercent}"></i></div>
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
      ? `<img class="egg" src="${itemSpriteURL('egg')}" alt="" data-emoji-fallback="🥚">`
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

/** A headline figure: the label above, the number large, its cost beneath. */
function statTile(label: string, value: string, note: string, exact: string): string {
  return `<div class="stat-tile">
      <span class="label">${escapeHTML(label)}</span>
      <span class="value" title="${escapeHTML(exact)}">${escapeHTML(value)}</span>
      <span class="note">${escapeHTML(note)}</span>
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
  // A brand-new game asks for a starter before anything else; the card is a glance, so it only
  // says so and opens the panel.
  const game =
    state.starters !== undefined
      ? compact
        ? `<button class="wild-strip" data-open-panel>${escapeHTML(state.strings.starterTitle)}</button>`
        : renderStarters(state, state.starters)
      : compact
        ? renderCompanion(state) + renderWildStrip(state)
        : renderGame(state) + renderEggs(state)

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

  // The wallet heads the page as the lid of a Pokédex: the name on the red casing, the balance on
  // its screen. It is the currency every action on this screen is paid in, and the number that
  // moves when an attack takes tokens or a scan brings some in. The Explorer card is a glance and
  // keeps the plain row.
  const wallet = compact
    ? ''
    : `<div class="wallet-bar">
        <span class="brand" role="img" aria-label="Tokendex">
          <span class="brand-lens"></span>
          <span class="brand-leds"><i></i><i></i><i></i></span>
          <span class="brand-name">TOKEN<b>DEX</b></span>
        </span>
        <button class="wallet-badge" data-tab="shop" title="${escapeHTML(state.strings.spendable)} · ${escapeHTML(state.strings.buy)}"
          aria-label="${escapeHTML(state.strings.spendable)}: ${escapeHTML(state.spendableText)}">
          <span class="wallet-value">${escapeHTML(state.spendableText)}</span>
          <img class="coin" src="${itemSpriteURL('nugget')}" alt="" data-emoji-fallback="🪙">
        </button>
      </div>`
  const walletRow = compact
    ? `<div class="row-stat">
        <span class="label">${escapeHTML(state.strings.spendable)}</span>
        <span class="value">${escapeHTML(state.spendableText)}</span>
        <span class="note">${shopLink}</span>
      </div>`
    : ''

  return `
    ${wallet}
    <div class="game">${game}</div>
    <div class="stats">
      <div class="stat-tiles">
        ${statTile(state.strings.today, t.todayText, t.todayCostText, t.todayExactText)}
        ${statTile(state.strings.month, t.monthText, t.monthCostText, t.monthExactText)}
      </div>
      ${walletRow}
    </div>
    ${renderLimits(state)}
    ${breakdown}`
}

// MARK: - Starters and the egg stock

/**
 * The first-run screen: the fifteen starters, a generation to a row, each on the colour of its
 * type. Picking one only selects it; the button under the grid confirms — a starter is the one
 * choice of the game made before there is anything to compare it with.
 */
function renderStarters(state: PanelState, starters: NonNullable<PanelState['starters']>): string {
  const picked = starters.find((s) => s.id === starterSelected)
  const cells = starters
    .map(
      (s) => `<button class="starter type-${escapeHTML(s.types[0] ?? 'normal')}" data-starter="${s.id}"
          aria-pressed="${s.id === starterSelected}" aria-label="${escapeHTML(s.name)}">
        <img src="${spriteURL(s.id, false, true)}" alt="" data-fallback="${spriteURL(s.id, false, false)}">
        <span class="starter-name">${escapeHTML(s.name)}</span>
      </button>`,
    )
    .join('')
  return `<section class="starters">
      <h2 class="starters-title">${escapeHTML(state.strings.starterTitle)}</h2>
      <p class="starters-prompt">${escapeHTML(state.strings.starterPrompt)}</p>
      <div class="starter-grid" role="group" aria-label="${escapeHTML(state.strings.starterTitle)}">${cells}</div>
      <button class="action starter-confirm" data-choose-starter="${picked?.id ?? ''}" ${picked === undefined ? 'disabled' : ''}>
        ${escapeHTML(picked === undefined ? state.strings.chooseCompanion : `${state.strings.chooseCompanion} · ${picked.name}`)}
      </button>
    </section>`
}

/**
 * The egg stock under the scene: one slot per egg the stock can hold, filled for each one held,
 * and the button that incubates one (or resumes the one set aside). Nothing to show without a
 * companion on stage — then the egg is the scene.
 */
function renderEggs(state: PanelState): string {
  const eggs = state.eggs
  if (state.companion?.speciesID === undefined) return ''
  if (eggs.count === 0 && eggs.incubateText === undefined) return ''
  const slots = Array.from(
    { length: eggs.max },
    (_, i) =>
      `<span class="egg-slot${i < eggs.count ? ' full' : ''}">${i < eggs.count ? `<img class="egg-sprite" src="${itemSpriteURL('egg')}" alt="">` : ''}</span>`,
  ).join('')
  return `<div class="egg-stock${eggs.paused ? ' paused' : ''}">
      <span class="egg-slots" role="img" aria-label="${escapeHTML(eggs.stockText)}">${slots}</span>
      <span class="egg-text">${escapeHTML(eggs.stockText)}</span>
      ${eggs.incubateText === undefined ? '' : `<button class="action egg-incubate" data-incubate>${escapeHTML(eggs.incubateText)}</button>`}
    </div>`
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

/**
 * Starts a turn: a ball or a berry leaves your hand. The same arc for both — what differs is what
 * happens when it lands, which the reply decides.
 */
function beginTurn(kind: 'throw' | 'feed', encounterID: string, item: string, sprite: string): void {
  if (throwing !== undefined) return // one thing in the air at a time
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
    if (kind === 'feed') scene.classList.add('feeding')
  }

  if (kind === 'throw') vscode.postMessage({ type: 'throw', encounterID, ball: item })
  else vscode.postMessage({ type: 'feed', encounterID, berry: item })
}

async function playThrow(result: PanelEncounterResult): Promise<void> {
  const flight = throwing
  const scene = document.querySelector<HTMLElement>('.wild-scene')
  if (flight === undefined) return
  if (scene === null || motionOff() || result.animation === 'none') {
    finishThrow(result)
    return
  }

  // Let the arc that started on click land first.
  await sleep(Math.max(0, ARC_MS - (performance.now() - flight.startedAt)))
  scene.classList.remove('throwing')

  if (result.animation === 'feed') {
    // A berry is not absorbed and does not wobble: it lands, and the Pokémon answers.
    scene.classList.remove('feeding')
    scene.classList.add(result.kind === 'fled' ? 'fled-out' : 'fed')
    if (result.attacked) await strikeBack(scene)
    const line = document.querySelector<HTMLElement>('.wild-result')
    if (line !== null) line.textContent = result.resultText
    await sleep(RESULT_HOLD_MS)
    finishThrow(result)
    return
  }

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
    if (result.attacked) await strikeBack(scene)
  }

  // The dialog box sits under the scene, so it is looked up on the page, not inside the scene.
  const line = document.querySelector<HTMLElement>('.wild-result')
  if (line !== null) line.textContent = result.resultText

  await sleep(RESULT_HOLD_MS)
  finishThrow(result)
}

/** The catch banner over the scene, while it lasts; its entrance plays on the first paint only. */
function renderCatchBanner(): string {
  const banner = catchBanner
  if (banner === undefined || performance.now() >= banner.until) return ''
  const entering = banner.played ? '' : ' entering'
  banner.played = true
  // Hidden from assistive tech: the result line under the scene, which is live, says the same.
  const reg = banner.registration
  if (reg === undefined) {
    return `<div class="catch-banner${banner.isNew ? ' new' : ''}${entering}" aria-hidden="true">
      <span class="catch-headline">${escapeHTML(banner.headline)}</span>
      <span class="catch-detail">${escapeHTML(banner.detail)}</span>
    </div>`
  }
  // A new species, shown as the Pokédex shows a new entry: the device's red casing with its
  // lens, lights and the entry's number, the Pokémon on the screen, and its registration bar
  // with the share just earned marked as a span [from, to] — placed by `placeSpans` after the
  // paint, since the CSP allows no inline style.
  return `<div class="catch-banner new rich${entering}" aria-hidden="true">
      <span class="catch-shine"></span>
      <div class="dexcard-top">
        <span class="brand-lens"></span>
        <span class="brand-leds"><i></i><i></i><i></i></span>
        <span class="dexcard-num">${dexNumber(reg.speciesID)}</span>
      </div>
      <div class="dexcard-body">
        <span class="catch-mon-wrap">
          <img class="catch-mon" src="${sceneSpriteURL(reg.speciesID, false)}" alt=""
               data-fallback="${spriteURL(reg.speciesID, false, false)}">
        </span>
        <div class="catch-body">
          <span class="catch-headline">${escapeHTML(banner.headline)}</span>
          <div class="catch-reg">
            <div class="catch-reg-bar">
              <i class="base" data-span-from="0" data-span-to="${reg.fromPercent}"></i>
              <i class="gain" data-span-from="${reg.fromPercent}" data-span-to="${reg.toPercent}"><b></b></i>
            </div>
          </div>
          <span class="catch-detail">${escapeHTML(banner.detail)}</span>
        </div>
      </div>
    </div>`
}

/** It lunged at you: a short lunge and a red flash. Its duration is mirrored in styles.css. */
const STRIKE_MS = 500
async function strikeBack(scene: HTMLElement): Promise<void> {
  scene.classList.add('attacked')
  await sleep(STRIKE_MS)
  scene.classList.remove('attacked')
}

/** Ends the flight: applies whatever state arrived meanwhile and repaints. */
function finishThrow(result?: PanelEncounterResult): void {
  const flight = throwing
  if (flight === undefined) return
  clearTimeout(flight.deadline)
  throwing = undefined
  if (result !== undefined && result.resultText !== '') {
    wildResult = { text: result.resultText, encounterID: result.encounterID }
  }
  if (result?.catchNews !== undefined) {
    const lasts = result.catchNews.registration === undefined ? CATCH_BANNER_MS : NEW_SPECIES_BANNER_MS
    // One banner at a time, with its own timer: a catch soon after another replaces the banner,
    // and the earlier timer must not take the new one down with it.
    clearTimeout(catchBannerTimer)
    const banner = { ...result.catchNews, until: performance.now() + lasts, played: false }
    catchBanner = banner
    catchBannerTimer = setTimeout(() => {
      if (catchBanner !== banner) return
      catchBanner = undefined
      document.querySelector('.catch-banner')?.remove()
    }, lasts)
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

  // A new Pokémon on stage starts at the top of the menu; the same one keeps whatever submenu the
  // player was in, so throwing ball after ball is one click each, not two.
  if (selected?.id !== stagedID) {
    stagedID = selected?.id
    wildMenu = 'main'
  }

  // The last turn's line stays in the dialog box until the next action, as the games leave it:
  // "Gotcha! Dratini was caught!" is still on screen while the next Pokémon steps up. A line in a
  // box that is plainly a transcript cannot be mistaken for the newcomer's.
  const resultLine = wildResult?.text

  // `celebrating` is the core's 4-6s hatch/evolve/graduate window finally reaching the panel.
  const celebrate = c?.celebrating === true ? ' celebrate' : ''
  const follower =
    c === undefined
      ? ''
      : c.speciesID === undefined
        ? `<div class="companion-mon${celebrate}"><img class="egg-small" src="${itemSpriteURL('egg')}" alt="" data-emoji-fallback="🥚"></div>`
        : `<div class="companion-mon${celebrate}"><img class="bob" src="${sceneSpriteURL(c.speciesID, c.isShiny)}" alt=""
             data-fallback="${spriteURL(c.speciesID, c.isShiny, false)}"></div>`

  // The ground says what is coming before the name does: a beach for a water type, a volcano for
  // a fire one. The core picks the token — its type, or its rarity when the type is unknown.
  const terrain = selected === undefined ? 'home' : selected.terrain
  const wildPart =
    selected === undefined
      ? ''
      : `
      ${wildPlate(selected)}
      <div class="pad pad-wild" aria-hidden="true"></div>
      <div class="wild-mon">
        <img class="mon bob" src="${sceneSpriteURL(selected.speciesID, selected.isShiny)}" alt=""
             data-fallback="${spriteURL(selected.speciesID, selected.isShiny, false)}">
      </div>
      <div class="throw-ball"><span class="throw-ball-y"><img alt=""></span></div>`

  const entering = selected !== undefined && selected.id !== enteredID
  enteredID = selected?.id
  const scene = `
    <div class="wild-scene${selected === undefined ? '' : ` has-wild rarity-${escapeHTML(selected.rarity)}`}${entering ? ' entering' : ''}" data-terrain="${escapeHTML(terrain)}" data-staged="${escapeHTML(selected?.id ?? '')}">
      ${wildPart}
      <div class="pad pad-player" aria-hidden="true"></div>
      <img class="trainer" src="${trainerURL(state.trainerID)}" alt="">
      ${follower}
      ${playerPlate(state)}
      ${renderCatchBanner()}
    </div>`

  // The dialog box: what just happened, or the question the games ask. Idle, it carries the
  // road to the next encounter instead — the one thing worth reading while nothing is on stage.
  // In battle it is one slim line over the menu: what a miss risks moved down beside the balls,
  // where the throw is decided, and the Razz Berry and stolen tokens are statuses on the plate.
  const dialogLines =
    selected === undefined
      ? `<div class="progress next-encounter">
          <div class="meta">
            <span>${escapeHTML(wild.nextText)}</span>
            <span class="pct">${wild.progressPercent}%</span>
          </div>
          <div class="bar"><i data-fill="${wild.progressPercent}"></i></div>
          ${streakRow(wild.streak)}
        </div>`
      : ''
  const prompt = selected === undefined ? undefined : strings.commandPrompt
  const dialog = `
    <div class="dialog${selected === undefined ? '' : ' slim'}">
      <p class="dialog-text wild-result${(resultLine ?? prompt) ? '' : ' empty'}" aria-live="polite">${escapeHTML(resultLine ?? prompt ?? '')}</p>
      ${dialogLines}
    </div>`

  if (selected === undefined) {
    const line = c === undefined ? '' : renderLine(c.line)
    return `<div class="battle">${scene}${dialog}${line === '' ? '' : `<div class="evo-strip">${line}</div>`}</div>
      ${renderFindsAndTrail(wild)}`
  }

  return `<div class="battle">${scene}${dialog}${commandMenu(state, selected)}</div>
    ${renderFindsAndTrail(wild)}`
}

/** The glyph beside each mood gauge: a flame for anger, a pulse for nerves, a heart for trust. */
const MOOD_ICONS: Record<PanelMoodMeter['key'], string> = {
  anger: 'flame',
  nervousness: 'pulse',
  trust: 'heart',
}

/**
 * The wild Pokémon's plate, top left as in the games: name, rarity, character and three gauges
 * where the games put HP. The gauges are anger, nerves and trust — drawn, never measured, here:
 * the core's `tone` picks how loudly each one shows, never a threshold of the webview's own.
 */
function wildPlate(encounter: PanelWildEncounter): string {
  // All three low says one thing — "calm" — so it takes one line: the gauges side by side, the
  // labels kept for the tooltip and the screen reader. Any of them rising opens the full rows.
  const calm = encounter.meters.every((m) => m.tone === 'low')
  const meters = encounter.meters
    .map(
      (
        m,
      ) => `<div class="meter ${escapeHTML(m.key)}" data-tone="${escapeHTML(m.tone)}" title="${escapeHTML(m.label)}">
        <i class="codicon codicon-${MOOD_ICONS[m.key]} meter-icon" aria-hidden="true"></i>
        <span class="meter-label">${escapeHTML(m.label)}</span>
        <div class="bar gauge" aria-label="${escapeHTML(m.label)}"><i data-fill="${Math.max(0, Math.min(100, Math.round(m.percent)))}"></i></div>
      </div>`,
    )
    .join('')
  return `<div class="plate plate-wild">
      <div class="plate-head">
        <span class="plate-name">${escapeHTML(encounter.name)}${encounter.isShiny ? ' <span class="shiny-mark">✨</span>' : ''}</span>
        ${
          // Already yours: the games mark it with a Poké Ball beside the name.
          encounter.ownedText === undefined
            ? ''
            : `<span class="owned-ball" role="img" title="${escapeHTML(encounter.ownedText)}" aria-label="${escapeHTML(encounter.ownedText)}"></span>`
        }
        ${
          // Nature and traits are flavour more than a decision, so they wait behind a glyph by the
          // name instead of taking a line of the plate.
          encounter.temperamentText === undefined
            ? ''
            : `<i class="codicon codicon-info plate-info" role="img" tabindex="0" title="${escapeHTML(encounter.temperamentText)}" aria-label="${escapeHTML(encounter.temperamentText)}"></i>`
        }
        <span class="rarity-badge ${escapeHTML(encounter.rarity)}">${escapeHTML(encounter.rarityText)}</span>
      </div>

      <div class="meters${calm ? ' calm' : ''}">${meters}</div>
      ${
        (encounter.statuses ?? []).length === 0
          ? ''
          : `<div class="statuses">${(encounter.statuses ?? [])
              .map(
                (st) =>
                  `<span class="status ${escapeHTML(st.key)}" title="${escapeHTML(st.title)}" aria-label="${escapeHTML(st.title)}">${escapeHTML(st.text)}</span>`,
              )
              .join('')}</div>`
      }
    </div>`
}

/** The glyph before each reaction a miss risks: running off, or striking back. */
const RISK_ICONS: Record<PanelWildEncounter['risk']['items'][number]['key'], string> = {
  flee: 'run-all',
  attack: 'zap',
}

/**
 * Your side's plate, bottom right: the companion and its road to the next evolution, drawn as
 * the wild plate draws its mood — a gauge of cells led by its glyph, under the same rule.
 */
function playerPlate(state: PanelState): string {
  const c = state.companion
  if (c === undefined) return ''
  // The registration bar is the figure; a still-hatching egg has none and shows its EXP instead.
  const percent = c.registrationPercent ?? c.expPercent
  const meta = [c.stageText, c.rarityText, c.natureText].filter(
    (part): part is string => part !== undefined && part !== '',
  )
  return `<div class="plate plate-player">
      <div class="plate-head">
        <span class="plate-name">${escapeHTML(c.name ?? state.strings.incubating)}${c.isShiny ? ' <span class="shiny-mark">✨</span>' : ''}</span>
        ${
          // Stage, rarity and nature, behind the same glyph as the wild plate's temperament:
          // what the plate is for is the road to the next stage, not the card's details.
          meta.length === 0
            ? ''
            : `<i class="codicon codicon-info plate-info" role="img" tabindex="0" title="${escapeHTML(meta.join(' · '))}" aria-label="${escapeHTML(meta.join(' · '))}"></i>`
        }
        <span class="plate-pct">${percent}%</span>
      </div>
      ${expBar(c)}
    </div>`
}

/**
 * The EXP bar the games draw under a Pokémon's HP: a dark track with "EXP" at its left and the
 * blue fill, and under it — in the same blue — what it has of the stage and what is left. Every
 * figure is the core's; "EXP" is the games' own glyph, printed untranslated in every version, so
 * it is decoration and the bar is named by the figures instead.
 */
function expBar(c: NonNullable<PanelState['companion']>): string {
  const figures = [c.expText, c.expLeftText].filter((t): t is string => t !== undefined && t !== '')
  const label = figures.length === 0 ? c.toNextText : figures.join(' · ')
  return `<div class="exp-meter">
      <div class="exp-line">
        <span class="exp-label" aria-hidden="true">EXP</span>
        <div class="bar exp-track" aria-label="${escapeHTML(label)}"><i data-fill="${c.expPercent}"></i></div>
      </div>
      ${
        figures.length === 0
          ? `<div class="exp-figures"><span>${escapeHTML(c.toNextText)}</span></div>`
          : `<div class="exp-figures" aria-hidden="true">${c.expText === undefined ? '' : `<span>${escapeHTML(c.expText)}</span>`}${c.expLeftText === undefined ? '' : `<span class="exp-left">${escapeHTML(c.expLeftText)}</span>`}</div>`
      }
    </div>`
}

/**
 * The battle menu under the dialog box. The balls are the menu: throwing one is what an
 * encounter is mostly made of, so it is one click, not two. Under them, the Bag — everything
 * else usable in battle, berries today and whatever is added later — and Run. Which level is
 * open is view state — it never reaches the host, and a new Pokémon on stage always starts back
 * at the top.
 */
function commandMenu(state: PanelState, encounter: PanelWildEncounter): string {
  const encounterID = encounter.id
  const wild = state.wild
  const strings = state.strings
  const noBalls = wild.balls.every((b) => b.count === 0)

  if (wildMenu === 'bag') {
    const berries = wild.berries
      .map(
        (berry) => `<button class="command item" data-feed="${escapeHTML(encounterID)}"
              data-berry="${escapeHTML(berry.kind)}" data-sprite="${escapeHTML(berry.sprite)}"
              aria-label="${escapeHTML(berry.name)} ×${berry.count}. ${escapeHTML(berry.effectText)}">
          <img src="${itemSpriteURL(berry.sprite)}" alt="">
          <span class="command-name">${escapeHTML(berry.name)}<small>${escapeHTML(berry.effectText)}</small></span>
          <span class="command-count">×${berry.count}</span>
        </button>`,
      )
      .join('')
    return `<div class="commands list" role="group" aria-label="${escapeHTML(strings.tabs.bag)}">
        ${berries}
        <button class="command back" data-menu="main">${escapeHTML(strings.commandBack)}</button>
      </div>`
  }

  // An empty ball is a way to the shop rather than a dead tile: `data-tab` is handled before
  // `data-throw`, so the click opens the shop and can never throw a ball that is not there.
  const balls = wild.balls
    .map((ball) => {
      const none = ball.count === 0
      const label = `${escapeHTML(ball.name)} ×${ball.count}${ball.oddsText === undefined ? '' : `, ${escapeHTML(ball.oddsText)}`}`
      return `<button class="command ball${none ? ' none' : ''}" data-throw="${escapeHTML(encounterID)}"
            data-ball="${escapeHTML(ball.kind)}" data-sprite="${escapeHTML(ball.sprite)}"
            ${none ? 'data-tab="shop"' : ''} title="${none ? `${escapeHTML(ball.name)} · ${escapeHTML(strings.getBalls)}` : escapeHTML(ball.name)}"
            aria-label="${none ? `${label}. ${escapeHTML(strings.getBalls)}` : label}">
        <span class="ball-sprite"><img src="${itemSpriteURL(ball.sprite)}" alt="">${
          none
            ? '<span class="ball-count shop"><i class="codicon codicon-add" aria-hidden="true"></i></span>'
            : `<span class="ball-count">×${ball.count}</span>`
        }</span>
        <span class="ball-odds">${ball.oddsText === undefined ? '' : escapeHTML(ball.oddsText)}</span>
        <span class="ball-name">${escapeHTML(ball.name)}</span>
      </button>`
    })
    .join('')
  // At the end of the Bag and Run line: with an empty rack, the way to the shop — the moment
  // of highest purchase intent; otherwise how many more are waiting, when any are.
  const note = noBalls
    ? `<button class="command info" data-tab="shop">${escapeHTML(strings.getBalls)}</button>`
    : wild.moreText !== undefined
      ? `<p class="command info queue" title="${escapeHTML(wild.waitingText)}">
          <i class="codicon codicon-layers" aria-hidden="true"></i>${escapeHTML(wild.moreText)}</p>`
      : ''
  // What a miss risks, over the balls it is the price of.
  const risk = `<p class="dialog-note risk" title="${escapeHTML(encounter.riskText)}" aria-label="${escapeHTML(encounter.riskText)}">
      <span class="risk-heading">${escapeHTML(encounter.risk.heading)}</span>${encounter.risk.items
        .map(
          (item) =>
            `<span class="risk-item ${escapeHTML(item.key)}"><i class="codicon codicon-${RISK_ICONS[item.key]}" aria-hidden="true"></i>${escapeHTML(item.text)}</span>`,
        )
        .join('')}
    </p>`
  return `<div class="commands list" role="group" aria-label="${escapeHTML(strings.commandBalls)}">
      ${risk}
      <div class="ball-row">${balls}</div>
      <div class="command-row">
        <button class="command" data-menu="bag" ${wild.berries.length === 0 ? 'disabled' : ''}>
          <i class="codicon codicon-package command-icon" aria-hidden="true"></i>${escapeHTML(strings.tabs.bag)}</button>
        <button class="command" data-run="${escapeHTML(encounterID)}">
          <i class="codicon codicon-run-all command-icon" aria-hidden="true"></i>${escapeHTML(strings.run)}</button>
        ${note}
      </div>
    </div>`
}

/** Items lying in the wild area, and legendaries that can still be tracked back. */
function renderFindsAndTrail(wild: PanelState['wild']): string {
  const finds =
    wild.finds.length === 0
      ? ''
      : `<section class="wild-finds">
        <div class="finds-head">
          <h2 class="section">${escapeHTML(wild.findsText ?? '')}</h2>
          <button class="link" data-collect-all>${escapeHTML(wild.collectAllText)}</button>
        </div>
        <div class="finds-row">${wild.finds
          .map(
            (
              find,
            ) => `<button class="find rarity-${escapeHTML(find.rarity)}" data-collect="${escapeHTML(find.id)}"
                title="${escapeHTML(find.label)} — ${escapeHTML(find.rarityText)}" aria-label="${escapeHTML(find.label)}">
              ${find.sprite === undefined ? `<span class="emoji">${find.emoji}</span>` : `<img src="${itemSpriteURL(find.sprite)}" alt="">`}
              ${find.count > 1 ? `<span class="count">×${find.count}</span>` : ''}
            </button>`,
          )
          .join('')}</div>
      </section>`
  const trail =
    wild.trail.length === 0
      ? ''
      : `<section class="wild-trail">
        <h2 class="section">${escapeHTML(wild.trailTitle)}</h2>
        ${wild.trail
          .map(
            (entry) => `<div class="trail-row">
              <img src="${spriteURL(entry.speciesID, entry.isShiny, false)}" alt="">
              <span class="body">
                <span class="title">${escapeHTML(entry.name)}${entry.isShiny ? ' <span class="shiny-mark">✨</span>' : ''}</span>
                <span class="desc">${escapeHTML(entry.expiresText)}</span>
              </span>
              <button class="action" data-track="${escapeHTML(entry.id)}" data-title="${escapeHTML(entry.confirmTitle)}"
                      data-price="${escapeHTML(entry.priceText)}" data-confirm="${escapeHTML(entry.confirmLabel)}"
                      ${entry.enabled ? '' : 'disabled'}>${escapeHTML(entry.trackText)}</button>
            </div>`,
          )
          .join('')}
      </section>`
  return `${finds}${trail}`
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
  const sheet = itemSpriteIsSheet(sprite) ? ' class="sheet"' : ''
  return `<div class="icon"><img${sheet} src="${itemSpriteURL(sprite)}" alt="" data-emoji-fallback="${escapeHTML(emoji)}"></div>`
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
  withWord: boolean,
): string {
  // Dimmed and italic, never struck through: a line through a price reads as a discount, and
  // this row has a real one two millimetres away.
  const cant = !action.enabled && !item.owned ? ' cant' : ''
  // The saving is pinned small to the corner of the price it discounts, so it reads as that
  // price's and no other's.
  const save =
    action.saveText === undefined ? '' : `<span class="save">${escapeHTML(action.saveText)}</span>`
  const price = withPrice
    ? `<span class="price-tag"><span class="cost${cant}">${escapeHTML(action.priceText)}<img class="coin" src="${itemSpriteURL('nugget')}" alt=""></span>${save}</span>`
    : ''
  return `<button class="action${withPrice ? ' priced' : ''}" data-buy="${escapeHTML(action.id)}"
                data-title="${escapeHTML(action.confirmTitle)}" data-price="${escapeHTML(action.priceText)}"
                data-confirm="${escapeHTML(state.strings.buy)}"
                aria-label="${escapeHTML(action.label)}"
                ${action.enabled ? '' : 'disabled'}>
          ${withWord ? `<span class="verb">${escapeHTML(action.text)}</span>` : ''}${price}
        </button>`
}

function renderShop(state: PanelState): string {
  if (state.shop.length === 0) return `<p class="empty">${escapeHTML(state.strings.empty)}</p>`

  /**
   * One shape for every row: the sprite, the name with its figure and sentence, and a column of
   * price tags — each tag the verb (or quantity) and its price on the wallet's own screen, so a
   * price is always read on the button that pays it. A ball's ×1 and ×10 stack in that column
   * instead of taking a line of their own under the name, which is where the shop's height went.
   * A row with one price has no word on its tag — the price on the screen is the button, and the
   * accessible name still says "Buy … for …". Two prices keep their quantities, which are the
   * difference between them. An owned passive's tag has its word and no price: nothing to pay.
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
    return `
      <div class="row shop-item${item.owned ? ' owned' : ''}">
        ${itemIcon(item.sprite, item.emoji)}
        ${body}
        <div class="buys">${item.actions
          .map((a) => shopAction(state, item, a, !item.owned, item.owned || item.actions.length > 1))
          .join('')}</div>
      </div>`
  }

  // The wallet on top: every price below is judged against this number, so making the reader
  // hop back to Home to know it is a dead end.
  // Drawn as the Pokédex lid's screen on Home, so the balance looks the same wherever it is read.
  const wallet = `
    <div class="shop-wallet">
      <span class="label">${escapeHTML(state.strings.spendable)}</span>
      <span class="value">${escapeHTML(state.spendableText)}<img class="coin" src="${itemSpriteURL('nugget')}" alt=""></span>
    </div>`

  // `note` is what every card in the group would otherwise repeat. Only the eggs have one so
  // far, and saying it once is the entire reason they each fit on one line now.
  const groups: { id: PanelState['shop'][number]['group']; title: string; note?: string }[] = [
    { id: 'balls', title: state.strings.shopBalls },
    { id: 'berries', title: state.strings.shopBerries },
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

/**
 * The bag as the games lay it out: pockets across the top, the pocket's items as a list with a
 * cursor, and the selected item's description in the dialog box below — with Use when it can be
 * used from here. Which pocket and which item are view state; the contents all come from the core.
 */
function renderBag(state: PanelState): string {
  if (state.bag.length === 0) return `<p class="empty">${escapeHTML(state.strings.bagEmpty)}</p>`

  const pockets: { id: PanelState['bag'][number]['pocket']; label: string }[] = [
    { id: 'balls', label: state.strings.shopBalls },
    { id: 'berries', label: state.strings.shopBerries },
    { id: 'items', label: state.strings.shopItems },
  ]
  const filled = pockets.filter((p) => state.bag.some((item) => item.pocket === p.id))
  if (bagPocket === undefined || !filled.some((p) => p.id === bagPocket)) bagPocket = filled[0]?.id
  const items = state.bag.filter((item) => item.pocket === bagPocket)
  const selected = items.find((item) => item.id === bagSelected) ?? items[0]
  bagSelected = selected?.id

  const tabs = pockets
    .map((p) => {
      const empty = !filled.some((f) => f.id === p.id)
      return `<button class="pocket" data-pocket="${p.id}" aria-pressed="${p.id === bagPocket}" ${empty ? 'disabled' : ''}>${escapeHTML(p.label)}</button>`
    })
    .join('')
  const rows = items
    .map(
      (
        item,
      ) => `<button class="bag-row" data-bag-select="${escapeHTML(item.id)}" aria-pressed="${item.id === selected?.id}">
        ${itemIcon(item.sprite, item.emoji)}
        <span class="bag-name">${escapeHTML(item.title)}</span>
        <span class="bag-count">×${item.count}</span>
      </button>`,
    )
    .join('')
  const dialog =
    selected === undefined
      ? ''
      : `<div class="dialog bag-dialog">
        <p class="dialog-text">${escapeHTML(selected.description)}</p>
        ${
          selected.usable
            ? `<button class="dialog-action" data-use="${escapeHTML(selected.id)}">${escapeHTML(state.strings.use)}</button>`
            : selected.hint === undefined
              ? ''
              : `<p class="dialog-note">${escapeHTML(selected.hint)}</p>`
        }
      </div>`
  return `<div class="bag">
      <div class="pockets" role="group">${tabs}</div>
      <div class="bag-list">${rows}</div>
      ${dialog}
    </div>`
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

  if (sp === undefined || sp.status === 'seen') {
    return `
    <div class="dex-detail locked">
      <div class="dex-entry-head">
        <span class="num">${dexNumber(dexSelected)}</span>
        <span class="dex-entry-name">?????</span>
        ${close}
      </div>
      <div class="dex-entry-body">
        <div class="portrait"><img src="${spriteURL(dexSelected, false, false)}" alt=""></div>
      </div>
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
      <div class="dex-entry-head">
        <span class="num">${dexNumber(sp.id)}</span>
        <span class="dex-entry-name">${sp.name === `#${sp.id}` ? '' : escapeHTML(sp.name)}${sp.isShiny ? ' <span class="star-inline" title="shiny">★</span>' : ''}</span>
        ${close}
      </div>
      <div class="dex-entry-body">
        <div class="portrait">
          <img src="${spriteURL(sp.id, sp.isShiny, true)}" alt=""
               data-fallback="${spriteURL(sp.id, sp.isShiny, false)}">
        </div>
        <div class="body">
          <span class="rarity-badge ${escapeHTML(sp.rarity)}">${escapeHTML(sp.rarityText)}</span>
          <div class="reg-line">
            <div class="reg-bar${sp.status === 'registered' ? ' full' : ''}"><i data-fill="${sp.percent}"></i></div>
            <span class="desc">${escapeHTML(sp.percentText)}</span>
          </div>
          ${entries}
          ${sp.shinyBar === undefined ? '' : shinySection(sp.id, sp.shinyBar)}
          ${
            sp.isCompanion
              ? `<div class="companion-tag">${escapeHTML(state.strings.companionBadge)}</div>`
              : sp.canChoose
                ? `<button class="action dex-choose" data-companion="${sp.id}">${escapeHTML(state.strings.chooseCompanion)}</button>`
                : ''
          }
        </div>
      </div>
    </div>`
}

/**
 * A registered species' road to its shiny: the gold bar on the device's track, its sentence,
 * and what the wallet can buy of it — the shop's own price tags, because it is the same act of
 * paying tokens for something. Every figure and word is the core's.
 */
function shinySection(speciesID: number, bar: NonNullable<PanelDexSpecies['shinyBar']>): string {
  const boosts = bar.boosts
    .map(
      (b) => `<button class="action priced" data-boost="${speciesID}" data-amount="${b.amount}"
          data-title="${escapeHTML(b.confirmTitle)}" data-price="${escapeHTML(b.priceText)}"
          aria-label="${escapeHTML(b.label)}">
          <span class="verb">${escapeHTML(b.text)}</span>
          <span class="price-tag"><span class="cost">${escapeHTML(b.priceText)}<img class="coin" src="${itemSpriteURL('nugget')}" alt=""></span></span>
        </button>`,
    )
    .join('')
  return `<div class="shiny-section">
      <div class="game-meter on-device tone-shiny">
        <span class="game-meter-glyph" aria-hidden="true">★</span>
        <div class="bar game-meter-track" aria-label="${escapeHTML(bar.text)}"><i data-fill="${bar.percent}"></i></div>
      </div>
      <div class="desc shiny-text">${escapeHTML(bar.text)}</div>
      ${boosts === '' ? '' : `<div class="shiny-boosts">${boosts}</div>`}
      ${bar.boostHint === undefined ? '' : `<div class="desc shiny-hint">${escapeHTML(bar.boostHint)}</div>`}
    </div>`
}

function renderDex(state: PanelState): string {
  const segments = `
    <div class="segments">
      <button class="seg" data-seg="species" aria-selected="${dexSegment === 'species'}">
        ${escapeHTML(state.dexSummary.speciesSegmentText)}
      </button>
      <button class="seg" data-seg="shiny" aria-selected="${dexSegment === 'shiny'}">
        ${escapeHTML(state.dexSummary.shinySegmentText)}
      </button>
      <button class="seg" data-seg="log" aria-selected="${dexSegment === 'log'}">
        ${escapeHTML(state.dexSummary.logSegmentText)}
      </button>
    </div>`

  if (dexSegment === 'species' || dexSegment === 'shiny') {
    // The Shinydex is the same grid seen through the shiny axis: a shiny registered is lit in
    // gold, a registered species shows its shiny bar, anything else is a silhouette.
    const shinydex = dexSegment === 'shiny'
    // The whole huntable pool, silhouettes included: an all-caught-species list reads as an
    // archive, but 625 dark shapes read as a goal. Locked cells carry only the silhouette and
    // the number — what is behind them stays a surprise, the same rule the wild queue follows.
    // The core counts: the completion is registered species, the collection what is owned.
    const summary = state.dexSummary
    const byID = new Map(state.dexSpecies.map((sp) => [sp.id, sp]))
    const completion = shinydex
      ? `
      <div class="dex-progress">
        <span class="desc">${escapeHTML(summary.shinyProgressText)}</span>
        <div class="bar shiny"><i data-fill="${summary.shinyPercent}"></i></div>
      </div>`
      : `
      <div class="dex-progress">
        <span class="desc">${escapeHTML(summary.progressText)}</span>
        <div class="bar"><i data-fill="${summary.percent}"></i></div>
      </div>`
    const hint =
      summary.owned === 0
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
      if (dexOwnedOnly && (sp === undefined || sp.status === 'seen')) return false
      if (dexOwnedOnly && shinydex && sp?.shiny !== 'registered') return false
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
      const shinyOff =
        shinydex && sp !== undefined && sp.status !== 'registered' && sp.shiny !== 'registered'
      if (sp === undefined || sp.status === 'seen' || shinyOff) {
        // Seen is still a silhouette — met, not owned — but lit, so the grid shows where the wild
        // has already been.
        cells.push(`
        <button class="cell locked${sp?.status === 'seen' ? ' seen' : ''}${selected}" data-dex="${id}"${tabIndex} title="${dexNumber(id)}">
          <img src="${spriteURL(id, false, false)}" alt="" loading="lazy">
          <div class="num">${dexNumber(id)}</div>
        </button>`)
      } else {
        const shiny = sp.shiny === 'registered' || (!shinydex && sp.isShiny)
        // A species whose line never loaded has no name yet, only the core's `#N` fallback —
        // and the number is already on the cell.
        cells.push(`
        <button class="cell owned status-${sp.status} rarity-${escapeHTML(sp.rarity)}${shiny ? ' shiny' : ''}${sp.isCompanion ? ' companion' : ''}${selected}"
                data-dex="${id}"${tabIndex} title="${escapeHTML(sp.name)} · ${escapeHTML(sp.percentText)}">
          ${shiny ? '<span class="star" title="shiny">★</span>' : sp.shiny === 'unlocked' ? '<span class="star open" title="shiny">☆</span>' : ''}
          <img src="${spriteURL(sp.id, shiny, false)}" alt="" loading="lazy">
          <div class="num">${dexNumber(id)}</div>
          ${sp.name === `#${id}` ? '' : `<div class="name">${escapeHTML(sp.name)}</div>`}
          ${
            shinydex
              ? `<div class="reg-bar shiny${sp.shiny === 'registered' ? ' full' : ''}" aria-hidden="true"><i data-fill="${sp.shinyBar?.percent ?? 0}"></i></div>`
              : `<div class="reg-bar${sp.status === 'registered' ? ' full' : ''}" aria-hidden="true"><i data-fill="${sp.percent}"></i></div>`
          }
          ${sp.isCompanion ? `<div class="badge">${escapeHTML(state.strings.companionBadge)}</div>` : ''}
        </button>`)
      }
    }
    const grid =
      cells.length === 0
        ? `<p class="empty">${escapeHTML(state.strings.dexNoMatches)}</p>`
        : `<div class="dex">${cells.join('')}</div>`
    // The detail renders after the grid but floats fixed at the bottom of the view: a card at
    // the top of a 649-cell grid opens off-screen when the click happened four screens down.
    return `${dexHead(state, completion)}${segments}${controls}${hint}${grid}${renderDexDetail(state, byID.get(dexSelected ?? -1))}`
  }

  const head = dexHead(state, '')
  if (state.dexLog.length === 0) {
    return `${head}${segments}
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
    return `${head}${segments}${chips}<p class="empty">${escapeHTML(state.strings.dexNoMatches)}</p>`
  }

  const rows = visible
    .map(
      (e) => `
      <div class="row log-row rarity-${escapeHTML(e.rarity)}${e.isActive ? ' active' : ''}">
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
  return `${head}${segments}${chips}<div class="log">${rows}</div>`
}

/**
 * The top of the device: the Pokédex's own red, its title, and — on the collection — how far
 * along it is. The one accent this tab spends; everything under it stays the editor's.
 */
function dexHead(state: PanelState, progress: string): string {
  return `<div class="dex-head">
      <span class="dex-lens" aria-hidden="true"></span>
      <span class="dex-title">${escapeHTML(state.strings.tabs.dex)}</span>
      ${progress}
    </div>`
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
    <label class="setting tc-field">
      <span>${escapeHTML(state.strings.refreshInterval)}</span>
      <select id="refresh-interval">${state.refresh.options
        .map(
          (option) =>
            `<option value="${option.seconds}"${option.seconds === state.refresh?.seconds ? ' selected' : ''}>${escapeHTML(option.label)}</option>`,
        )
        .join('')}</select>
    </label>`
  // The games' trainer card: who you are, big, beside the options that are yours to set.
  return `
    <div class="trainer-card">
      <div class="tc-portrait"><img src="${trainerURL(state.trainerID)}" alt=""></div>
      <div class="tc-fields">
        <label class="setting tc-field">
          <span>${escapeHTML(state.strings.language)}</span>
          <select id="language">${options}</select>
        </label>
        ${refresh}
      </div>
    </div>
    <label class="setting toggle-setting">
      <input type="checkbox" role="switch" id="keep-completed"${state.keepCompletedCompanion ? ' checked' : ''}
             aria-describedby="keep-completed-hint">
      <span class="toggle-text">
        <span class="toggle-label">${escapeHTML(state.strings.keepCompleted)}</span>
        <span class="toggle-hint" id="keep-completed-hint">${escapeHTML(state.strings.keepCompletedHint)}</span>
      </span>
    </label>
    <h2 class="section">${escapeHTML(state.strings.trainer)}</h2>
    <div class="setting trainer-setting">
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
/**
 * Places every `[data-span-from][data-span-to]` element over its bar as a segment, in percent.
 * Like `paintBars`, through the CSSOM: the CSP forbids inline `style` attributes.
 */
function placeSpans(root: HTMLElement): void {
  for (const span of root.querySelectorAll<HTMLElement>('[data-span-from][data-span-to]')) {
    const from = Math.max(0, Math.min(100, Number(span.dataset['spanFrom']) || 0))
    const to = Math.max(from, Math.min(100, Number(span.dataset['spanTo']) || 0))
    span.style.left = `${from}%`
    span.style.width = `${to - from}%`
  }
}

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
    // The scene's sprites are animated GIFs. A repaint that recreates them restarts every
    // animation at frame one, which reads as the whole stage flickering — so a sprite whose
    // source did not change keeps its node across the repaint.
    const kept = tab === 'home' ? sceneSprites(section) : new Map<string, HTMLImageElement>()
    const previousTerrain = section.querySelector<HTMLElement>('.wild-scene')?.dataset['terrain']
    section.innerHTML = RENDERERS[tab](state)
    if (kept.size > 0) {
      for (const [key, fresh] of sceneSprites(section)) {
        const old = kept.get(key)
        if (old !== undefined && old.src === fresh.src) fresh.replaceWith(old)
      }
    }
    changeTerrain(section, previousTerrain)
    painted.add(tab)
    paintBars(section)
    placeSpans(section)
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

  // Shown where it happened or not at all: a +12M played minutes later, on the way back from the
  // Pokédex, would be news about nothing in particular.
  if (pendingWallet !== undefined && tab === 'home') playWalletChange(pendingWallet)
  pendingWallet = undefined
}

/**
 * Remembers a balance change to play on the next paint. Taken from every state as it arrives —
 * before a throw can defer it — because a deferred state is overwritten by the next one, and the
 * attack's −4M would go with it. The very first state a panel sees is only recorded: the change
 * it carries happened before this panel existed.
 */
function noteWalletChange(state: PanelState): void {
  const change = state.walletChange
  if (change !== undefined && change.id !== seenWalletChangeID) {
    if (walletPrimed) pendingWallet = change
    seenWalletChangeID = change.id
  }
  walletPrimed = true
}

/** As long as a step through the menu takes: the box resizing, then the options settling in. */
const MENU_RESIZE_MS = 240

/**
 * Grows or shrinks the menu from the height it had to the one it has now, instead of jumping —
 * four commands to five items is ~100px — and lets the new options fade in one after another.
 * Through the Web Animations API, not inline styles: the CSP's `style-src` has no
 * 'unsafe-inline'. Skipped with reduced motion or a paused panel, where the menu simply is.
 */
function resizeMenu(menu: HTMLElement, from: number): void {
  if (document.body.classList.contains('paused')) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const to = menu.getBoundingClientRect().height
  if (Math.abs(to - from) > 1) {
    menu.classList.add('resizing')
    const resize = menu.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: MENU_RESIZE_MS,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    })
    const done = () => menu.classList.remove('resizing')
    resize.addEventListener('finish', done)
    resize.addEventListener('cancel', done)
  }
  ;[...menu.children].forEach((option, index) => {
    option.animate(
      [
        { opacity: 0, transform: 'translateY(6px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 180, delay: 40 + index * 30, easing: 'ease-out', fill: 'backwards' },
    )
  })
}

/** A chip with the signed amount drifts into the badge (a gain) or out of it (a loss). */
function playWalletChange(change: PanelWalletChange): void {
  const badge = document.querySelector<HTMLElement>('#home .wallet-badge')
  if (badge === null) return
  const chip = document.createElement('span')
  chip.className = `wallet-delta ${change.kind}`
  chip.textContent = change.text
  chip.setAttribute('aria-hidden', 'true')
  badge.append(chip)
  badge.classList.remove('bump-gain', 'bump-loss')
  void badge.offsetWidth
  badge.classList.add(`bump-${change.kind}`)
  // A timer, not `animationend`: with reduced motion there is no animation to end.
  setTimeout(() => {
    chip.remove()
    badge.classList.remove(`bump-${change.kind}`)
  }, WALLET_CHANGE_MS)
}

/**
 * A fresh scene starts at its final colours, so a new terrain would arrive as a cut. Painting it
 * with the previous terrain first and switching once styles are computed is what gives the
 * stylesheet's transition a starting point.
 */
function changeTerrain(root: HTMLElement, previous: string | undefined): void {
  const scene = root.querySelector<HTMLElement>('.wild-scene')
  const next = scene?.dataset['terrain']
  if (scene === null || previous === undefined || next === undefined || previous === next) return
  scene.dataset['terrain'] = previous
  void getComputedStyle(scene).getPropertyValue('--sky-top')
  scene.dataset['terrain'] = next
}

/** The scene's sprites by role, so a repaint can tell which of them are the same picture. */
function sceneSprites(root: HTMLElement): Map<string, HTMLImageElement> {
  const roles: [string, string][] = [
    ['wild', '.wild-scene .wild-mon img'],
    ['companion', '.wild-scene .companion-mon img'],
    ['trainer', '.wild-scene img.trainer'],
  ]
  const found = new Map<string, HTMLImageElement>()
  for (const [role, selector] of roles) {
    const img = root.querySelector<HTMLImageElement>(selector)
    if (img !== null) found.set(role, img)
  }
  return found
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
  // The wild Pokémon stands higher than your hand in a battle layout, so the arc climbs: it ends
  // a ball's height above the wild's feet, where the games make the ball pop it in.
  const rise = mon.offsetTop + mon.offsetHeight - 40 - ballOrigin.offsetTop
  scene.style.setProperty('--throw-rise', `${Math.round(rise)}px`)
}

// MARK: - Events

// The entrance is spent once it has played. Left on the scene, the class replays it whenever Home
// is shown again — a section going from hidden to shown restarts its CSS animations — so the same
// Pokémon walked back on stage after every visit to another tab. The plate's slide is the later
// of the two, so its end is the end of the entrance.
document.addEventListener('animationend', (event) => {
  if (event.animationName !== 'plate-enter') return
  ;(event.target as HTMLElement).closest('.wild-scene')?.classList.remove('entering')
})

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
  const starterCell = target.closest('[data-starter]')
  if (starterCell !== null) {
    const id = Number((starterCell as HTMLElement).dataset['starter'])
    starterSelected = Number.isInteger(id) ? id : undefined
    invalidate('home')
    render()
    return
  }
  const confirmStarter = target.closest('[data-choose-starter]')
  if (confirmStarter !== null) {
    const id = Number((confirmStarter as HTMLElement).dataset['chooseStarter'])
    if (Number.isInteger(id) && id > 0) vscode.postMessage({ type: 'chooseStarter', speciesID: id })
    return
  }
  const companionButton = target.closest('[data-companion]')
  if (companionButton !== null) {
    const id = Number((companionButton as HTMLElement).dataset['companion'])
    if (Number.isInteger(id) && id > 0) vscode.postMessage({ type: 'setCompanion', speciesID: id })
    return
  }
  if (target.closest('[data-incubate]') !== null) {
    vscode.postMessage({ type: 'incubateEgg' })
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
  const boost = target.closest('[data-boost]')
  if (boost !== null) {
    const el = boost as HTMLElement
    const speciesID = Number(el.dataset['boost'])
    const amount = Number(el.dataset['amount'])
    // The confirmation is the host's native modal, as for a purchase; it re-checks the amount.
    if (Number.isInteger(speciesID) && Number.isFinite(amount) && amount > 0 && current !== undefined) {
      vscode.postMessage({
        type: 'boostShiny',
        speciesID,
        amount,
        title: el.dataset['title'] ?? '',
        priceText: el.dataset['price'] ?? '',
        confirmLabel: current.strings.buy,
      })
    }
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
    beginTurn(
      'throw',
      b.dataset['throw'] ?? '',
      b.dataset['ball'] ?? '',
      b.dataset['sprite'] ?? 'poke-ball',
    )
    return
  }
  const pocketButton = target.closest('[data-pocket]')
  if (pocketButton !== null) {
    bagPocket = (pocketButton as HTMLElement).dataset['pocket'] as typeof bagPocket
    bagSelected = undefined
    invalidate('bag')
    render()
    return
  }
  const bagRow = target.closest('[data-bag-select]')
  if (bagRow !== null) {
    bagSelected = (bagRow as HTMLElement).dataset['bagSelect']
    invalidate('bag')
    render()
    return
  }
  const menuButton = target.closest('[data-menu]')
  if (menuButton !== null && throwing === undefined) {
    wildMenu = ((menuButton as HTMLElement).dataset['menu'] as typeof wildMenu | undefined) ?? 'main'
    // Only the menu changes, so only the menu is redrawn. Repainting Home for it rebuilt the
    // whole scene — sprites reloaded, the wild Pokémon's GIF restarted from its first frame —
    // on every step through Balls, Berries and Back.
    const menu = document.querySelector('.commands')
    const staged = current?.wild.encounters[0]
    if (menu !== null && current !== undefined && staged !== undefined) {
      const from = menu.getBoundingClientRect().height
      menu.outerHTML = commandMenu(current, staged)
      const fresh = document.querySelector<HTMLElement>('.commands')
      if (fresh !== null) resizeMenu(fresh, from)
      // Keyboard users keep their place: focus moves to the first command of the new level.
      document.querySelector<HTMLElement>('.commands button:not(:disabled):not(.none)')?.focus()
    } else {
      invalidate('home')
      render()
    }
    return
  }
  const feedButton = target.closest('[data-feed]')
  if (feedButton !== null) {
    const b = feedButton as HTMLElement
    beginTurn(
      'feed',
      b.dataset['feed'] ?? '',
      b.dataset['berry'] ?? '',
      b.dataset['sprite'] ?? 'oran-berry',
    )
    return
  }
  const collectButton = target.closest('[data-collect]')
  if (collectButton !== null) {
    vscode.postMessage({
      type: 'collect',
      findID: (collectButton as HTMLElement).dataset['collect'] ?? '',
    })
    return
  }
  if (target.closest('[data-collect-all]') !== null) {
    vscode.postMessage({ type: 'collectAll' })
    return
  }
  const trackButton = target.closest('[data-track]')
  if (trackButton !== null) {
    const el = trackButton as HTMLElement
    vscode.postMessage({
      type: 'track',
      trailID: el.dataset['track'] ?? '',
      title: el.dataset['title'] ?? '',
      priceText: el.dataset['price'] ?? '',
      confirmLabel: el.dataset['confirm'],
    })
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
  if (target.id === 'keep-completed') {
    vscode.postMessage({ type: 'setKeepCompleted', keep: (target as HTMLInputElement).checked })
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
// The wild side was briefly an exception — small species at ×1.5 — and it put a Karrablast at
// Arceus's height and a Pikachu at Groudon's: a scale that flattens the size hierarchy takes the
// awe out of meeting a Lugia. The legendaries at ×1 (~100px) are the scene's ceiling.
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
    // The egg is a crop of its sheet drawn by CSS (object-view-box), never sized here.
    if (img.matches('.stage img') && !img.classList.contains('egg')) {
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
      span.className = img.className
      span.textContent = emoji
      img.replaceWith(span)
    }
  },
  true,
)

window.addEventListener(
  'message',
  (event: MessageEvent<{ type: string; state?: PanelState; result?: PanelEncounterResult }>) => {
    if (event.data.type === 'state' && event.data.state !== undefined) {
      noteWalletChange(event.data.state)
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
// Validated like the tab: a segment from an older build (or a removed one) must not restore.
if (saved?.dexSegment !== undefined && DEX_SEGMENTS.includes(saved.dexSegment))
  dexSegment = saved.dexSegment
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
