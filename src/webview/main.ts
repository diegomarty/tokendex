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
  PanelDrawer,
  PanelMoodMeter,
  PanelNews,
  PanelWildEncounter,
  PanelWalletChange,
} from './protocol.js'
import { PANEL_TABS, type PanelTabID } from './shell.js'
import {
  ANIMATED_SPRITE_MAX,
  itemSpriteIsSheet,
  itemSpriteURL,
  menuIconURL,
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
type DexSegment = 'species' | 'shiny' | 'medals' | 'log'
const DEX_SEGMENTS: readonly DexSegment[] = ['species', 'shiny', 'medals', 'log']
let current: PanelState | undefined
let tab: TabID = 'home'
let dexSegment: DexSegment = 'species'
/** The species opened in the dex detail card. Locked ones are selectable too — number only. */
let dexSelected: number | undefined
/** Pokédex narrowing. Panel-owned view state, so it survives a repaint but not a reload. */
let dexQuery = ''
/** The Pokédex grid's order (view state): number by default, as a Pokédex reads. */
let dexSort: SortID = 'number'
let dexOwnedOnly = false
/** The region the Pokédex grid is narrowed to (`kanto`…), or none. View state only. */
let dexRegion: string | undefined
/**
 * Home's drawers that are open — the lid's usage (`usage`) among them. View state: it never
 * reaches the host, and it survives a reload through `vscode.setState`.
 */
const openDrawers = new Set<string>()
/** The shop opened its balls once, on its first showing (view state). */
let shopDrawersSeen = false
/** Each shop drawer's icon: a game item that stands for its group. */
const SHOP_GROUP_ICONS: Record<PanelState['shop'][number]['group'], string> = {
  balls: 'poke-ball',
  berries: 'oran-berry',
  items: 'rare-candy',
  eggs: 'egg-icon',
}
/**
 * Each wild Pokémon's mood as last drawn, by encounter id and meter: what a new render compares
 * against, so a berry or a miss shows the cells it added or took away. View state only.
 */
const moodSeen = new Map<string, Record<string, number>>()
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
/** The PC box is open over the scene (view state; Esc or a click outside closes it). */
let pcOpen = false
/** The species card open as a window over Home (the battle menu's Pokémon button). */
let cardOpen: number | undefined
/** The PC box's search and sort (view state, kept while the panel lives). */
let pcQuery = ''
let pcSort: SortID = 'progress'
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

/**
 * The game's one bar (docs/plans/08-ui-unificada.md): every meter the game draws — EXP,
 * registration, mood, shiny, medals, challenges, the road to the next encounter — is this
 * markup, and only its surface, tone, cells and size change. The official limits are the
 * counter's and keep their native bar.
 */
interface MeterOptions {
  /** What it sits on: the device's dark track, paper, the dialog box, or the red casing. */
  surface: 'device' | 'paper' | 'dialog' | 'casing'
  /** Fill colour; EXP blue unless said. `mood` takes the row's own `--tone`. */
  tone?: 'shiny' | 'done' | 'mood'
  /** Cut into cells, as the mood gauges are: five, so a short gauge's cell is never a hairline. */
  cells?: 5
  size?: 'thin' | 'large'
  /** A glyph at the track's left (★, the game's "EXP"). Decoration: the label names the bar. */
  glyph?: string
  glyphClass?: string
  /** Accessible name. Omitted when the bar repeats text beside it, which is then `hidden`. */
  label?: string
  hidden?: boolean
  /** The track's content when it is not one fill (the new-entry card's base and gain). */
  inner?: string
  /** A mood gauge that moved since the last render: which way, for its animation. */
  change?: 'rise' | 'drop'
}

function gameMeter(percent: number, o: MeterOptions): string {
  const classes = ['game-meter', `on-${o.surface}`]
  if (o.tone !== undefined) classes.push(`tone-${o.tone}`)
  if (o.cells !== undefined) classes.push(`cells-${o.cells}`)
  if (o.size !== undefined) classes.push(o.size)
  if (o.change !== undefined) classes.push(`mood-${o.change}`)
  const glyph =
    o.glyph === undefined
      ? ''
      : `<span class="game-meter-glyph${o.glyphClass === undefined ? '' : ` ${o.glyphClass}`}" aria-hidden="true">${escapeHTML(o.glyph)}</span>`
  const name =
    o.hidden === true
      ? ' aria-hidden="true"'
      : o.label === undefined
        ? ''
        : ` aria-label="${escapeHTML(o.label)}"`
  const fill = o.inner ?? `<i data-fill="${percent}"></i>`
  return `<div class="${classes.join(' ')}">${glyph}<div class="bar game-meter-track"${name}>${fill}</div></div>`
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
        ${gameMeter(c.expPercent, { surface: 'paper', size: 'thin', hidden: true })}
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
  // so it carries the way to the shop. `data-tab` reuses the tab handler, no round trip. Named
  // after where it goes, like a drawer's link: it opens the shop, it does not buy anything.
  const shopLink = `<button class="link" data-tab="shop">${escapeHTML(state.strings.tabs.shop)} →</button>`

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
        : renderGame(state) + renderDrawers(state)

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
  // The lid carries the usage folded: today and this month under the name, the official limits on
  // its three lights, and a chevron that says it opens. Opened, the detail comes out of the lid as
  // its own screen — the two figures side by side with their costs, the tools, the limits — so the
  // usage is read on the device rather than on a box hanging off it.
  const lid = state.lid
  const usageOpen = openDrawers.has('usage')
  const lights = lidLights(state)
  const columns = lid.columns
    .map(
      (c) => `<div class="lid-column">
          <span class="lid-column-label">${escapeHTML(c.label)}</span>
          <span class="lid-column-value" title="${escapeHTML(c.exactText)}">${escapeHTML(c.tokensText)}</span>
          <span class="lid-column-cost">${escapeHTML(c.costText)}</span>
        </div>`,
    )
    .join('')
  const screen = usageOpen
    ? `<div class="lid-screen lcd" id="lid-detail" role="region" aria-label="${escapeHTML(lid.toggleLabel)}">
          <div class="lid-columns">${columns}</div>
          <div class="lid-table">${breakdown}</div>
          ${renderLimits(state)}
        </div>`
    : `<div id="lid-detail" hidden></div>`
  const wallet = compact
    ? ''
    : `<div class="wallet-bar device-casing${usageOpen ? ' open' : ''}" data-fit>
        <button class="brand lid-toggle" data-drawer="usage" aria-expanded="${usageOpen}" aria-controls="lid-detail"
          aria-label="${escapeHTML(lid.toggleLabel)}" aria-describedby="lid-usage">
          <span class="device-lens"></span>
          <span class="device-leds">${lights}</span>
          <span class="brand-text">
            <span class="brand-name">TOKEN<b>DEX</b></span>
            <span class="lid-usage-line">
              <span class="lid-usage" id="lid-usage" data-fit-text><span class="lid-long">${escapeHTML(lid.usageText)}</span><span class="lid-short">${escapeHTML(lid.usageShortText)}</span></span>
              <i class="codicon codicon-chevron-down lid-chevron" aria-hidden="true"></i>
            </span>
          </span>
        </button>
        <button class="wallet-badge lcd" data-tab="shop" title="${escapeHTML(state.strings.spendable)} · ${escapeHTML(state.strings.tabs.shop)}"
          aria-label="${escapeHTML(state.strings.spendable)}: ${escapeHTML(state.spendableText)}">
          <span class="wallet-value">${escapeHTML(state.spendableText)}</span>
          <img class="coin" src="${itemSpriteURL('nugget')}" alt="" data-emoji-fallback="🪙">
        </button>
        ${screen}
      </div>`

  // The compact card keeps the counter in the open: the two figures, the balance, the limits and
  // the tools. The panel folds all of it into the lid.
  if (compact)
    return `<div class="game">${game}</div>
    <div class="stats">
      <div class="stat-tiles">
        ${statTile(state.strings.today, t.todayText, t.todayCostText, t.todayExactText)}
        ${statTile(state.strings.month, t.monthText, t.monthCostText, t.monthExactText)}
      </div>
      <div class="row-stat">
        <span class="label">${escapeHTML(state.strings.spendable)}</span>
        <span class="value">${escapeHTML(state.spendableText)}</span>
        <span class="note">${shopLink}</span>
      </div>
    </div>
    ${renderLimits(state)}
    ${breakdown}`
  return `
    ${wallet}
    <div class="game">${game}</div>`
}

// MARK: - Drawers

/** The game item each drawer is drawn with, from PokéAPI at runtime like every sprite. */
const DRAWER_ICONS: Record<PanelDrawer['id'], string> = {
  incubator: 'egg-icon',
  challenges: 'exp-share',
  trail: 'rainbow-wing',
  wild: 'poke-ball',
  finds: 'dowsing-machine',
  streak: 'soothe-bell',
}

/** Where a drawer leads for the whole system, when it has a tab of its own. */
const DRAWER_TABS: Partial<Record<PanelDrawer['id'], TabID>> = { incubator: 'shop', finds: 'bag' }

/**
 * Home's drawers: the bottom half of the Pokédex, under the scene. Each one a line — its LED,
 * its item, its title and the core's one-line summary — that opens on its detail, drawn with the
 * same pieces as anywhere else. All folded until opened; the green LED says where to look.
 */
function renderDrawers(state: PanelState): string {
  const drawers = state.drawers ?? []
  if (drawers.length === 0) return ''
  const rows = drawers
    .map((d) => {
      const open = openDrawers.has(d.id)
      const icon = DRAWER_ICONS[d.id]
      const sheet = itemSpriteIsSheet(icon) ? ' sheet' : ''
      const tab = DRAWER_TABS[d.id]
      const link =
        tab === undefined
          ? ''
          : `<button class="drawer-link" data-tab="${tab}">${escapeHTML(state.strings.tabs[tab])} →</button>`
      return drawerHTML({
        id: d.id,
        title: d.title,
        summary: d.summary,
        icon,
        iconClass: sheet,
        attention: d.attention,
        open,
        detail: () => `${drawerDetail(state, d.id)}${link}`,
      })
    })
    .join('')
  return `<section class="drawers device-casing">
      <div class="drawers-hinge" aria-hidden="true"><i></i><i></i></div>
      ${rows}
    </section>`
}

/**
 * One drawer — Home's systems and the shop's groups alike: the row (LED, a game item's icon, the
 * title, the summary, the chevron) and, open, its detail. The one component, so a drawer looks
 * and behaves the same wherever it is. `detail` is built only when open.
 */
function drawerHTML(d: {
  id: string
  title: string
  summary: string
  icon: string
  iconClass?: string
  attention: boolean
  open: boolean
  detail: () => string
}): string {
  const id = escapeHTML(d.id)
  return `<div class="drawer drawer-${id}${d.attention ? ' attention' : ''}${d.open ? ' open' : ''}">
      <button class="drawer-row" data-drawer="${id}" aria-expanded="${d.open}" aria-controls="drawer-${id}">
        <span class="drawer-led" aria-hidden="true"></span>
        <img class="drawer-icon${d.iconClass ?? ''}" src="${itemSpriteURL(d.icon)}" alt="">
        <span class="drawer-title">${escapeHTML(d.title)}</span>
        <span class="drawer-summary">${escapeHTML(d.summary)}</span>
        <i class="codicon codicon-chevron-right drawer-chevron" aria-hidden="true"></i>
      </button>
      ${d.open ? `<div class="drawer-detail" id="drawer-${id}" role="region" aria-label="${escapeHTML(d.title)}">${d.detail()}</div>` : ''}
    </div>`
}

/** The detail of one drawer, from data the panel already carries — one piece per system. */
function drawerDetail(state: PanelState, id: PanelDrawer['id']): string {
  switch (id) {
    case 'incubator':
      return renderEggs(state)
    case 'challenges':
      return renderChallenges(state)
    case 'trail':
      return renderTrail(state.wild)
    case 'wild':
      return renderWildQueue(state)
    case 'finds':
      return renderFinds(state.wild)
    case 'streak':
      return streakRow(state.wild.streak)
  }
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
      <button class="btn primary starter-confirm" data-choose-starter="${picked?.id ?? ''}" ${picked === undefined ? 'disabled' : ''}>
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
  // The three slots always show, empty ones included, so the drawer says what the stock holds
  // and what it can hold (Diego). With none, a line says how the next one arrives.
  const slots = Array.from(
    { length: eggs.max },
    (_, i) =>
      `<span class="egg-slot${i < eggs.count ? ' full' : ''}">${i < eggs.count ? `<img class="egg-sprite" src="${itemSpriteURL('egg-icon')}" alt="">` : ''}</span>`,
  ).join('')
  return `<div class="egg-stock${eggs.paused ? ' paused' : ''}">
      <span class="egg-slots" role="img" aria-label="${escapeHTML(eggs.stockText)}">${slots}</span>
      <span class="egg-text">${escapeHTML(eggs.stockText)}${eggs.emptyText === undefined ? '' : `<span class="egg-empty">${escapeHTML(eggs.emptyText)}</span>`}</span>
      ${eggs.incubateText === undefined ? '' : `<button class="btn primary egg-incubate" data-incubate>${escapeHTML(eggs.incubateText)}</button>`}
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
    if (line !== null) showLineWhole(line, result.encounterID, result.resultText)
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
  if (line !== null) showLineWhole(line, result.encounterID, result.resultText)

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
      <span class="tag gain catch-detail">${escapeHTML(banner.detail)}</span>
    </div>`
  }
  // A new species, shown as the Pokédex shows a new entry: the device's red casing with its
  // lens, lights and the entry's number, the Pokémon on the screen, and its registration bar
  // with the share just earned marked as a span [from, to] — placed by `placeSpans` after the
  // paint, since the CSP allows no inline style.
  return `<div class="catch-banner new rich device-casing${entering}" aria-hidden="true">
      <span class="catch-shine"></span>
      <div class="dexcard-top">
        <span class="device-lens small"></span>
        <span class="device-leds"><i></i><i></i><i></i></span>
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
            ${gameMeter(reg.toPercent, {
              surface: 'device',
              size: 'large',
              hidden: true,
              inner: `<i class="base" data-span-from="0" data-span-to="${reg.fromPercent}"></i>
                <i class="gain" data-span-from="${reg.fromPercent}" data-span-to="${reg.toPercent}"><b></b></i>`,
            })}
          </div>
          <span class="tag gain catch-detail">${escapeHTML(banner.detail)}</span>
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
          ${gameMeter(wild.progressPercent, { surface: 'dialog', hidden: true })}
        </div>`
      : ''
  const prompt = selected === undefined ? undefined : strings.commandPrompt
  const dialog = `
    <div class="dialog${selected === undefined ? '' : ' slim'}">
      <p class="dialog-text wild-result${(resultLine ?? prompt) ? '' : ' empty'}" aria-live="polite"
         data-line-context="${escapeHTML(resultLine === undefined ? (selected?.id ?? '') : (wildResult?.encounterID ?? ''))}">${escapeHTML(resultLine ?? prompt ?? '')}</p>
      ${dialogLines}
    </div>`

  if (selected === undefined) {
    const line = c === undefined ? '' : renderLine(c.line)
    return `<div class="battle">${scene}${dialog}${line === '' ? '' : `<div class="evo-strip">${line}</div>`}</div>`
  }

  return `<div class="battle">${scene}${dialog}${commandMenu(state, selected)}</div>`
}

