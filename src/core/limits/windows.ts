/**
 * The limit windows eligible for a rare candy.
 *
 * Deliberately **narrower** than what the UI shows and narrower than what raises an alert.
 * Three kinds of window are excluded because each is a subset or duplicate of a headline
 * window, and granting on both would pay twice for one exhaustion:
 *
 *  - Opus/Sonnet weekly and every `weekly_scoped` entry — inside the overall weekly window.
 *  - Codex `individualLimit` — a dollar spend cap, not a rate window.
 *
 * A provider with no official limit signal at all (Gemini, Antigravity, OpenCode, Hermes,
 * Cursor, Grok, Copilot, Kiro) simply never appears here. That is why this needs no
 * per-provider branching: the window list is the eligibility rule.
 */

import type { AppLanguage, CandyWindow, WindowClass } from '../companion/model.js'
import { codexWindow } from '../i18n/dispatch.js'
import { s as str } from '../i18n/strings.js'
import {
  type CodexRateLimitStatus,
  type LimitStatus,
  bucketDisplayName,
  codexVisibleSnapshots,
} from './models.js'

/**
 * Anything longer than a day is weekly. An unknown duration counts as a session, which is the
 * conservative reading: a session grant is 1 candy, a weekly grant is five.
 */
export function windowClass(minutes: number | undefined): WindowClass {
  return minutes !== undefined && minutes > 1440 ? 'weekly' : 'session'
}

export interface LimitSources {
  claude?: LimitStatus
  codex?: CodexRateLimitStatus
}

/**
 * True once at least one provider's limits have loaded.
 *
 * The candy feature seeds itself on first run from the windows already at 100%, and seeding
 * from an empty list would arm every window at zero — so the next refresh would hand out a
 * grant for a window that was already exhausted before the user ever installed this.
 */
export function limitsReady(sources: LimitSources): boolean {
  return sources.claude !== undefined || sources.codex !== undefined
}

export function candyEligibleWindows(sources: LimitSources, lang: AppLanguage): CandyWindow[] {
  const windows: CandyWindow[] = []

  const fiveHour = sources.claude?.fiveHour?.utilization
  if (fiveHour !== undefined) {
    windows.push({
      key: 'claude.fiveHour',
      name: str(lang, 'claudeFiveHour'),
      kind: 'session',
      utilization: fiveHour,
    })
  }
  const sevenDay = sources.claude?.sevenDay?.utilization
  if (sevenDay !== undefined) {
    windows.push({
      key: 'claude.sevenDay',
      name: str(lang, 'claudeWeekly'),
      kind: 'weekly',
      utilization: sevenDay,
    })
  }

  for (const bucket of sources.codex === undefined ? [] : codexVisibleSnapshots(sources.codex)) {
    // The key must survive a refresh, so it is built from the bucket's identity and the slot —
    // never from `resetsAt`, which changes every window and would re-arm a granted window.
    const bucketKey = bucket.limitId ?? bucket.limitName ?? 'codex'
    const bucketName = bucketDisplayName(bucket)
    for (const slot of ['primary', 'secondary'] as const) {
      const window = bucket[slot]
      if (window === undefined) continue
      windows.push({
        key: `codex.${bucketKey}.${slot}`,
        name: `${bucketName} ${codexWindow(lang, window.windowDurationMins)}`,
        kind: windowClass(window.windowDurationMins),
        utilization: window.usedPercent,
      })
    }
  }
  return windows
}
