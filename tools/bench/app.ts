/**
 * Development bench: renders the real webview bundle against fixture `PanelState`s in a plain
 * browser, so UI work does not need an Extension Development Host at all.
 *
 * What makes it trustworthy rather than a mock: the DOM skeleton comes from `PANEL_BODY_HTML`
 * (the same constant `panel.ts` uses), the stylesheet is the shipped `dist/webview.css`, the
 * script is the shipped `dist/webview.js`, and `acquireVsCodeApi` is stubbed so the messages the
 * UI *would* send are logged instead of swallowed.
 *
 * What it cannot check: the real CSP (see `panel.ts` — inline handlers are blocked there but not
 * here), and the exact theme values, which are fixtures in `theme.css`.
 */

import { PANEL_BODY_HTML } from '../../src/webview/shell.js'
import { FIXTURES } from './fixtures.js'

type ThemeID = 'dark' | 'light' | 'hc' | 'split'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const fixtureSelect = el<HTMLSelectElement>('fixture')
const themeSelect = el<HTMLSelectElement>('theme')
const widthSelect = el<HTMLSelectElement>('width')
const stage = el('stage')
const logBox = el('log')
const status = el('status')

const THEME_LABEL: Record<Exclude<ThemeID, 'split'>, string> = {
  dark: 'Dark Modern',
  light: 'Light Modern',
  hc: 'High Contrast',
}

/** Restored across reloads so the auto-refresh below never yanks you back to the first case. */
interface BenchPrefs {
  fixture: string
  theme: ThemeID
  width: string
}
const PREFS_KEY = 'tokendex-bench'

function readPrefs(): BenchPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw !== null) return { ...defaults(), ...(JSON.parse(raw) as Partial<BenchPrefs>) }
  } catch {
    // ignored: a broken pref must not stop the bench from opening
  }
  return defaults()
}

function defaults(): BenchPrefs {
  return { fixture: FIXTURES[0]!.id, theme: 'dark', width: '900' }
}

function writePrefs(prefs: BenchPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // ignored
  }
}

let prefs = readPrefs()

function log(kind: string, detail: string): void {
  const line = document.createElement('div')
  const time = new Date().toLocaleTimeString('en-US')
  line.innerHTML = `${time} · <b>${kind}</b> ${detail}`
  logBox.prepend(line)
  while (logBox.childElementCount > 60) logBox.lastElementChild?.remove()
}

/**
 * The page loaded into each frame. The stub is defined before the bundle so the bundle's
 * top-level `acquireVsCodeApi()` call resolves, exactly as it does in a real webview.
 */
function frameDocument(theme: Exclude<ThemeID, 'split'>): string {
  return `<!DOCTYPE html>
<html lang="en" data-vscode-theme="${theme}">
<head>
  <meta charset="UTF-8">
  <link href="/tools/bench/theme.css" rel="stylesheet">
  <link href="/dist/webview.css" rel="stylesheet">
</head>
<body class="vscode-${theme === 'hc' ? 'high-contrast' : theme}">
${PANEL_BODY_HTML}
  <script>
    let persisted = {}
    window.acquireVsCodeApi = () => ({
      postMessage: (message) => parent.postMessage({ __bench: 'out', message }, '*'),
      getState: () => persisted,
      setState: (state) => { persisted = state },
    })
  </script>
  <script src="/dist/webview.js"></script>
</body>
</html>`
}

function currentFixture() {
  return FIXTURES.find((f) => f.id === prefs.fixture) ?? FIXTURES[0]!
}

function mount(): void {
  const themes: Exclude<ThemeID, 'split'>[] = prefs.theme === 'split' ? ['dark', 'light'] : [prefs.theme]

  stage.textContent = ''
  for (const theme of themes) {
    const pane = document.createElement('div')
    pane.className = 'pane'
    const title = document.createElement('h2')
    title.textContent = THEME_LABEL[theme]
    const frame = document.createElement('iframe')
    frame.style.width = `${prefs.width}px`
    frame.srcdoc = frameDocument(theme)
    // The bundle asks for state on load; the fixture is delivered the same way VS Code does.
    frame.addEventListener('load', () => send(frame))
    pane.append(title, frame)
    stage.append(pane)
  }
  log('mount', `${currentFixture().id} · ${themes.join(' + ')} · ${prefs.width}px`)
}

function send(frame: HTMLIFrameElement): void {
  frame.contentWindow?.postMessage({ type: 'state', state: currentFixture().state }, '*')
}

function sendAll(): void {
  for (const frame of stage.querySelectorAll('iframe')) send(frame)
}

// MARK: - Wiring

for (const fixture of FIXTURES) {
  const option = document.createElement('option')
  option.value = fixture.id
  option.textContent = fixture.label
  fixtureSelect.append(option)
}
fixtureSelect.value = prefs.fixture
themeSelect.value = prefs.theme
widthSelect.value = prefs.width

fixtureSelect.addEventListener('change', () => {
  prefs = { ...prefs, fixture: fixtureSelect.value }
  writePrefs(prefs)
  // No remount: pushing a new state is what the extension does, and it keeps the tab you are on.
  sendAll()
  log('state', currentFixture().id)
})

themeSelect.addEventListener('change', () => {
  prefs = { ...prefs, theme: themeSelect.value as ThemeID }
  writePrefs(prefs)
  mount()
})

widthSelect.addEventListener('change', () => {
  prefs = { ...prefs, width: widthSelect.value }
  writePrefs(prefs)
  for (const frame of stage.querySelectorAll('iframe')) frame.style.width = `${prefs.width}px`
})

el('remount').addEventListener('click', () => mount())

window.addEventListener('message', (event: MessageEvent<{ __bench?: string; message?: unknown }>) => {
  if (event.data?.__bench !== 'out') return
  log('webview →', JSON.stringify(event.data.message))
})

/**
 * Auto-refresh: the server stamps the built bundles, so saving a `.css` or `.ts` file repaints
 * the frames on its own. A change to the bench's own bundle reloads the whole page instead,
 * because its listeners are already attached.
 */
let stamp: string | undefined
async function poll(): Promise<void> {
  try {
    const response = await fetch('/__bench/stamp', { cache: 'no-store' })
    const next = (await response.json()) as { webview: string; app: string }
    const combined = `${next.webview}|${next.app}`
    if (stamp === undefined) {
      stamp = combined
      status.textContent = 'live'
      return
    }
    if (combined === stamp) return
    const appChanged = stamp.split('|')[1] !== next.app
    stamp = combined
    if (appChanged) location.reload()
    else {
      mount()
      status.textContent = `reloaded ${new Date().toLocaleTimeString('en-US')}`
    }
  } catch {
    status.textContent = 'server down'
  }
}

mount()
void poll()
setInterval(() => void poll(), 600)
