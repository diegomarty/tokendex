/**
 * The usage snapshot — the single shape the UI renders.
 *
 * Design rule carried over from the plan: **the core emits text that is already formatted**.
 * The status bar and the webview must never re-derive a number or re-format one, because a
 * second formatting path is a second source of truth that drifts.
 *
 * `schema` is versioned from day one: the worker and the UI are separate bundles and can be
 * updated independently.
 */

import { compact, cost, grouped } from './tokenFormatter.js'
import type { DailyUsage, PeriodUsage, ProviderSnapshot } from './models.js'
import type { AppLanguage, CompanionStateKind } from './companion/model.js'
import { s } from './i18n/strings.js'
import { statusEgg, statusOpenPanel, tooltipMonth, tooltipToday } from './i18n/dispatch.js'
import { type Entry, activeBlock, daily, entryTotal, monthKey, period, todayKey } from './usage/entry.js'

export const SNAPSHOT_SCHEMA = 1

/**
 * One official limit window, already named, formatted and classified.
 *
 * `percent` travels alongside `value` because a bar reads a proportion faster than a number does,
 * and `severity` is decided by the caller that owns the thresholds — repeating them in the UI is
 * how the bar's colour ends up disagreeing with the status bar's background.
 */
export interface LimitRow {
  label: string
  value: string
  percent: number
  severity: 'normal' | 'warn' | 'crit'
}

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
  /**
   * Whether the status bar should stand out. Decided here so the host only maps it to a
   * ThemeColor — a second threshold in the UI would drift from the one the tooltip explains.
   */
  severity: 'normal' | 'warning'
  /**
   * The official limit windows behind `severity`. Part of the snapshot rather than a worker-side
   * variable so a panel rebuilt from the last scan (`render`) still shows them.
   */
  limits: LimitRow[]
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

/**
 * The aggregation half of `buildSnapshot` — three full passes (today, month, active block)
 * over every provider's entries. Exposed so a caller that needs the per-provider numbers
 * *before* the companion view exists (the worker feeds them to the ledger and the burn tier)
 * can aggregate once and hand the result back via `options.providers`, instead of paying
 * these passes twice per scan.
 */
export function aggregateProviders(sources: ProviderEntries[], now: number): ProviderReport[] {
  return sources.map((s) => reportFor(s, now))
}

export function totalsFor(providers: ProviderReport[]): UsageSnapshot['totals'] {
  return {
    todayTokens: providers.reduce((s, p) => s + (p.today?.totalTokens ?? 0), 0),
    todayCost: providers.reduce((s, p) => s + (p.today?.totalCost ?? 0), 0),
    monthTokens: providers.reduce((s, p) => s + (p.month?.totalTokens ?? 0), 0),
    monthCost: providers.reduce((s, p) => s + (p.month?.totalCost ?? 0), 0),
  }
}

export function buildSnapshot(
  sources: ProviderEntries[],
  options: {
    now?: number
    locale?: string
    errors?: string[]
    companion?: CompanionView
    /** The player's chosen language. Separate from `locale`, which only formats numbers. */
    lang?: AppLanguage
    /**
     * Precomputed by `aggregateProviders` — must come from the same `sources` and the same
     * `now`, or the totals and the timestamp line would describe different moments.
     */
    providers?: ProviderReport[]
    /**
     * Highest known official-limit utilisation, 0..100+. The status bar's primary number when
     * present: it is the only one that answers "how much have I got left", where a token count
     * only says what has been spent.
     */
    limitPercent?: number
    /** True once a window is close enough to exhaustion to deserve a coloured status bar. */
    limitWarning?: boolean
    /** Limit windows, already named and formatted by the caller. */
    limitRows?: LimitRow[]
  } = {},
): UsageSnapshot {
  const now = options.now ?? Date.now()
  const locale = options.locale
  const lang = options.lang ?? 'en'
  const providers = options.providers ?? aggregateProviders(sources, now)
  const totals = totalsFor(providers)

  const snapshot: UsageSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    fetchedAt: now,
    providers,
    totals,
    statusText: statusTextFor(totals, options.companion, options.limitPercent, lang),
    tooltipMarkdown: tooltipFor({
      providers,
      totals,
      now,
      locale,
      lang,
      companion: options.companion,
      limitRows: options.limitRows ?? [],
    }),
    severity: options.limitWarning === true ? 'warning' : 'normal',
    limits: options.limitRows ?? [],
    errors: options.errors ?? [],
  }
  if (options.companion !== undefined) snapshot.companion = options.companion
  return snapshot
}