/** The glyph beside each mood gauge: a flame for anger, a pulse for nerves, a heart for trust. */
const MOOD_ICONS: Record<PanelMoodMeter['key'], string> = {
  anger: 'flame',
  nervousness: 'pulse',
  trust: 'heart',
}

/** A plate's status as a tag: a berry taking effect is a state, a theft a loss. */
const STATUS_TONES: Record<PanelWildEncounter['statuses'][number]['key'], string> = {
  primed: 'state',
  stolen: 'loss',
}

/**
 * A mood gauge that moved since it was last drawn, as the catch card shows a gain: the cells it
 * gained lit white and filling in the gauge's colour, or the cells it lost fading out. The fill
 * the gauge ends on is still a `data-fill`, so it keeps its progressbar value.
 */
function moodChange(from: number | undefined, to: number): Pick<MeterOptions, 'inner' | 'change'> {
  if (from === undefined || from === to) return {}
  const end = `<i class="mood-end" data-fill="${to}"></i>`
  return from < to
    ? {
        change: 'rise',
        inner: `${end}<i class="base" data-span-from="0" data-span-to="${from}"></i>
          <i class="gain" data-span-from="${from}" data-span-to="${to}"><b></b></i>`,
      }
    : {
        change: 'drop',
        inner: `<i data-fill="${to}"></i><i class="loss" data-span-from="${to}" data-span-to="${from}"></i>`,
      }
}

