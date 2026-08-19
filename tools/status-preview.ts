/**
 * Prints the status bar line and the tooltip for the combinations that decide their shape.
 *
 * Both come out of `buildSnapshot`, a pure function, so iterating on the wording needs no editor
 * at all: `npm run status` renders everything in a terminal in milliseconds.
 *
 * The width column is the point of the first table. A status bar item whose width changes between
 * refreshes shoves its neighbours around, which is the most visible way one of these looks
 * amateurish — so the shape is checked against an empty state, a nine-figure total and a Japanese
 * species name, not just the happy case.
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
  if (scale === 0) return []
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
  { label: 'no companion' },
  {
    label: 'egg',
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
    label: 'working',
    companion: {
      state: 'working',
      name: 'Bulbasaur',
      speciesID: 1,
      isShiny: false,
      rarity: 'common',
      progress: 0.34,
      toNextText: '82.5M to evolve',
      stageText: 'Stage 1 / 3',
      dexCount: 4,
      spendableTokens: 1_204_000_000,
    },
  },
  {
    label: 'focus, shiny',
    companion: {
      state: 'focus',
      name: 'Charizard',
      speciesID: 6,
      isShiny: true,
      rarity: 'rare',
      progress: 0.88,
      toNextText: '45M to graduate',
      stageText: 'Stage 3 / 3',
      dexCount: 24,
      spendableTokens: 6_400_000_000,
    },
  },
  {
    label: 'asleep',
    companion: {
      state: 'sleep',
      name: 'Snorlax',
      speciesID: 143,
      isShiny: false,
      rarity: 'uncommon',
      progress: 0.12,
      toNextText: '660M to graduate',
      stageText: 'Stage 1 / 1',
      dexCount: 9,
      spendableTokens: 200_000_000,
    },
  },
  {
    label: 'japanese name',
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

const LIMITS: { label: string; limitPercent?: number; limitWarning?: boolean }[] = [
  { label: 'no limits' },
  { label: 'limit 42%', limitPercent: 42 },
  { label: 'limit 91%', limitPercent: 91.4, limitWarning: true },
]

const USAGE: { label: string; scale: number }[] = [
  { label: 'no data', scale: 0 },
  { label: 'ordinary day', scale: 6_300_000 },
  { label: 'heavy day', scale: 30_000_000 },
]

function snapshotFor(usageScale: number, limit: (typeof LIMITS)[number], companion?: CompanionView) {
  return buildSnapshot(sources(usageScale), {
    now: NOW,
    locale: LOCALE,
    lang: 'en',
    ...(companion !== undefined ? { companion } : {}),
    ...(limit.limitPercent !== undefined ? { limitPercent: limit.limitPercent } : {}),
    ...(limit.limitWarning !== undefined ? { limitWarning: limit.limitWarning } : {}),
    limitRows:
      limit.limitPercent === undefined
        ? []
        : [
            { label: '5-hour session', value: `${Math.round(limit.limitPercent)}%` },
            { label: 'Weekly', value: '37%' },
          ],
  })
}

console.log(`\n${BOLD}STATUS BAR${OFF}  ${DIM}(width in characters, codicon markup included)${OFF}`)
for (const usage of USAGE) {
  console.log(`\n  ${BOLD}${usage.label}${OFF}`)
  for (const limit of LIMITS) {
    for (const { label, companion } of COMPANIONS) {
      const snapshot = snapshotFor(usage.scale, limit, companion)
      const width = String(snapshot.statusText.length).padStart(2)
      const flag = snapshot.severity === 'warning' ? ' ⚠ warning background' : ''
      console.log(
        `    ${DIM}${limit.label.padEnd(11)}${label.padEnd(15)}${OFF}${snapshot.statusText.padEnd(32)} ${DIM}${width}${OFF}${flag}`,
      )
    }
  }
}

// One full tooltip, for the case that carries every section at once.
const representative = snapshotFor(6_300_000, LIMITS[2]!, COMPANIONS[3]!.companion)
console.log(`\n${BOLD}TOOLTIP${OFF}  ${DIM}(ordinary day · limit 91% · focus)${OFF}`)
for (const row of representative.tooltipMarkdown.split('\n')) console.log(`    ${row}`)

// Composed by `extension.ts`, not by the snapshot, so it is shown here to keep both in view.
console.log(`\n${BOLD}ERROR STATE${OFF} ${DIM}(composed in extension.ts)${OFF}`)
console.log('    $(warning) $(zap) 42% · Charizard')
console.log('')