function statusTextFor(
  totals: UsageSnapshot['totals'],
  companion: CompanionView | undefined,
  limitPercent: number | undefined,
  lang: AppLanguage,
): string {
  // The limit percentage wins when it is known: it is what decides whether you can keep working.
  // Rounded to whole units on purpose — a status bar item that changes width every refresh
  // shoves its neighbours around, and one decimal buys nothing at a glance.
  const primary =
    limitPercent === undefined ? compact(totals.todayTokens) : `${Math.round(limitPercent)}%`

  // `$(pulse)` is a codicon. VS Code's status bar accepts no custom images, so the animated
  // sprite the macOS menu bar shows has no equivalent here (microsoft/vscode#72244).
  if (companion === undefined) return `$(pulse) ${primary} · ${cost(totals.todayCost)}`

  // The companion's own icon carries the mood, so the trailing text is pure identity: a name, or
  // the word "egg" while there is no species yet. Its incubation progress lives in the tooltip —
  // two different percentages behind the same glyph would be unreadable.
  const label = companion.name ?? (companion.state === 'egg' ? statusEgg(lang) : '···')
  return `${MOOD_ICON[companion.state]} ${primary} · ${label}`
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

function tooltipFor(args: {
  providers: ProviderReport[]
  totals: UsageSnapshot['totals']
  now: number
  locale: string | undefined
  lang: AppLanguage
  companion: CompanionView | undefined
  limitRows: { label: string; value: string }[]
}): string {
  const { providers, totals, now, locale, lang, companion, limitRows } = args
  const lines: string[] = ['**Tokendex**', '']
  // Localised rather than hard-coded: the companion's own lines arrive translated, so a fixed
  // language here would put two languages inside one tooltip.
  lines.push(
    `${tooltipToday(lang)} · **${grouped(totals.todayTokens, locale)}** tokens · ${cost(totals.todayCost)}`,
  )
  lines.push(
    `${tooltipMonth(lang)} · **${grouped(totals.monthTokens, locale)}** tokens · ${cost(totals.monthCost)}`,
  )
  lines.push('')

  for (const p of providers) {
    const todayTokens = p.today?.totalTokens ?? 0
    const burn =
      p.tokensPerMinute !== undefined && p.tokensPerMinute > 0
        ? ` · ${compact(Math.round(p.tokensPerMinute))}/min`
        : ''
    lines.push(
      `- **${p.displayName}** — ${tooltipToday(lang).toLowerCase()} ${compact(todayTokens)}${burn}`,
    )
  }

  if (limitRows.length > 0) {
    lines.push('')
    lines.push(`**${s(lang, 'limitsOfficial')}**`)
    for (const row of limitRows) lines.push(`- ${row.label} — ${row.value}`)
  }

  if (companion !== undefined) {
    lines.push('')
    const label = companion.name ?? '···'
    lines.push(
      companion.state === 'egg'
        ? `🥚 ${companion.toNextText}`
        : `**${label}**${companion.isShiny ? ' ✨' : ''} — ${companion.stageText ?? ''} · ${companion.toNextText}`,
    )
    lines.push(
      `${s(lang, 'dexTitle')} ${companion.dexCount} · ${compact(companion.spendableTokens)} ${s(lang, 'spendableTokens').toLowerCase()}`,
    )
  }

  lines.push('')
  // Command links turn the tooltip into the item's menu, which is where a status bar item keeps
  // everything that does not fit in ~20 characters. The host must allowlist these commands for
  // the links to work at all — see `render` in extension.ts.
  lines.push(
    [
      `[${s(lang, 'refreshNow')}](command:tokendex.refresh)`,
      `[${statusOpenPanel(lang)}](command:tokendex.open)`,
      `[${s(lang, 'showLogFile')}](command:tokendex.showOutput)`,
    ].join(' · '),
  )
  lines.push('')
  lines.push(`_${s(lang, 'updated').toLowerCase()} ${new Date(now).toLocaleTimeString(locale)}_`)
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
