import { describe, expect, it } from 'vitest'
import { stillSpriteURL } from '../src/core/companion/model.js'
import {
  SNAPSHOT_SCHEMA,
  aggregateProviders,
  buildSnapshot,
  todayTokensByProvider,
} from '../src/core/snapshot.js'
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

  const egg = {
    state: 'egg' as const,
    isShiny: false,
    progress: 0.42,
    toNextText: '3M to hatch',
    dexCount: 0,
    spendableTokens: 0,
    wildCount: 0,
    wildTooltip: '',
  }

  it('names the egg in the status bar instead of a placeholder', () => {
    const withEgg = buildSnapshot([claude([entry(NOW, 10)])], { now: NOW, companion: egg })
    // The bar's percentage means "limit used", so incubation progress cannot share that slot:
    // two different percentages behind one glyph is unreadable. The word carries the identity and
    // the progress stays in the tooltip.
    expect(withEgg.statusText).toContain('Egg')
    expect(withEgg.statusText).not.toContain('···')
    expect(withEgg.statusText).not.toContain('42%')
    expect(withEgg.tooltipMarkdown).toContain('3M to hatch')
  })

  describe('the primary number', () => {
    // [trigger branch] The whole point of the limit-first shape: the number answers "how much
    // have I got left", which a token total cannot. Without limits it must fall back rather than
    // show an empty slot.
    it('prefers the limit percentage when one is known', () => {
      const snapshot = buildSnapshot([claude([entry(NOW, 12_345)])], {
        now: NOW,
        companion: egg,
        limitPercent: 42.4,
      })
      expect(snapshot.statusText).toContain('42%')
      expect(snapshot.statusText).not.toContain('12.3K')
    })

    it('rounds it, so the item does not change width every refresh', () => {
      const shape = (percent: number) =>
        buildSnapshot([claude([entry(NOW, 10)])], { now: NOW, companion: egg, limitPercent: percent })
          .statusText
      expect(shape(42.4)).toBe(shape(41.6))
      expect(shape(42.4)).toContain('42%')
    })

    it("falls back to today's tokens when no limit is known", () => {
      const snapshot = buildSnapshot([claude([entry(NOW, 12_345)])], { now: NOW, companion: egg })
      expect(snapshot.statusText).toContain('12.3K')
    })
  })

  describe('severity', () => {
    it('stays normal by default', () => {
      expect(buildSnapshot([claude([entry(NOW, 10)])], { now: NOW }).severity).toBe('normal')
      expect(buildSnapshot([claude([entry(NOW, 10)])], { now: NOW, limitPercent: 42 }).severity).toBe(
        'normal',
      )
    })

    // Decided in the core so the host only maps it to a ThemeColor: a threshold repeated in the
    // UI would drift from the one the tooltip explains.
    it('turns to warning when the caller reports an exhausted window', () => {
      expect(
        buildSnapshot([claude([entry(NOW, 10)])], { now: NOW, limitPercent: 96, limitWarning: true })
          .severity,
      ).toBe('warning')
    })
  })

  describe('tooltip', () => {
    it('lists the limit windows it was given', () => {
      const snapshot = buildSnapshot([claude([entry(NOW, 10)])], {
        now: NOW,
        limitPercent: 91,
        limitRows: [
          { label: '5-hour session', value: '91%', percent: 91, severity: 'warn' as const },
          { label: 'Weekly', value: '37%', percent: 37, severity: 'normal' as const },
        ],
      })
      expect(snapshot.tooltipMarkdown).toContain('| 🟡 5-hour session | ███████░ | 91% |')
      expect(snapshot.tooltipMarkdown).toContain('| 🟢 Weekly | ███░░░░░ | 37% |')
    })

    // `severity` and `percent` used to be carried on every row and then ignored here, so the
    // hover showed a 99% window exactly like a 3% one. The dot and the bar are the caller's
    // numbers rendered, never a second set of thresholds decided here.
    it('shows each window at its own severity, and the bar fills with the percentage', () => {
      const of = (percent: number, severity: 'normal' | 'warn' | 'crit') =>
        buildSnapshot([claude([entry(NOW, 10)])], {
          now: NOW,
          limitRows: [{ label: 'Weekly', value: `${percent}%`, percent, severity }],
        }).tooltipMarkdown

      expect(of(3, 'normal')).toContain('| 🟢 Weekly | ░░░░░░░░ | 3% |')
      expect(of(80, 'warn')).toContain('| 🟡 Weekly | ██████░░ | 80% |')
      expect(of(99, 'crit')).toContain('| 🔴 Weekly | ████████ | 99% |')
      // A window can be reported past its own ceiling; the bar must fill, not overflow the cell.
      expect(of(140, 'crit')).toContain('| 🔴 Weekly | ████████ | 140% |')
    })

    // A hover table is one stray character from collapsing, and neither a provider name read off
    // disk nor `claudeLimitEntry`'s passthrough branch is ours to trust.
    it('escapes a pipe in a window or provider name instead of splitting the row', () => {
      const tooltip = buildSnapshot(
        [{ providerID: 'x', displayName: 'a|b', entries: [entry(NOW, 10)] }],
        {
          now: NOW,
          limitRows: [{ label: 'w|k', value: '9%', percent: 9, severity: 'normal' }],
        },
      ).tooltipMarkdown
      expect(tooltip).toContain('| a\\|b |')
      expect(tooltip).toContain('w\\|k')
    })

    it('carries the rows on the snapshot, so a re-render keeps them', () => {
      // The worker rebuilds the panel from the last scan without scanning again; rows held in a
      // worker variable instead of the snapshot would vanish on every such repaint.
      const snapshot = buildSnapshot([claude([entry(NOW, 10)])], {
        now: NOW,
        limitRows: [{ label: 'Weekly', value: '37%', percent: 37, severity: 'normal' }],
      })
      expect(snapshot.limits).toEqual([
        { label: 'Weekly', value: '37%', percent: 37, severity: 'normal' },
      ])
    })

    it('reports no windows when none were given', () => {
      expect(buildSnapshot([claude([entry(NOW, 10)])], { now: NOW }).limits).toEqual([])
    })

    it('omits the section entirely when no window is known', () => {
      const snapshot = buildSnapshot([claude([entry(NOW, 10)])], { now: NOW })
      expect(snapshot.tooltipMarkdown).not.toContain('Limits')
    })

    // The tooltip is the item's menu: a status bar item has ~20 characters, so everything else
    // lives behind these links. They only render if the host allowlists the commands.
    it('offers the three command links', () => {
      const tooltip = buildSnapshot([claude([entry(NOW, 10)])], { now: NOW }).tooltipMarkdown
      expect(tooltip).toContain('(command:tokendex.refresh)')
      expect(tooltip).toContain('(command:tokendex.open)')
      expect(tooltip).toContain('(command:tokendex.showOutput)')
    })

    // The host's `isTrusted.enabledCommands` allowlist is exactly these three. A fourth
    // `command:` link would render as dead text, which is worse than not offering it.
    it('links to no command outside the host allowlist', () => {
      const tooltip = buildSnapshot([claude([entry(NOW, 10)])], {
        now: NOW,
        companion: { ...egg, wildCount: 4, wildTooltip: '4 wild Pokémon are waiting' },
      }).tooltipMarkdown
      const linked = [...tooltip.matchAll(/command:([\w.]+)/g)].map((m) => m[1])
      expect(new Set(linked)).toEqual(
        new Set(['tokendex.refresh', 'tokendex.open', 'tokendex.showOutput']),
      )
    })

    // [trigger branch] A queue of wild encounters sat unnoticed for five days behind a badge on a
    // collapsed activity bar. The hover is the surface that is always one mouse-move away, so it
    // has to say so — and the line has to be actionable, not just informative.
    describe('the wild queue', () => {
      const waiting = (wildCount: number, wildTooltip: string) =>
        buildSnapshot([claude([entry(NOW, 10)])], {
          now: NOW,
          companion: { ...egg, wildCount, wildTooltip },
        }).tooltipMarkdown

      it('announces the encounters and links to the panel that can act on them', () => {
        const tooltip = waiting(12, '12 wild Pokémon are waiting')
        expect(tooltip).toContain('🌿 [**12 wild Pokémon are waiting**](command:tokendex.open)')
      })

      // The wording is localised by the worker and arrives ready; re-deriving it here would be a
      // second source of truth, and an English one at that.
      it('repeats the localised wording it was given rather than composing its own', () => {
        expect(waiting(3, '野生のポケモンが3匹待っています')).toContain('野生のポケモンが3匹待っています')
      })

      // The count is the fact; the sentence is decoration. A snapshot built before the worker
      // filled the text in must still tell the player something is out there.
      it('still reports the count when the localised text has not arrived', () => {
        expect(waiting(2, '')).toContain('🌿 [**× 2**](command:tokendex.open)')
      })

      it('says nothing when the queue is empty', () => {
        expect(waiting(0, '')).not.toContain('🌿')
      })

      it('says nothing when there is no companion at all', () => {
        expect(buildSnapshot([claude([entry(NOW, 10)])], { now: NOW }).tooltipMarkdown).not.toContain(
          '🌿',
        )
      })
    })

    // A ragged bullet list per provider does not line its numbers up, and comparing the tools is
    // the only reason to list them together.
    describe('the per-provider table', () => {
      // Earlier today but outside the trailing block, so neither provider reports a burn rate:
      // the burn column is a separate branch and has to be entered deliberately.
      const earlier = new Date(2026, 6, 15, 3).getTime()
      const two = () => [
        claude([entry(earlier, 182_500_000)]),
        { providerID: 'codex', displayName: 'Codex', entries: [entry(earlier, 70_900_000, 'codex')] },
      ]

      it('aligns the providers in a table under localised headers', () => {
        const tooltip = buildSnapshot(two(), { now: NOW, lang: 'en' }).tooltipMarkdown
        expect(tooltip).toContain('| Tool | Today |')
        expect(tooltip).toContain('| Claude Code | 182.5M |')
        expect(tooltip).toContain('| Codex | 70.9M |')
      })

      // [trigger branch] The column is worth a third of the table's width, so it only appears
      // when some provider is actually burning — same rule as the panel's own breakdown.
      it('adds the burn column only when a provider is burning', () => {
        expect(buildSnapshot(two(), { now: NOW }).tooltipMarkdown).not.toContain('/min')
        const burning = buildSnapshot([claude([entry(NOW - 60_000, 600_000)])], { now: NOW })
        expect(burning.tooltipMarkdown).toContain('/min')
      })

      // Ten supported CLIs, eight of them idle, would turn a hover card into a dashboard.
      it('omits the tools that did nothing today', () => {
        const tooltip = buildSnapshot(
          [
            claude([entry(NOW, 10)]),
            { providerID: 'gemini', displayName: 'Gemini', entries: [] },
            {
              providerID: 'codex',
              displayName: 'Codex',
              entries: [entry(new Date(2026, 6, 2, 9).getTime(), 900, 'codex')],
            },
          ],
          { now: NOW },
        ).tooltipMarkdown
        expect(tooltip).toContain('Claude Code')
        expect(tooltip).not.toContain('Gemini')
        expect(tooltip).not.toContain('Codex') // used this month, but not today
      })

      // The table header is the only thing left when every tool is idle, and a header over
      // nothing reads as a failed scan.
      it('drops the table entirely when nothing ran today', () => {
        const tooltip = buildSnapshot([claude([])], { now: NOW, lang: 'en' }).tooltipMarkdown
        expect(tooltip).not.toContain('| Tool |')
      })
    })

    // `progress` was on the snapshot and unused: the hover said "21.7M to next evolution" and
    // left the player to guess whether that was most of the way or none of it.
    describe('the companion progress bar', () => {
      const raised = (progress: number) =>
        buildSnapshot([claude([entry(NOW, 10)])], {
          now: NOW,
          companion: {
            state: 'working' as const,
            name: 'Charmeleon',
            speciesID: 5,
            isShiny: false,
            progress,
            toNextText: '21.7M to next evolution',
            stageText: 'Stage 2 / 3',
            dexCount: 12,
            spendableTokens: 1_240_000,
            wildCount: 0,
            wildTooltip: '',
          },
        }).tooltipMarkdown

      it('fills with the progress through the current form', () => {
        expect(raised(0)).toContain('░░░░░░░░ · 21.7M to next evolution')
        expect(raised(0.5)).toContain('████░░░░ · 21.7M to next evolution')
        expect(raised(1)).toContain('████████ · 21.7M to next evolution')
      })

      it('gives the egg the same bar next to its own emoji', () => {
        const tooltip = buildSnapshot([claude([entry(NOW, 10)])], {
          now: NOW,
          companion: { ...egg, progress: 0.42 },
        }).tooltipMarkdown
        expect(tooltip).toContain('🥚 ███░░░░░ · 3M to hatch')
      })

      // The species line loads before its stage does, and ` — ` with nothing after it reads as a
      // rendering bug.
      it('drops the stage separator while the stage is still unknown', () => {
        const tooltip = buildSnapshot([claude([entry(NOW, 10)])], {
          now: NOW,
          companion: {
            state: 'idle' as const,
            name: 'Charmander',
            isShiny: false,
            progress: 0.1,
            toNextText: '1M to next',
            dexCount: 1,
            spendableTokens: 0,
            wildCount: 0,
            wildTooltip: '',
          },
        }).tooltipMarkdown
        expect(tooltip).toContain('**Charmander**\n')
        expect(tooltip).not.toContain('**Charmander** — ')
      })
    })
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
        wildCount: 0,
        wildTooltip: '',
      },
    })
    expect(withMon.statusText).toContain('Charmander')
    expect(withMon.tooltipMarkdown).toContain('Pokédex 2')
  })

  // The tooltip is the one place the companion is *visible* without opening anything: a
  // StatusBarItem cannot render an image, but its Markdown tooltip can.
  it('embeds the companion sprite in the tooltip, but never for the egg', () => {
    const companion = {
      state: 'working' as const,
      name: 'Charmander',
      speciesID: 4,
      isShiny: true,
      progress: 0.5,
      toNextText: '1M to next',
      dexCount: 2,
      spendableTokens: 100,
      wildCount: 0,
      wildTooltip: '',
    }
    const withMon = buildSnapshot([claude([entry(NOW, 10)])], { now: NOW, companion })
    expect(withMon.tooltipMarkdown).toContain(`![](${stillSpriteURL(4, true)})`)

    const withEgg = buildSnapshot([claude([entry(NOW, 10)])], { now: NOW, companion: egg })
    expect(withEgg.tooltipMarkdown).not.toContain('![](')
  })

  it('handles having no data at all', () => {
    const snapshot = buildSnapshot([claude([])], { now: NOW })
    expect(snapshot.totals.todayTokens).toBe(0)
    expect(snapshot.providers[0]?.today).toBeUndefined()
    expect(snapshot.statusText).toBeTruthy()
  })
})