/**
 * The wild Pokémon's plate, top left as in the games: name, rarity, character and three gauges
 * where the games put HP. The gauges are anger, nerves and trust — drawn, never measured, here:
 * the core's `tone` picks how loudly each one shows, never a threshold of the webview's own.
 */
function wildPlate(encounter: PanelWildEncounter): string {
  // The three gauges share one line at every width, each led only by its glyph (Diego): the
  // plate stays low, and the name of each lives in its title and its accessible name.
  const before = moodSeen.get(encounter.id)
  const now: Record<string, number> = {}
  const meters = encounter.meters
    .map((m) => {
      const percent = Math.max(0, Math.min(100, Math.round(m.percent)))
      now[m.key] = percent
      return `<div class="meter ${escapeHTML(m.key)}" data-tone="${escapeHTML(m.tone)}" title="${escapeHTML(m.label)}">
        <i class="codicon codicon-${MOOD_ICONS[m.key]} meter-icon" aria-hidden="true"></i>
        <span class="meter-label">${escapeHTML(m.label)}</span>
        ${gameMeter(percent, { surface: 'paper', tone: 'mood', cells: 5, label: m.label, ...moodChange(before?.[m.key], percent) })}
      </div>`
    })
    .join('')
  moodSeen.set(encounter.id, now)
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
        <span class="tag xs rarity-badge ${escapeHTML(encounter.rarity)}">${escapeHTML(encounter.rarityText)}</span>
      </div>

      <div class="meters">${meters}</div>
      ${
        (encounter.statuses ?? []).length === 0
          ? ''
          : `<div class="statuses">${(encounter.statuses ?? [])
              .map(
                (st) =>
                  `<span class="tag xs ${STATUS_TONES[st.key]}" title="${escapeHTML(st.title)}" aria-label="${escapeHTML(st.title)}">${escapeHTML(st.text)}</span>`,
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
  return `<div class="plate plate-player" data-fit>
      <div class="plate-head">
        <span class="plate-name" data-fit-text>${escapeHTML(c.name ?? state.strings.incubating)}${c.isShiny ? ' <span class="shiny-mark">✨</span>' : ''}</span>
        ${
          // Stage, rarity and nature, behind the same glyph as the wild plate's temperament:
          // what the plate is for is the road to the next stage, not the card's details.
          meta.length === 0
            ? ''
            : `<i class="codicon codicon-info plate-info" role="img" tabindex="0" title="${escapeHTML(meta.join(' · '))}" aria-label="${escapeHTML(meta.join(' · '))}"></i>`
        }
        <span class="tag xs state plate-pct">${percent}%</span>
        <button class="pc-open" data-pc-open aria-haspopup="dialog" aria-expanded="${pcOpen}"
                title="${escapeHTML(state.pcBox.title)}" aria-label="${escapeHTML(state.pcBox.title)}">
          <span class="pc-icon" aria-hidden="true"></span>
        </button>
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
      ${gameMeter(c.expPercent, { surface: 'device', glyph: 'EXP', glyphClass: 'label', label })}
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
  // Under the menu line: with an empty rack, the way to the shop — the moment of highest
  // purchase intent. How many more wait is the Wild drawer's, with its LED lit.
  const note = noBalls
    ? `<button class="command info" data-tab="shop">${escapeHTML(strings.getBalls)}</button>`
    : ''
  // "Pokémon", as the games' menu has it: your companion's party icon, and a way to its page in
  // the Pokédex. A still-hatching egg has no page yet, and the button waits for it.
  const companion = state.companion
  const mon =
    companion?.speciesID === undefined
      ? `<img class="command-icon mon-icon" src="${itemSpriteURL('egg-icon')}" alt="">`
      : `<img class="command-icon mon-icon" src="${menuIconURL(companion.speciesID)}" alt=""
             data-fallback="${spriteURL(companion.speciesID, companion.isShiny, false)}">`
  // What a miss risks, over the balls it is the price of.
  const risk = `<p class="dialog-note risk" title="${escapeHTML(encounter.riskText)}" aria-label="${escapeHTML(encounter.riskText)}">
      <span class="risk-heading">${escapeHTML(encounter.risk.heading)}</span>${encounter.risk.items
        .map(
          (item) =>
            `<span class="tag risk-item ${escapeHTML(item.key)}"><i class="codicon codicon-${RISK_ICONS[item.key]}" aria-hidden="true"></i>${escapeHTML(item.text)}</span>`,
        )
        .join('')}
    </p>`
  return `<div class="commands list" role="group" aria-label="${escapeHTML(strings.commandBalls)}">
      ${risk}
      <div class="ball-row">${balls}</div>
      <div class="command-row">
        <button class="command" data-dex-open="${companion?.speciesID ?? ''}" ${companion?.speciesID === undefined ? 'disabled' : ''}>
          ${mon}${escapeHTML(strings.pokemonMenu)}</button>
        <button class="command" data-menu="bag" ${wild.berries.length === 0 ? 'disabled' : ''}>
          <i class="codicon codicon-package command-icon" aria-hidden="true"></i>${escapeHTML(strings.tabs.bag)}</button>
        <button class="command" data-run="${escapeHTML(encounterID)}">
          <i class="codicon codicon-run-all command-icon" aria-hidden="true"></i>${escapeHTML(strings.run)}</button>
        ${note}
      </div>
    </div>`
}

/**
 * The Wild drawer: who is waiting, as a tight list of cards (the one on stage first), the lure
 * running, and the road to the next encounter on the game's own bar.
 */
function renderWildQueue(state: PanelState): string {
  const wild = state.wild
  const queue = wild.encounters
    .map(
      (e) => `<li class="queue-mon">
          <img src="${spriteURL(e.speciesID, e.isShiny, false)}" alt="">
          <span class="queue-name">${escapeHTML(e.name)}${e.isShiny ? ' <span class="shiny-mark">✨</span>' : ''}</span>
          <span class="tag xs rarity-badge ${escapeHTML(e.rarity)}">${escapeHTML(e.rarityText)}</span>
        </li>`,
    )
    .join('')
  return `${queue === '' ? '' : `<ul class="wild-queue" aria-label="${escapeHTML(wild.waitingText)}">${queue}</ul>`}
    ${renderLure(state)}
    <div class="wild-next">
      <span class="wild-next-text">${escapeHTML(wild.nextText)}</span>
      ${gameMeter(wild.progressPercent, { surface: 'paper', size: 'thin', hidden: true })}
    </div>`
}

/** The Finds drawer: what turned up, a tile per item with its count as in the bag, and one
 *  button to pick it all up. A tile alone picks up that one. */
function renderFinds(wild: PanelState['wild']): string {
  return wild.finds.length === 0
    ? ''
    : `<section class="wild-finds">
        <div class="finds-grid">${wild.finds
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
        <button class="btn primary finds-collect" data-collect-all>${escapeHTML(wild.collectAllText)}</button>
      </section>`
}

/** Legendaries that got away and can still be tracked, each with its price. */
function renderTrail(wild: PanelState['wild']): string {
  return wild.trail.length === 0
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
              <button class="btn" data-track="${escapeHTML(entry.id)}" data-title="${escapeHTML(entry.confirmTitle)}"
                      data-price="${escapeHTML(entry.priceText)}" data-confirm="${escapeHTML(entry.confirmLabel)}"
                      ${entry.enabled ? '' : 'disabled'}>${escapeHTML(entry.trackText)}</button>
            </div>`,
          )
          .join('')}
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
    action.saveText === undefined
      ? ''
      : `<span class="tag xs gain save">${escapeHTML(action.saveText)}</span>`
  const price = withPrice
    ? `<span class="price-tag"><span class="cost${cant}">${escapeHTML(action.priceText)}<img class="coin" src="${itemSpriteURL('nugget')}" alt=""></span>${save}</span>`
    : ''
  return `<button class="btn${withPrice ? ' priced' : ''}" data-buy="${escapeHTML(action.id)}"
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

  // The head as the Pokédex's: the device's casing, its lens, the tab's name — and the balance on
  // the lid's own screen, since every price below is judged against it (Diego: the shop follows
  // Home's style).
  const wallet = deviceHead(state, {
    title: state.strings.tabs.shop,
    className: 'shop-head',
    screen: `<span class="wallet-badge lcd head-screen" title="${escapeHTML(state.strings.spendable)}"
            aria-label="${escapeHTML(state.strings.spendable)}: ${escapeHTML(state.spendableText)}">
        <span class="wallet-value">${escapeHTML(state.spendableText)}</span>
        <img class="coin" src="${itemSpriteURL('nugget')}" alt="" data-emoji-fallback="🪙">
      </span>`,
  })

  // `note` is what every card in the group would otherwise repeat. Only the eggs have one so
  // far, and saying it once is the entire reason they each fit on one line now.
  const groups: { id: PanelState['shop'][number]['group']; title: string; note?: string }[] = [
    { id: 'balls', title: state.strings.shopBalls },
    { id: 'berries', title: state.strings.shopBerries },
    { id: 'items', title: state.strings.shopItems },
    { id: 'eggs', title: state.strings.shopEggs, note: state.strings.shopEggsNote },
  ]
  // The groups fold into drawers inside the device's casing, as Home's do — the same row, LED,
  // icon, summary and chevron — so the shop reads as part of the same object. The balls open
  // the first time the shop is seen; after that each drawer keeps what the player left it.
  if (!shopDrawersSeen) {
    shopDrawersSeen = true
    if (![...openDrawers].some((id) => id.startsWith('shop-'))) openDrawers.add('shop-balls')
  }
  const drawers = state.shopGroups
    .map((g) => {
      const group = groups.find((x) => x.id === g.id)
      const items = state.shop.filter((item) => item.group === g.id)
      const id = `shop-${g.id}`
      const open = openDrawers.has(id)
      const note =
        group?.note === undefined ? '' : `<p class="section-note">${escapeHTML(group.note)}</p>`
      return drawerHTML({
        id,
        title: g.title,
        summary: g.summary,
        icon: SHOP_GROUP_ICONS[g.id],
        attention: false,
        open,
        detail: () => `${note}<div class="shop-rows">${items.map(row).join('')}</div>`,
      })
    })
    .join('')

  return `${wallet}<section class="drawers device-casing shop-drawers">
      <div class="drawers-hinge" aria-hidden="true"><i></i><i></i></div>
      ${drawers}
    </section>`
}

/**
 * The bag as the games lay it out: pockets across the top, the pocket's items as a list with a
 * cursor, and the selected item's description in the dialog box below — with Use when it can be
 * used from here. Which pocket and which item are view state; the contents all come from the core.
 */
function renderBag(state: PanelState): string {
  if (state.bag.length === 0) {
    return emptyState(
      state.strings.emptyBag,
      `<button class="btn primary" data-tab="shop">${escapeHTML(state.strings.emptyBag.action)}</button>`,
    )
  }

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
        <p class="dialog-text" data-line-context="${escapeHTML(selected.id)}">${escapeHTML(selected.description)}</p>
        ${
          selected.usable
            ? `<button class="btn primary dialog-action" data-use="${escapeHTML(selected.id)}">${escapeHTML(state.strings.use)}</button>`
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
      <div class="dex-entry-head device-casing flush">
        <span class="num">${dexNumber(dexSelected)}</span>
        <span class="dex-entry-name">?????</span>
        ${close}
      </div>
      <div class="dex-entry-body">
        <div class="portrait"><img src="${spriteURL(dexSelected, false, false)}" alt=""></div>
        ${sp?.lure === undefined ? '' : lureOffer(sp.id, sp.lure)}
      </div>
    </div>`
  }

  return speciesCard(state, sp, close)
}

/**
 * A species' card — one component wherever a species is shown in full: the Pokédex detail, and
 * the battle menu's Pokémon window over Home. The same head, a portrait of fixed size, the
 * registration bar drawn like the shiny one (full width, its line under it), the catch log, the
 * shiny road and the companion action. `close` is the caller's: each place closes its own way.
 */
function speciesCard(state: PanelState, sp: PanelState['dexSpecies'][number], close: string): string {
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
      <div class="dex-entry-head device-casing flush">
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
          <span class="tag xs rarity-badge ${escapeHTML(sp.rarity)}">${escapeHTML(sp.rarityText)}</span>
          <div class="reg-line">
            ${gameMeter(sp.percent, { surface: 'paper', ...(sp.status === 'registered' ? { tone: 'done' as const } : {}), label: sp.percentText })}
            <span class="desc">${escapeHTML(sp.percentText)}</span>
          </div>
          ${entries}
          ${sp.shinyBar === undefined ? '' : shinySection(sp.id, sp.shinyBar)}
          ${
            sp.isCompanion
              ? `<div class="tag state companion-tag">${escapeHTML(state.strings.companionBadge)}</div>`
              : sp.canChoose
                ? `<button class="btn primary dex-choose" data-companion="${sp.id}">${escapeHTML(state.strings.chooseCompanion)}</button>`
                : ''
          }
        </div>
      </div>
    </div>`
}

/**
 * A species met but not yet owned can be lured: a price tag like the shop's, greyed out with its
 * price still showing when the wallet is short. Every word and figure is the core's.
 */
function lureOffer(speciesID: number, offer: NonNullable<PanelDexSpecies['lure']>): string {
  return `<div class="lcd-actions lure-actions">
      <button class="btn priced" data-lure="${speciesID}" data-title="${escapeHTML(offer.confirmTitle)}"
              data-price="${escapeHTML(offer.priceText)}" aria-label="${escapeHTML(offer.label)}"
              ${offer.enabled ? '' : 'disabled'}>
        <span class="verb">${escapeHTML(offer.text)}</span>
        <span class="price-tag"><span class="cost${offer.enabled ? '' : ' cant'}">${escapeHTML(offer.priceText)}<img class="coin" src="${itemSpriteURL('nugget')}" alt=""></span></span>
      </button>
    </div>`
}

/** The lure running, on Home under the scene: the game's Lure item and the core's line. */
function renderLure(state: PanelState): string {
  const lure = state.lure
  if (lure === undefined) return ''
  return `<div class="lure-status" role="status">
      <img class="lure-icon" src="${itemSpriteURL('lure')}" alt="">
      <span class="lure-text">${escapeHTML(lure.text)}</span>
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
      (b) => `<button class="btn priced" data-boost="${speciesID}" data-amount="${b.amount}"
          data-title="${escapeHTML(b.confirmTitle)}" data-price="${escapeHTML(b.priceText)}"
          aria-label="${escapeHTML(b.label)}">
          <span class="verb">${escapeHTML(b.text)}</span>
          <span class="price-tag"><span class="cost">${escapeHTML(b.priceText)}<img class="coin" src="${itemSpriteURL('nugget')}" alt=""></span></span>
        </button>`,
    )
    .join('')
  return `<div class="shiny-section">
      ${gameMeter(bar.percent, { surface: 'device', tone: 'shiny', glyph: '★', label: bar.text })}
      <div class="desc shiny-text">${escapeHTML(bar.text)}</div>
      ${boosts === '' ? '' : `<div class="shiny-boosts lcd-actions">${boosts}</div>`}
      ${bar.boostHint === undefined ? '' : `<div class="desc shiny-hint">${escapeHTML(bar.boostHint)}</div>`}
    </div>`
}

/**
 * The medals: a medallion each, gold once earned and grey until then, with the bar to it. Every
 * name, sentence and figure is the core's.
 */
function renderMedals(state: PanelState): string {
  const items = state.medals.items
    .map(
      (
        m,
      ) => `<div class="medal${m.earned ? ' earned' : ''}" role="group" aria-label="${escapeHTML(m.name)}">
        <span class="medallion" aria-hidden="true">★</span>
        <div class="medal-body">
          <span class="medal-name">${escapeHTML(m.name)}</span>
          <span class="desc">${escapeHTML(m.description)}</span>
          <div class="medal-progress">
            ${gameMeter(m.percent, { surface: 'paper', ...(m.earned ? { tone: 'shiny' as const } : {}), label: m.progressText })}
            <span class="medal-count">${escapeHTML(m.progressText)}</span>
          </div>
        </div>
      </div>`,
    )
    .join('')
  return `<div class="medals">${items}</div>`
}

/**
 * Today's and this week's challenges on Home: a compact board, each with its bar and reward,
 * done ones checked. Absent until the day's first fold, as the core sends it.
 */
function renderChallenges(state: PanelState): string {
  const board = state.challenges
  if (board === undefined || board.items.length === 0) return ''
  const rows = board.items
    .map(
      (c) => `<li class="challenge period-${escapeHTML(c.period)}${c.done ? ' done' : ''}">
        <span class="challenge-check" aria-hidden="true">${c.done ? '✓' : ''}</span>
        <div class="challenge-body">
          <div class="challenge-line">
            <span class="challenge-period">${escapeHTML(c.periodText)}</span>
            <span class="challenge-text">${escapeHTML(c.text)}</span>
          </div>
          <div class="challenge-progress">
            ${gameMeter(c.percent, { surface: 'paper', ...(c.done ? { tone: 'done' as const } : {}), label: c.progressText })}
            <span class="challenge-count">${escapeHTML(c.progressText)}</span>
          </div>
        </div>
        <span class="tag gain challenge-reward">${escapeHTML(c.rewardText)}</span>
      </li>`,
    )
    .join('')
  return `<section class="challenges">
      <h2 class="section">${escapeHTML(board.heading)}</h2>
      <ul class="challenge-list">${rows}</ul>
    </section>`
}

function renderDex(state: PanelState): string {
  // The segments are the device's buttons, in the head's casing under its row (plan 09 §9.3).
  const segments = `
    <div class="segments head-segments">
      <button class="seg" data-seg="species" aria-selected="${dexSegment === 'species'}">
        ${escapeHTML(state.dexSummary.speciesSegmentText)}
      </button>
      <button class="seg" data-seg="shiny" aria-selected="${dexSegment === 'shiny'}">
        ${escapeHTML(state.dexSummary.shinySegmentText)}
      </button>
      <button class="seg" data-seg="medals" aria-selected="${dexSegment === 'medals'}">
        ${escapeHTML(state.medals.headingText)}
      </button>
      <button class="seg" data-seg="log" aria-selected="${dexSegment === 'log'}">
        ${escapeHTML(state.dexSummary.logSegmentText)}
      </button>
    </div>`

  if (dexSegment === 'medals') return `${dexHead(state, undefined, segments)}${renderMedals(state)}`

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
    // A region narrows the grid to its numbers and puts its own progress on the head.
    const region = summary.regions.find((r) => r.id === dexRegion)
    const scope =
      region !== undefined && !shinydex
        ? { text: region.progressText, percent: region.percent, label: region.name }
        : shinydex
          ? { text: summary.shinyProgressText, percent: summary.shinyPercent, shiny: true }
          : { text: summary.progressText, percent: summary.percent }
    // The Shinydex says how a shiny is earned; the collection, how a first Pokémon is had.
    const hint = shinydex
      ? summary.shinyRegistered === 0
        ? emptyState(state.strings.emptyShinydex)
        : ''
      : summary.owned === 0
        ? emptyState(state.strings.emptyCollection)
        : ''

    // 649 cells is ~217 rows in a sidebar. Scrolling to a species is not something anyone does
    // twice, so the grid narrows instead. A numeric query matches the *number*, locked entries
    // included — you can look up #025 before you have ever seen it; a text query can only match
    // a name, and a locked cell has none to match.
    const query = dexQuery.trim().toLowerCase()
    const numeric = /^#?\d+$/.test(query) ? String(Number(query.replace('#', ''))) : undefined
    const matches = (id: number, sp: PanelState['dexSpecies'][number] | undefined): boolean => {
      if (region !== undefined && (id < region.from || id > region.to)) return false
      if (dexOwnedOnly && (sp === undefined || sp.status === 'seen')) return false
      if (dexOwnedOnly && shinydex && sp?.shiny !== 'registered') return false
      if (query === '') return true
      if (numeric !== undefined) return String(id).includes(numeric)
      return sp !== undefined && sp.name.toLowerCase().includes(query)
    }

    // Search, order, "obtained only" and the regions, on the device's own screen under its
    // buttons — folded with the head's chevron, open until folded (plan 09 §9.3).
    const controls = openDrawers.has('dex-filters-folded')
      ? '<div id="dex-filters" hidden></div>'
      : `<div class="dex-filters lcd" id="dex-filters" role="group" aria-label="${escapeHTML(state.strings.dexFiltersToggle)}">
      <div class="dex-controls">
        ${listTools({
          searchAttr: 'id="dex-search"',
          query: dexQuery,
          placeholder: state.strings.dexSearch,
          sorts: summary.sorts,
          sort: dexSort,
          sortAttr: 'data-dex-sort',
        })}
        <button class="chip" data-dex-owned aria-pressed="${dexOwnedOnly}">
          ${escapeHTML(state.strings.dexOwnedOnly)}
        </button>
      </div>
      <div class="dex-controls region-chips" role="group">
        ${summary.regions
          .map(
            (
              r,
            ) => `<button class="chip region region-${escapeHTML(r.id)}${r.percent >= 100 ? ' done' : ''}" data-dex-region="${escapeHTML(r.id)}"
              aria-pressed="${r.id === dexRegion}" title="${escapeHTML(r.progressText)}">${escapeHTML(r.name)}<span class="region-pct">${escapeHTML(r.progressText)}</span></button>`,
          )
          .join('')}
      </div>
    </div>`

    const cells: string[] = []
    // The order the grid reads in: number by default; by progress or rarity, the obtained first
    // (most advanced or rarest first), the silhouettes after them in number order.
    const ids = Array.from({ length: ANIMATED_SPRITE_MAX }, (_, i) => i + 1).filter((id) =>
      matches(id, byID.get(id)),
    )
    if (dexSort !== 'number') {
      const key = (id: number): number => {
        const sp = byID.get(id)
        if (sp === undefined || sp.status === 'seen') return -1
        return dexSort === 'rarity' ? sp.rarityRank : sp.percent
      }
      ids.sort((a, b) => key(b) - key(a) || a - b)
    }
    for (const id of ids) {
      const sp = byID.get(id)
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
              ? gameMeter(sp.shinyBar?.percent ?? 0, {
                  surface: 'paper',
                  size: 'thin',
                  tone: 'shiny',
                  hidden: true,
                })
              : gameMeter(sp.percent, {
                  surface: 'paper',
                  size: 'thin',
                  ...(sp.status === 'registered' ? { tone: 'done' as const } : {}),
                  hidden: true,
                })
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
    return `${dexHead(state, scope, segments + controls)}${hint}${grid}${renderDexDetail(state, byID.get(dexSelected ?? -1))}`
  }

  const head = dexHead(state, undefined, segments)
  if (state.dexLog.length === 0) {
    return `${head}${emptyState(state.strings.emptyLog)}`
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
    return `${head}${chips}<p class="empty">${escapeHTML(state.strings.dexNoMatches)}</p>`
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
        ${e.isWild ? `<span class="tag xs">${escapeHTML(state.strings.wildBadge)}</span>` : ''}
      </div>`,
    )
    .join('')
  return `${head}${chips}<div class="log">${rows}</div>`
}

/**
 * A tab's head, the lid's twin (plan 09 §9.2): the casing row with its lens, the three lights
 * (the official limits, as on the lid), the tab's name in the logo's style and a screen on the
 * right — and, under the row, a thin bar when the screen's figure is a progress. One piece, so
 * the lid, the Pokédex and the shop read as the same device.
 */
function deviceHead(
  state: PanelState,
  o: { title: string; screen?: string; bar?: string; className?: string; inside?: string },
): string {
  return `<div class="device-head device-casing${o.className === undefined ? '' : ` ${o.className}`}">
      <span class="brand">
        <span class="device-lens" aria-hidden="true"></span>
        <span class="device-leds" aria-hidden="true">${lidLights(state)}</span>
        <span class="brand-name device-head-title">${escapeHTML(o.title)}</span>
      </span>
      ${o.screen ?? ''}
      ${o.bar === undefined ? '' : `<div class="device-head-bar">${o.bar}</div>`}
      ${o.inside ?? ''}
    </div>`
}

/** The lid's three lights: the first three official limits' severity, dark without one. */
function lidLights(state: PanelState): string {
  return state.lid.lights.map((light) => `<i class="led-${escapeHTML(light)}"></i>`).join('')
}

/**
 * The Pokédex's head: its count on the screen, the bar of that count under the row, and inside
 * the casing what drives the grid — the segments and, on the collection, the filters' screen,
 * which the chevron beside the count folds.
 */
function dexHead(
  state: PanelState,
  scope?: { text: string; percent: number; shiny?: boolean; label?: string },
  inside = '',
): string {
  if (scope === undefined)
    return deviceHead(state, { title: state.strings.tabs.dex, className: 'dex-head', inside })
  const label = scope.label === undefined ? scope.text : `${scope.label} · ${scope.text}`
  const open = !openDrawers.has('dex-filters-folded')
  const fold = `<button class="head-fold" data-drawer="dex-filters-folded" aria-expanded="${open}" aria-controls="dex-filters"
      title="${escapeHTML(state.strings.dexFiltersToggle)}" aria-label="${escapeHTML(state.strings.dexFiltersToggle)}">
      <i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>`
  return deviceHead(state, {
    title: state.strings.tabs.dex,
    className: 'dex-head',
    screen: `${fold}<span class="wallet-badge lcd head-screen" title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}">
        <span class="wallet-value">${escapeHTML(scope.text)}</span>
      </span>`,
    bar: gameMeter(scope.percent, {
      surface: 'casing',
      hidden: true,
      ...(scope.shiny === true ? { tone: 'shiny' as const } : {}),
    }),
    inside,
  })
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
      <button class="btn" id="export">${escapeHTML(state.strings.exportSave)}</button>
      <button class="btn" id="import">${escapeHTML(state.strings.importSave)}</button>
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

/**
 * Whether a line fits is a question of its words, its figures and the language, never of one
 * panel width: each `[data-fit]` measures its `[data-fit-text]` at full length and takes `.tight`
 * when it does not fit, for the stylesheet to give the short form (the lid's line) or to drop
 * what stands beside it (the player plate's percentage).
 */
function fitTight(): void {
  for (const box of document.querySelectorAll<HTMLElement>('[data-fit]')) {
    box.classList.remove('tight')
    const text = box.querySelector<HTMLElement>('[data-fit-text]')
    if (text !== null && text.scrollWidth > text.clientWidth + 1) box.classList.add('tight')
  }
}
// A resize changes what fits without a render.
new ResizeObserver(() => fitTight()).observe(document.body)

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
    const focused = focusInside(section)
    section.innerHTML = RENDERERS[tab](state)
    restoreFocus(focused)
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
  vscode.setState({ tab, dexSegment, dexSelected, drawers: [...openDrawers] })

  if (scroller !== null && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop

  // Measured only now, after the section visibility flags above: inside a hidden section every
  // offset reads 0, and measuring there was exactly how the first throw's arc came out 60px
  // long. `beginThrow` measures again at click time as the authoritative value.
  if (tab === 'home') measureThrowDistance()

  // Shown where it happened or not at all: a +12M played minutes later, on the way back from the
  // Pokédex, would be news about nothing in particular.
  if (pendingWallet !== undefined && tab === 'home') playWalletChange(pendingWallet)
  pendingWallet = undefined
  paintPCBox()
  typeDialogs()
  fitTight()
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
  chip.className = `tag m ${change.kind} wallet-delta`
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
  const dexOpen = target.closest<HTMLElement>('[data-dex-open]')
  if (dexOpen !== null) {
    const id = Number(dexOpen.dataset['dexOpen'])
    if (!Number.isInteger(id) || id <= 0) return
    // The companion's card as a window over Home (Diego): the battle stays where it is.
    cardOpen = id
    pcOpen = false
    render()
    document.querySelector<HTMLElement>('#pc-layer [data-modal-close]')?.focus()
    return
  }
  if (target.closest('[data-dex-close]') !== null) {
    dexSelected = undefined
    invalidate('dex')
    render()
    return
  }
  const drawerButton = target.closest('[data-drawer]')
  if (drawerButton !== null) {
    const id = (drawerButton as HTMLElement).dataset['drawer'] ?? ''
    if (openDrawers.has(id)) openDrawers.delete(id)
    else openDrawers.add(id)
    invalidate('home')
    invalidate('shop') // the shop's groups are drawers too
    invalidate('dex') // and the Pokédex's filters fold like one
    render()
    return
  }
  const regionChip = target.closest('[data-dex-region]')
  if (regionChip !== null) {
    const id = (regionChip as HTMLElement).dataset['dexRegion']
    // A second click on the region in use lifts the filter.
    dexRegion = id === dexRegion ? undefined : id
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
  // The PC box: open from the player plate, pick to switch (the same `setCompanion` the Pokédex
  // posts), close on the backdrop or the close button.
  if (target.closest('[data-pc-open]') !== null) {
    pcOpen = !pcOpen
    cardOpen = undefined
    invalidate('home')
    render()
    if (pcOpen) {
      document
        .querySelector<HTMLElement>(
          '.pc-box [data-pc-search], .pc-box [data-pc-pick], .pc-box [data-pc-close]',
        )
        ?.focus()
    }
    return
  }
  const pcPick = target.closest('[data-pc-pick]')
  if (pcPick !== null) {
    const id = Number((pcPick as HTMLElement).dataset['pcPick'])
    if (Number.isInteger(id) && id > 0) vscode.postMessage({ type: 'setCompanion', speciesID: id })
    closePCBox()
    return
  }
  if (target.closest('[data-pc-close]') !== null) {
    closePCBox()
    return
  }
  if (target.closest('[data-modal-close]') !== null) {
    closeCard()
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
  const lureButton = target.closest('[data-lure]')
  if (lureButton !== null) {
    const el = lureButton as HTMLElement
    const speciesID = Number(el.dataset['lure'])
    // A native modal on the host, like a purchase; it says when it replaces the lure running.
    if (Number.isInteger(speciesID) && speciesID > 0 && current !== undefined) {
      vscode.postMessage({
        type: 'setLure',
        speciesID,
        title: el.dataset['title'] ?? '',
        priceText: el.dataset['price'] ?? '',
        confirmLabel: current.strings.buy,
      })
    }
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
 * A field with focus keeps it across a repaint of its section, caret and all — a scan's state
 * push arriving mid-word in the Pokédex's search used to throw both away. Only fields with an
 * id, the ones a repaint recreates under the same name.
 */
function focusInside(
  section: HTMLElement,
): { id: string; start: number | null; end: number | null } | undefined {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active.id === '' || !section.contains(active)) return undefined
  const field = active as HTMLInputElement
  const selectable = typeof field.selectionStart === 'number'
  return {
    id: active.id,
    start: selectable ? field.selectionStart : null,
    end: selectable ? field.selectionEnd : null,
  }
}

function restoreFocus(focused: ReturnType<typeof focusInside>): void {
  if (focused === undefined) return
  const fresh = document.getElementById(focused.id) as HTMLInputElement | null
  if (fresh === null) return
  fresh.focus()
  if (focused.start !== null && typeof fresh.setSelectionRange === 'function')
    fresh.setSelectionRange(focused.start, focused.end ?? focused.start)
}

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
    // A tab's item gives way to the codicon under it.
    if (img.classList.contains('tab-item')) {
      img.remove()
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

// MARK: - News

/**
 * The game's news — a hatch, an evolution, a medal, a challenge done — told the way a catch is
 * (plan 08 §7): the Pokédex's card, over whatever tab is open, one after another. The host sends
 * it only to a surface that is in view and keeps VS Code's toast for when none is, so the same
 * moment is never told twice. A click moves to the next; the live region reads each one.
 */
const NEWS_MS = 3600
const newsQueue: PanelNews[] = []
let newsTimer: ReturnType<typeof setTimeout> | undefined

/** The item a piece of news without a Pokémon is drawn with. */
const NEWS_ITEMS: Record<string, string> = {
  medal: 'gold-bottle-cap',
  challenge: 'exp-share',
  candy: 'rare-candy',
  shiny: 'shiny-charm',
  legendary: 'master-ball',
}

function queueNews(items: PanelNews[]): void {
  newsQueue.push(...items)
  if (newsTimer === undefined) showNextNews()
}

function showNextNews(): void {
  clearTimeout(newsTimer)
  newsTimer = undefined
  const layer = newsLayer()
  // A ball in the air, or a catch's own card on the scene, goes first: the news waits its turn.
  if (newsQueue.length > 0 && (throwing !== undefined || catchBanner !== undefined)) {
    newsTimer = setTimeout(showNextNews, 400)
    return
  }
  const next = newsQueue.shift()
  if (next === undefined) {
    layer.replaceChildren()
    return
  }
  layer.innerHTML = newsCard(next)
  paintBars(layer)
  el('announce').textContent =
    next.detail === undefined ? next.headline : `${next.headline} ${next.detail}`
  newsTimer = setTimeout(showNextNews, NEWS_MS)
}

/** Its own layer on <body>, above every tab: the scene's stacking context would bury it. */
function newsLayer(): HTMLElement {
  let layer = document.getElementById('news-layer')
  if (layer === null) {
    layer = document.createElement('div')
    layer.id = 'news-layer'
    layer.setAttribute('aria-hidden', 'true')
    document.body.append(layer)
  }
  return layer
}

/**
 * One card: the device's casing with its lens and lights, the Pokémon on its screen (or the
 * item the news is about), the sentence and its detail. A form that evolved or graduated is
 * registered whole, so its bar is drawn full.
 */
function newsCard(n: PanelNews): string {
  const id = n.speciesID
  const item = NEWS_ITEMS[n.kind] ?? 'poke-ball'
  const art =
    id === undefined
      ? `<img class="catch-mon news-item" src="${itemSpriteURL(item)}" alt="">`
      : `<img class="catch-mon" src="${sceneSpriteURL(id, n.isShiny)}" alt=""
             data-fallback="${spriteURL(id, n.isShiny, false)}">`
  const full = n.kind === 'evolved' || n.kind === 'graduated'
  return `<div class="catch-banner new rich device-casing news news-${escapeHTML(n.kind)} entering" data-news-next>
      <span class="catch-shine"></span>
      <div class="dexcard-top">
        <span class="device-lens small"></span>
        <span class="device-leds"><i></i><i></i><i></i></span>
        ${id === undefined ? '' : `<span class="dexcard-num">${dexNumber(id)}</span>`}
      </div>
      <div class="dexcard-body">
        <span class="catch-mon-wrap">${art}</span>
        <div class="catch-body">
          <span class="catch-headline">${escapeHTML(n.headline)}</span>
          ${full ? `<div class="catch-reg">${gameMeter(100, { surface: 'device', size: 'large', tone: 'done', hidden: true })}</div>` : ''}
          ${n.detail === undefined ? '' : `<span class="tag state catch-detail">${escapeHTML(n.detail)}</span>`}
        </div>
      </div>
    </div>`
}

document.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('[data-news-next]') !== null) showNextNews()
})

/**
 * The tabs are the device's buttons, each drawn with a game item (plan 08 §7): the item from
 * PokéAPI at runtime like every sprite, never bundled. The codicon from the shell stays under it
 * and shows again if the sprite does not load (the `error` handler above removes the image).
 * The developer tab keeps its beaker: it is no part of the game.
 */
const TAB_ITEMS: Partial<Record<TabID, string>> = {
  home: 'town-map',
  shop: 'coin-case',
  bag: 'explorer-kit',
  dex: 'poke-radar',
  settings: 'vs-seeker',
}
for (const [id, item] of Object.entries(TAB_ITEMS)) {
  const button = document.getElementById(`tab-${id}`)
  if (button === null || button.querySelector('.tab-item') !== null) continue
  const img = document.createElement('img')
  img.className = 'tab-item'
  img.alt = ''
  img.src = itemSpriteURL(item)
  button.prepend(img)
}

window.addEventListener(
  'message',
  (
    event: MessageEvent<{
      type: string
      state?: PanelState
      result?: PanelEncounterResult
      items?: PanelNews[]
    }>,
  ) => {
    if (event.data.type === 'news' && Array.isArray(event.data.items)) queueNews(event.data.items)
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
  { tab?: string; dexSegment?: DexSegment; dexSelected?: number; drawers?: unknown } | undefined
// Strings only, and only as many as there could be: a drawer the core no longer sends is simply
// never drawn, so an unknown id costs nothing.
if (Array.isArray(saved?.drawers)) {
  for (const id of saved.drawers.slice(0, 16)) if (typeof id === 'string') openDrawers.add(id)
}
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

// MARK: - PC box

/**
 * The PC box (Diego): the companion switch from the battle plate, as the games keep their boxes
 * in the PC. A modal sheet over the scene — the obtained species the core lists (`pcBox`), the
 * unfinished first — each a button that posts the same `setCompanion` the Pokédex does.
 */
function pcBox(state: PanelState): string {
  const box = state.pcBox
  // Search and sort only when there is something to search: an empty box keeps its one sentence.
  const tools =
    box.items.length === 0
      ? ''
      : `<div class="pc-tools">${listTools({
          searchAttr: 'data-pc-search',
          query: pcQuery,
          placeholder: box.searchPlaceholder,
          sorts: box.sorts,
          sort: pcSort,
          sortAttr: 'data-pc-sort',
        })}</div>`
  return `<div class="pc-backdrop" data-pc-close></div>
    <div class="pc-box" role="dialog" aria-modal="true" aria-label="${escapeHTML(box.title)}">
      <div class="pc-head">
        <span class="pc-icon" aria-hidden="true"></span>
        <h3>${escapeHTML(box.title)}</h3>
        <button class="pc-close" data-pc-close aria-label="${escapeHTML(state.strings.close)}" title="${escapeHTML(state.strings.close)}">
          <i class="codicon codicon-close" aria-hidden="true"></i>
        </button>
      </div>
      ${tools}
      <div class="pc-grid-wrap">${pcGrid(state)}</div>
    </div>`
}

/** The box's grid for the current search and sort. Re-painted alone while typing, keeping focus. */
function pcGrid(state: PanelState): string {
  const box = state.pcBox
  if (box.items.length === 0) return `<p class="pc-empty">${escapeHTML(box.emptyText)}</p>`
  const query = pcQuery.trim().toLowerCase()
  const shown = box.items
    .filter(
      (item) =>
        query === '' ||
        item.name.toLowerCase().includes(query) ||
        String(item.id) === query.replace(/^#/, ''),
    )
    // The core's order is the progress sort; the other two only reorder it, ties by number.
    .sort((a, b) =>
      pcSort === 'number'
        ? a.id - b.id
        : pcSort === 'rarity'
          ? b.rarityRank - a.rarityRank || a.id - b.id
          : 0,
    )
  if (shown.length === 0) return `<p class="pc-empty">${escapeHTML(state.strings.dexNoMatches)}</p>`
  return `<div class="pc-grid">${shown
    .map(
      (
        item,
      ) => `<button class="pc-item rarity-${escapeHTML(item.rarity)}${item.registered ? ' registered' : ''}"
              data-pc-pick="${item.id}" title="${escapeHTML(item.name)} · ${escapeHTML(item.percentText)}"
              aria-label="${escapeHTML(item.name)} · ${escapeHTML(item.percentText)}">
        <img src="${spriteURL(item.id, item.isShiny, false)}" alt="" loading="lazy">
        <span class="pc-name">${escapeHTML(item.name)}</span>
        ${gameMeter(item.percent, { surface: 'paper', size: 'thin', hidden: true, ...(item.registered ? { tone: 'done' as const } : {}) })}
      </button>`,
    )
    .join('')}</div>`
}

/**
 * The PC box lives in its own layer on `<body>`, outside the panel: the scene makes a stacking
 * context, and a fixed sheet inside it would sit under the dialog and the drawers. Painted after
 * every render, so it follows the state while open; emptied when closed or off Home.
 */
function paintPCBox(): void {
  let layer = document.getElementById('pc-layer')
  // Leaving Home closes it: coming back later to a sheet left open would be a surprise.
  if (tab !== 'home') {
    pcOpen = false
    cardOpen = undefined
  }
  // The species card window shares the layer: one modal at a time.
  if (cardOpen !== undefined && current !== undefined) {
    const sp = current.dexSpecies.find((c) => c.id === cardOpen)
    if (layer === null) {
      layer = document.createElement('div')
      layer.id = 'pc-layer'
      document.body.append(layer)
    }
    const close = `<button class="dex-close" data-modal-close aria-label="${escapeHTML(current.strings.close)}">✕</button>`
    const signature = `card:${cardOpen}:${JSON.stringify(sp)}`
    if (layer.dataset['state'] !== signature) {
      layer.dataset['state'] = signature
      layer.innerHTML =
        sp === undefined
          ? ''
          : `<div class="pc-backdrop" data-modal-close></div>
             <div class="species-modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(sp.name)}">${speciesCard(current, sp, close)}</div>`
    }
    paintBars(layer)
    return
  }
  if (!pcOpen || current === undefined) {
    layer?.replaceChildren()
    if (layer) delete layer.dataset['state']
    return
  }
  if (layer === null) {
    layer = document.createElement('div')
    layer.id = 'pc-layer'
    document.body.append(layer)
  }
  // Repaint only on a new state, not on every render, so a search being typed keeps its focus.
  const signature = JSON.stringify(current.pcBox)
  if (layer.dataset['state'] !== signature || layer.childElementCount === 0) {
    layer.dataset['state'] = signature
    layer.innerHTML = pcBox(current)
  }
  // The bars take their width from `data-fill`, which `paintBars` applies — the panel's sections
  // get it from `render`, this layer lives outside them.
  paintBars(layer)
}

function closePCBox(): void {
  if (!pcOpen) return
  pcOpen = false
  invalidate('home')
  render()
  document.querySelector<HTMLElement>('[data-pc-open]')?.focus()
}

// Esc closes the PC box or the species card, and focus goes back to the button that opened it.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (pcOpen) {
    event.preventDefault()
    closePCBox()
  } else if (cardOpen !== undefined) {
    event.preventDefault()
    closeCard()
  }
})

function closeCard(): void {
  if (cardOpen === undefined) return
  cardOpen = undefined
  render()
  document.querySelector<HTMLElement>('[data-dex-open]')?.focus()
}

// The PC box's search filters as you type, and its sort reorders: both repaint the grid alone.
document.addEventListener('input', (event) => {
  const field = (event.target as HTMLElement | null)?.closest?.('[data-pc-search]')
  if (field == null || current === undefined) return
  // As the Pokédex's search: mid-composition the IME owns the field (ko, ja), so the filter runs
  // on the composition's end instead.
  if ((event as InputEvent).isComposing) return
  pcQuery = (field as HTMLInputElement).value
  repaintPCGrid()
})
document.addEventListener('compositionend', (event) => {
  const field = (event.target as HTMLElement | null)?.closest?.('[data-pc-search]')
  if (field == null || current === undefined) return
  pcQuery = (field as HTMLInputElement).value
  repaintPCGrid()
})
document.addEventListener('change', (event) => {
  const select = (event.target as HTMLElement | null)?.closest?.('[data-pc-sort]')
  if (select == null || current === undefined) return
  const value = (select as HTMLSelectElement).value
  if (value === 'progress' || value === 'number' || value === 'rarity') pcSort = value
  repaintPCGrid()
})

// The Pokédex's sort reorders the grid; focus goes back to the select it came from.
document.addEventListener('change', (event) => {
  const select = (event.target as HTMLElement | null)?.closest?.('[data-dex-sort]')
  if (select == null) return
  const value = (select as HTMLSelectElement).value
  if (value === 'progress' || value === 'number' || value === 'rarity') dexSort = value
  invalidate('dex')
  render()
  document.querySelector<HTMLElement>('[data-dex-sort]')?.focus()
})

function repaintPCGrid(): void {
  const wrap = document.querySelector<HTMLElement>('#pc-layer .pc-grid-wrap')
  if (wrap === null || current === undefined) return
  wrap.innerHTML = pcGrid(current)
  paintBars(wrap)
}

// MARK: - List tools

type SortID = 'progress' | 'number' | 'rarity'

/**
 * The one search-and-sort row, shared by the Pokédex and the PC box: a search field and a sort
 * select, native fields (they are the tool's controls, not the game's). Each caller names its
 * own field (`searchAttr`) so its handlers find it, and owns its view state.
 */
function listTools(o: {
  searchAttr: string
  query: string
  placeholder: string
  sorts: { id: SortID; label: string }[]
  sort: SortID
  sortAttr: string
}): string {
  const options = o.sorts
    .map(
      (s) =>
        `<option value="${escapeHTML(s.id)}"${s.id === o.sort ? ' selected' : ''}>${escapeHTML(s.label)}</option>`,
    )
    .join('')
  return `<input ${o.searchAttr} class="list-search" type="search" value="${escapeHTML(o.query)}"
                 placeholder="${escapeHTML(o.placeholder)}" aria-label="${escapeHTML(o.placeholder)}">
          <select ${o.sortAttr} class="list-sort" aria-label="${escapeHTML(o.sorts.map((s) => s.label).join(' / '))}">${options}</select>`
}

// MARK: - Dialog, letter by letter

/**
 * The dialog box writes its line the way the games do, letter by letter (Diego: fast, ~60 a
 * second). Run after every render on each `.dialog-text`:
 *
 *  - The line a screen reader hears is the whole one, at once: it goes to a visually-hidden
 *    copy inside the live region, and the letters being written are `aria-hidden`.
 *  - A line already written stays written; a re-render mid-line carries on from the letter it
 *    had reached rather than starting over.
 *  - A click or a key finishes it at once; with reduced motion (or a hidden panel) it is
 *    written whole.
 */
const DIALOG_CHARS_PER_SECOND = 60
/**
 * A line is remembered *in its context* — the encounter it was said in, the item it describes —
 * never by its words alone: "What will you do?" is the same sentence for every wild Pokémon, and
 * keyed by text it was written once and never again (plan 09 §9.5).
 */
let typing:
  { key: string; text: string; shown: number; timer: ReturnType<typeof setInterval> } | undefined
const writtenLines = new Set<string>()

function lineKey(el: HTMLElement, text: string): string {
  return `${el.dataset['lineContext'] ?? ''}\n${text}`
}

function typeDialogs(): void {
  // Only the open tab's dialogs: a line left in a hidden section would take the typewriter from
  // the one on screen.
  for (const el of document.querySelectorAll<HTMLElement>('main > section:not([hidden]) .dialog-text')) {
    const text = el.dataset['line'] ?? el.textContent ?? ''
    el.dataset['line'] = text
    const key = lineKey(el, text)
    el.dataset['lineKey'] = key
    if (text === '' || motionOff() || writtenLines.has(key)) continue
    if (typing === undefined || typing.key !== key) {
      if (typing !== undefined) {
        clearInterval(typing.timer)
        writtenLines.add(typing.key)
      }
      typing = { key, text, shown: 0, timer: setInterval(stepDialog, 1000 / DIALOG_CHARS_PER_SECOND) }
    }
    paintDialogLine(el, typing.shown)
  }
}

/**
 * A line the scene has already shown whole — a throw's result, written as the ball lands — is
 * written: the repaint after it must not type it out again.
 */
function showLineWhole(el: HTMLElement, context: string, text: string): void {
  finishDialog()
  el.dataset['lineContext'] = context
  el.dataset['line'] = text
  const key = lineKey(el, text)
  el.dataset['lineKey'] = key
  remember(key)
  el.textContent = text
}

function remember(key: string): void {
  // Bounded, as lines are many over a day.
  if (writtenLines.size > 64) writtenLines.clear()
  writtenLines.add(key)
}

/** One element's line with `shown` letters written; the whole line for the screen reader. */
function paintDialogLine(el: HTMLElement, shown: number): void {
  const text = el.dataset['line'] ?? ''
  el.innerHTML = `<span class="visually-hidden">${escapeHTML(text)}</span><span aria-hidden="true">${escapeHTML(
    [...text].slice(0, shown).join(''),
  )}</span>`
}

function stepDialog(): void {
  if (typing === undefined) return
  const letters = [...typing.text].length
  typing.shown += 1
  for (const el of document.querySelectorAll<HTMLElement>('.dialog-text')) {
    if (el.dataset['lineKey'] === typing.key) paintDialogLine(el, typing.shown)
  }
  if (typing.shown >= letters) finishDialog()
}

/** Writes the line whole and stops: on its last letter, or at a click or a key. */
function finishDialog(): void {
  if (typing === undefined) return
  clearInterval(typing.timer)
  const { key, text } = typing
  remember(key)
  typing = undefined
  for (const el of document.querySelectorAll<HTMLElement>('.dialog-text')) {
    if (el.dataset['lineKey'] === key) el.textContent = text
  }
}

// A click anywhere or any key completes the line being written, as the games' A button does.
document.addEventListener('pointerdown', () => finishDialog(), true)
document.addEventListener('keydown', () => finishDialog(), true)

// MARK: - Empty states

/**
 * One empty view, drawn one way everywhere (plan 08 §7): what it is, and how it fills — with the
 * way there as a button when there is one. Texts are the core's.
 */
function emptyState(empty: { title: string; hint: string }, action = ''): string {
  return `<div class="empty-state">
      <p class="empty-title">${escapeHTML(empty.title)}</p>
      <p class="empty-hint">${escapeHTML(empty.hint)}</p>
      ${action}
    </div>`
}
