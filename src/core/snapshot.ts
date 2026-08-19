/**
 * The usage snapshot — the single shape the UI renders.
 *
 * Design rule carried over from the plan: **the core emits text that is already formatted**.
 * The status bar and the webview must never re-derive a number or re-format one, because a
 * second formatting path is a second source of truth that drifts from upstream.
 *
 * `schema` is versioned from day one: the worker and the UI are separate bundles and can be
 * updated independently.
 */

import { compact, cost, grouped } from './tokenFormatter.js'
import type { DailyUsage, PeriodUsage, ProviderSnapshot } from './models.js'
import type { CompanionStateKind } from './companion/model.js'
import {
  type Entry,
  activeBlock,
  daily,
  entryTotal,
  monthKey,
  period,
  todayKey,
} from './usage/entry.js'

export const SNAPSHOT_SCHEMA = 1

export interface ProviderReport {
  providerID: string
  displayName: string
  entries: number
  today?: DailyUsage
  month?: PeriodUsage
  /** Tokens per minute over the trailing 5h window, when there is recent activity. */
  tokensPerMinute?: number
}

export interface CompanionView {
  state: CompanionStateKind
  /** Localised species name, absent while the line is still loading. */
  name?: string
  speciesID?: number
  isShiny: boolean
  rarity?: string
  /** 0..1 through the current form, or through egg incubation. */
  progress: number
  /** Tokens still needed for the next step, already formatted. */
  toNextText: string
  stageText?: string
  dexCount: number
  spendableTokens: number
}

export interface UsageSnapshot {
  schema: number
  /** Epoch milliseconds the scan completed. */
  fetchedAt: number
  providers: ProviderReport[]
  totals: {
    todayTokens: number
    todayCost: number
    monthTokens: number
    monthCost: number
  }
  /** Ready for the status bar. Never re-format this. */
  statusText: string
  /** Ready for the tooltip, as Markdown. */
  tooltipMarkdown: string
  /** Absent until the companion store has loaded at least once. */
  companion?: CompanionView
  /** Non-fatal per-provider failures; the snapshot is still usable. */
  errors: string[]
}

export interface ProviderEntries {
  providerID: string
  displayName: string
  entries: Entry[]
}

function reportFor(source: ProviderEntries, now: number): ProviderReport {
  const today = todayKey(now)
  const month = monthKey(now)
  const report: ProviderReport = {
    providerID: source.providerID,
    displayName: source.displayName,
    entries: source.entries.length,
  }
  const d = daily(source.entries, today)
  if (d !== undefined) report.today = d
  report.month = period(source.entries, month, `${month}-01`, `${month}-31`)
  const block = activeBlock(source.entries, now)
  if (block?.tokensPerMinute !== undefined) report.tokensPerMinute = block.tokensPerMinute
  return report
}

export function buildSnapshot(
  sources: ProviderEntries[],
  options: { now?: number; locale?: string; errors?: string[]; companion?: CompanionView } = {},
): UsageSnapshot {
  const now = options.now ?? Date.now()
  const locale = options.locale
  const providers = sources.map((s) => reportFor(s, now))

  const totals = {
    todayTokens: providers.reduce((s, p) => s + (p.today?.totalTokens ?? 0), 0),
    todayCost: providers.reduce((s, p) => s + (p.today?.totalCost ?? 0), 0),
    monthTokens: providers.reduce((s, p) => s + (p.month?.totalTokens ?? 0), 0),
    monthCost: providers.reduce((s, p) => s + (p.month?.totalCost ?? 0), 0),
  }

  const snapshot: UsageSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    fetchedAt: now,
    providers,
    totals,
    statusText: statusTextFor(totals, options.companion),
    tooltipMarkdown: tooltipFor(providers, totals, now, locale, options.companion),
    errors: options.errors ?? [],
  }
  if (options.companion !== undefined) snapshot.companion = options.companion
  return snapshot
}

function statusTextFor(totals: UsageSnapshot['totals'], companion: CompanionView | undefined): string {
  // `$(pulse)` is a codicon. VS Code's status bar accepts no custom images, so the animated
  // sprite the macOS menu bar shows has no equivalent here (microsoft/vscode#72244).
  const usage = `$(pulse) ${compact(totals.todayTokens)}`
  if (companion === undefined) return `${usage} · ${cost(totals.todayCost)}`
  const mood = MOOD_ICON[companion.state]
  // An egg has no species name yet, and a bare placeholder tells the user nothing. Showing
  // incubation progress answers the real question: "why is nothing happening?"
  const label =
    companion.name ??
    (companion.state === 'egg' ? `${Math.round(companion.progress * 100)}%` : '···')
  return `${usage} · ${mood} ${label}`
}

/** Codicons standing in for the sprite the status bar cannot render. */
const MOOD_ICON: Record<CompanionStateKind, string> = {
  egg: '$(circle-outline)',
  idle: '$(circle-filled)',
  working: '$(zap)',
  focus: '$(flame)',
  tired: '$(warning)',
  sleep: '$(mute)',
  levelUp: '$(star-full)',
}

function tooltipFor(
  providers: ProviderReport[],
  totals: UsageSnapshot['totals'],
  now: number,
  locale: string | undefined,
  companion: CompanionView | undefined,
): string {
  const lines: string[] = ['**Tokendex**', '']
  lines.push(`Hoy · **${grouped(totals.todayTokens, locale)}** tokens · ${cost(totals.todayCost)}`)
  lines.push(`Mes  · **${grouped(totals.monthTokens, locale)}** tokens · ${cost(totals.monthCost)}`)
  lines.push('')

  for (const p of providers) {
    const todayTokens = p.today?.totalTokens ?? 0
    const burn =
      p.tokensPerMinute !== undefined && p.tokensPerMinute > 0
        ? ` · ${compact(Math.round(p.tokensPerMinute))}/min`
        : ''
    lines.push(`- **${p.displayName}** — hoy ${compact(todayTokens)}${burn}`)
  }

  if (companion !== undefined) {
    lines.push('')
    const label = companion.name ?? '···'
    lines.push(
      companion.state === 'egg'
        ? `🥚 ${companion.toNextText}`
        : `**${label}**${companion.isShiny ? ' ✨' : ''} — ${companion.stageText ?? ''} · ${companion.toNextText}`,
    )
    lines.push(`Pokédex ${companion.dexCount} · ${compact(companion.spendableTokens)} por gastar`)
  }

  lines.push('')
  lines.push(`_actualizado ${new Date(now).toLocaleTimeString(locale)}_`)
  return lines.join('\n')
}

/** Converts a report to the shared `ProviderSnapshot` shape the game logic will expect. */
export function toProviderSnapshot(report: ProviderReport, fetchedAt: number): ProviderSnapshot {
  const snapshot: ProviderSnapshot = {
    providerID: report.providerID,
    displayName: report.displayName,
    fetchedAt,
    reportsCost: true,
  }
  if (report.today !== undefined) snapshot.today = report.today
  if (report.month !== undefined) snapshot.monthTotal = report.month
  return snapshot
}

export { entryTotal }
