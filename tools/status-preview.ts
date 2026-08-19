/**
 * Prints the status bar text and the tooltip for a set of synthetic snapshots.
 *
 * The status bar is the part of this extension most people see most of the time, and it is
 * produced by a pure function (`buildSnapshot`), so iterating on it needs no editor at all:
 * `npm run status` renders every case in a terminal in milliseconds.
 *
 * The character count is printed because status bar real estate is the actual constraint — a
 * string that reads well on its own can push everything else off a laptop's status bar.
 */

import { type CompanionView, type ProviderEntries, buildSnapshot } from '../src/core/snapshot.js'
import { type Entry, localDayKey } from '../src/core/usage/entry.js'

// A fixed instant, so the output only changes when the code does.
const NOW = Date.parse('2026-08-19T18:24:00Z')
const LOCALE = 'en-US'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

function entries(model: string, count: number, tokensEach: number, minutesAgo = 30): Entry[] {
  return Array.from({ length: count }, (_, i) => {
    const date = NOW - (minutesAgo + i) * 60_000
    return {
      id: `${model}-${i}`,
      date,
      localDay: localDayKey(date),
      model,
      input: Math.round(tokensEach * 0.1),
      output: Math.round(tokensEach * 0.05),
      cacheWrite: Math.round(tokensEach * 0.05),
      cacheRead: Math.round(tokensEach * 0.8),
    }
  })
}

function sources(scale: number): ProviderEntries[] {
  return [
    {
      providerID: 'claude_code',
      displayName: 'Claude Code',
      entries: entries('claude-opus-4-8', 40, scale),
    },
    { providerID: 'codex', displayName: 'Codex', entries: entries('gpt-5.5', 12, scale / 2) },
  ]
}

const COMPANIONS: { label: string; companion?: CompanionView }[] = [
  { label: 'no companion (still loading)' },
  {
    label: 'egg at 6 %',
    companion: {
      state: 'egg',
      isShiny: false,
      progress: 0.06,
      toNextText: '4.7M to hatch',
      dexCount: 0,
      spendableTokens: 312_004,
    },
  },
  {
    label: 'working · Bulbasaur',
    companion: {
      state: 'working',
      name: 'Bulbasaur',
      speciesID: 1,
      isShiny: false,
      rarity: 'common',
      progress: 0.34,
      toNextText: '82.5M to next evolution',
      stageText: 'Stage 1 / 3',
      dexCount: 4,
      spendableTokens: 1_204_000_000,
    },
  },
  {
    label: 'shiny in its final stage',
    companion: {
      state: 'focus',
      name: 'Charizard',
      speciesID: 6,
      isShiny: true,
      rarity: 'rare',
      progress: 0.88,
      toNextText: '45M to graduation',
      stageText: 'Stage 3 / 3',
      dexCount: 24,
      spendableTokens: 6_400_000_000,
    },
  },
  {
    label: 'long Japanese name',
    companion: {
      state: 'levelUp',
      name: 'ドラゴナイト',
      speciesID: 149,
      isShiny: true,
      rarity: 'rare',
      progress: 0.5,
      toNextText: 'そつぎょうまで 120M',
      stageText: '進化段階 3 / 3',
      dexCount: 12,
      spendableTokens: 2_000_000_000,
    },
  },
]

const CASES: { label: string; scale: number }[] = [
  { label: 'quiet day', scale: 40_000 },
  { label: 'normal day', scale: 6_300_000 },
  { label: 'monster day', scale: 30_000_000 },
]

for (const usage of CASES) {
  for (const { label, companion } of COMPANIONS) {
    const snapshot = buildSnapshot(sources(usage.scale), {
      now: NOW,
      locale: LOCALE,
      ...(companion !== undefined ? { companion } : {}),
    })
    console.log(`\n${BOLD}${usage.label} · ${label}${OFF}`)
    console.log(`  bar     ${snapshot.statusText}`)
    console.log(
      `  ${DIM}width   ${snapshot.statusText.length} characters (codicons counted as text)${OFF}`,
    )
    console.log(`  ${DIM}tooltip${OFF}`)
    for (const line of snapshot.tooltipMarkdown.split('\n')) console.log(`    ${line}`)
  }
}

// The error state is not part of the snapshot — `extension.ts` composes it — so it is printed
// verbatim to keep both strings visible side by side while iterating.
console.log(`\n${BOLD}error state (composed in extension.ts)${OFF}`)
console.log('  bar     $(warning) $(pulse) 253.4M · $(zap) Bulbasaur')
console.log('')