describe('aggregateProviders', () => {
  // The worker aggregates once and hands the reports back via `options.providers`; if that
  // path ever diverged from the internal one, the ledger would be fed different numbers than
  // the snapshot displays — the exact "second source of truth" the module header bans.
  it('feeds buildSnapshot identically to letting it aggregate itself', () => {
    const sources = [claude([entry(NOW - 1000, 500), entry(NOW - 86_400_000 * 3, 900)])]
    const direct = buildSnapshot(sources, { now: NOW, locale: 'en-US' })
    const precomputed = buildSnapshot(sources, {
      now: NOW,
      locale: 'en-US',
      providers: aggregateProviders(sources, NOW),
    })
    expect(precomputed).toEqual(direct)
  })
})

// Shared by the scan (which credits growth from it) and by a save import (which anchors its
// baseline against it). The ledger treats "did not report" and "reported nothing" differently,
// so the absent-versus-zero distinction below is the whole contract.
describe('todayTokensByProvider', () => {
  const reports = (now: number) =>
    aggregateProviders(
      [
        claude([entry(now - 1000, 500)]),
        { providerID: 'codex', displayName: 'Codex', entries: [entry(now - 86_400_000 * 3, 900)] },
        { providerID: 'gemini', displayName: 'Gemini', entries: [] },
      ],
      now,
    )

  it('reports today only, and omits a provider that has nothing today', () => {
    expect(todayTokensByProvider(reports(NOW))).toEqual({ claude_code: 500 })
  })

  it('matches what buildSnapshot reports for the same providers', () => {
    const providers = reports(NOW)
    const snapshot = buildSnapshot([], { now: NOW, providers })
    const summed = Object.values(todayTokensByProvider(providers)).reduce((a, b) => a + b, 0)
    expect(summed).toBe(snapshot.totals.todayTokens)
  })
})
