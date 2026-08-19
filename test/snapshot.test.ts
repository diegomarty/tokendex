import { describe, expect, it } from 'vitest'
import { SNAPSHOT_SCHEMA, buildSnapshot } from '../src/core/snapshot.js'
import type { Entry } from '../src/core/usage/entry.js'
import { localDayKey } from '../src/core/usage/entry.js'

const NOW = new Date(2026, 6, 15, 12, 0, 0).getTime()

function entry(date: number, input: number, model = 'claude-opus-4-8'): Entry {
  return {
    id: `e-${date}-${input}`,
    date,
    localDay: localDayKey(date),
    model,
    input,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  }
}

const claude = (entries: Entry[]) => ({
  providerID: 'claude_code',
  displayName: 'Claude Code',
  entries,
})

describe('buildSnapshot', () => {
  it('carries a schema version so worker and UI can update separately', () => {
    expect(buildSnapshot([], { now: NOW }).schema).toBe(SNAPSHOT_SCHEMA)
  })

  it('totals today and the month across providers', () => {
    const today = entry(NOW, 1_000_000)
    const earlierThisMonth = entry(new Date(2026, 6, 2, 9).getTime(), 500_000)
    const lastMonth = entry(new Date(2026, 5, 20, 9).getTime(), 999_999)

    const snapshot = buildSnapshot(
      [
        claude([today, earlierThisMonth, lastMonth]),
        { providerID: 'codex', displayName: 'Codex', entries: [entry(NOW, 250_000, 'codex')] },
      ],
      { now: NOW },
    )

    expect(snapshot.totals.todayTokens).toBe(1_250_000)
    expect(snapshot.totals.monthTokens).toBe(1_500_000 + 250_000) // last month excluded
    expect(snapshot.providers.map((p) => p.displayName)).toEqual(['Claude Code', 'Codex'])
  })

  it('prices today using the model table', () => {
    const snapshot = buildSnapshot([claude([entry(NOW, 1_000_000)])], { now: NOW })
    expect(snapshot.totals.todayCost).toBeCloseTo(5.0, 6) // opus input, $5/Mtok
  })

  it('emits status text already formatted, so the UI never re-derives it', () => {
    const snapshot = buildSnapshot([claude([entry(NOW, 12_345)])], { now: NOW })
    expect(snapshot.statusText).toContain('12.3K')
    // A codicon, because the status bar accepts no custom images (microsoft/vscode#72244).
    expect(snapshot.statusText.startsWith('$(')).toBe(true)
  })

  it('groups tooltip numbers by the requested locale, not the runner default', () => {
    const snapshot = buildSnapshot([claude([entry(NOW, 253_412_890)])], {
      now: NOW,
      locale: 'es-ES',
    })
    expect(snapshot.tooltipMarkdown).toContain('253.412.890')
    const enUS = buildSnapshot([claude([entry(NOW, 253_412_890)])], { now: NOW, locale: 'en-US' })
    expect(enUS.tooltipMarkdown).toContain('253,412,890')
  })

  // `locale` and `lang` are different axes and used to be confused: the tooltip formatted its
  // numbers by locale while its own labels were hard-coded, so a Japanese player got a
  // Japanese companion line under a label in another language, inside one tooltip.
  it('localises its own labels by language, independently of the number locale', () => {
    const of = (lang: 'en' | 'ja' | 'ko' | 'es' | undefined) =>
      buildSnapshot([claude([entry(NOW, 1_000)])], {
        now: NOW,
        locale: 'en-US',
        ...(lang !== undefined ? { lang } : {}),
      }).tooltipMarkdown

    expect(of('en')).toContain('Today')
    expect(of('es')).toContain('Hoy')
    expect(of('ja')).toContain('今日')
    expect(of('ko')).toContain('오늘')
    // English is the fallback, so a caller that forgets to pass a language still gets one
    // consistent tooltip rather than a mixed one.
    expect(of(undefined)).toContain('Today')
  })

  it('reports a burn rate only when there is recent activity', () => {
    const recent = buildSnapshot([claude([entry(NOW - 60_000, 600)])], { now: NOW })
    expect(recent.providers[0]?.tokensPerMinute).toBeGreaterThan(0)

    const stale = buildSnapshot([claude([entry(NOW - 10 * 3600_000, 600)])], { now: NOW })
    expect(stale.providers[0]?.tokensPerMinute).toBeUndefined()
  })

  it('surfaces per-provider errors without losing the snapshot', () => {
    const snapshot = buildSnapshot([claude([entry(NOW, 10)])], {
      now: NOW,
      errors: ['Codex: EACCES'],
    })
    expect(snapshot.errors).toEqual(['Codex: EACCES'])
    expect(snapshot.totals.todayTokens).toBe(10) // the other provider still reports
  })

  it('shows egg progress in the status bar, since an egg has no name yet', () => {
    const withEgg = buildSnapshot([claude([entry(NOW, 10)])], {
      now: NOW,
      companion: {
        state: 'egg',
        isShiny: false,
        progress: 0.42,
        toNextText: '3M to hatch',
        dexCount: 0,
        spendableTokens: 0,
      },
    })
    expect(withEgg.statusText).toContain('42%')
    expect(withEgg.statusText).not.toContain('···')
  })

  it('shows the species name once there is one', () => {
    const withMon = buildSnapshot([claude([entry(NOW, 10)])], {
      now: NOW,
      companion: {
        state: 'working',
        name: 'Charmander',
        isShiny: false,
        progress: 0.5,
        toNextText: '1M to next',
        dexCount: 2,
        spendableTokens: 100,
      },
    })
    expect(withMon.statusText).toContain('Charmander')
    expect(withMon.tooltipMarkdown).toContain('Pokédex 2')
  })

  it('handles having no data at all', () => {
    const snapshot = buildSnapshot([claude([])], { now: NOW })
    expect(snapshot.totals.todayTokens).toBe(0)
    expect(snapshot.providers[0]?.today).toBeUndefined()
    expect(snapshot.statusText).toBeTruthy()
  })
})
