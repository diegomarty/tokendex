/**
 * Bootstraps `shot.html`: skeleton first, then the real webview bundle, then one fixture.
 *
 * The order is the whole point. The webview bundle touches the tab sections the moment it
 * evaluates, so the skeleton must exist first — and a static `import` of the webview here would
 * be hoisted above this file's own statements, which is why it is loaded through a script
 * element instead of the bundler.
 */

import { PANEL_BODY_HTML } from '../../src/webview/shell.js'
import { catchChance } from '../../src/core/companion/encounters.js'
import { wildBadgeTooltip } from '../../src/core/i18n/dispatch.js'
import { percent } from '../../src/core/tokenFormatter.js'
import type { PanelState } from '../../src/webview/protocol.js'
import { FIXTURES } from './fixtures.js'

/** The stub `shot.html` installed before any bundle ran; this file may wrap it. */
declare global {
  interface Window {
    acquireVsCodeApi: () => {
      postMessage(message: unknown): void
      getState(): unknown
      setState(state: unknown): void
    }
  }
}

document.body.insertAdjacentHTML('afterbegin', PANEL_BODY_HTML)

const params = new URLSearchParams(location.search)
const fixture = FIXTURES.find((f) => f.id === params.get('fixture')) ?? FIXTURES[0]!

/**
 * `?throw=<ballKind>&at=<ms>`: auto-click that ball once the scene is up and play the FULL
 * capture round trip, with this page standing in for the host — reply order (state first,
 * then the outcome) matches `broadcastThrow` exactly. This is what the README's hero GIF is
 * recorded from, so the choreography it shows is the shipped one, not a mock-up.
 */
const autoThrow = params.get('throw')
if (autoThrow !== null) {
  const original = window.acquireVsCodeApi
  window.acquireVsCodeApi = () => {
    const api = original()
    return {
      ...api,
      postMessage: (message: unknown) => {
        const m = message as { type?: string; encounterID?: string; ball?: string }
        if (m.type !== 'throw' || m.encounterID === undefined) return api.postMessage(message)
        // The host's reply, ~140ms later: the state with the outcome applied, then the result.
        const head = fixture.state.wild.encounters[0]
        const next = JSON.parse(JSON.stringify(fixture.state)) as PanelState
        next.wild.encounters = next.wild.encounters.slice(1)
        next.wild.waitingText = wildBadgeTooltip('en', next.wild.encounters.length)
        const staged = next.wild.encounters[0]
        for (const ball of next.wild.balls) {
          if (ball.kind === m.ball) ball.count = Math.max(0, ball.count - 1)
          if (staged === undefined) delete ball.oddsText
          else {
            const pct = catchChance(45, ball.kind as never) * 100
            ball.oddsText = percent(pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10)
          }
        }
        setTimeout(() => {
          window.postMessage({ type: 'state', state: next }, '*')
          window.postMessage(
            {
              type: 'throw',
              result: {
                encounterID: m.encounterID,
                kind: 'caught',
                shakes: 4,
                resultText: `Gotcha! ${head?.name ?? ''} was caught!`,
              },
            },
            '*',
          )
        }, 140)
      },
    }
  }
}

const script = document.createElement('script')
script.src = '/dist/webview.js'
script.addEventListener('load', () => {
  // Delivered the same way VS Code delivers it: a message, after the bundle is listening.
  window.postMessage({ type: 'state', state: fixture.state }, '*')
  if (autoThrow !== null) {
    const at = Number(params.get('at') ?? 1400)
    setTimeout(() => {
      document.querySelector<HTMLElement>(`.ball-rack [data-ball="${autoThrow}"]`)?.click()
    }, at)
  }
})
document.body.append(script)
