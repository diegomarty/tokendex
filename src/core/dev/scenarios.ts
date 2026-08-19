/**
 * The development scenario table — one entry per thing you might want to make happen.
 *
 * Declarative on purpose: this single table drives both the **Dev tab** in the panel and the
 * `Tokendex: Development simulation…` quick pick. Two lists would drift, and the drift shows up
 * as a scenario that exists in one surface and not the other.
 *
 * The governing rule is unchanged from the simulation layer: prefer **spending synthetic tokens**
 * over poking the save. An offset travels the whole production pipeline (ledger, crediting,
 * growth, hatching, evolution, graduation), so it exercises the real rules; writing into the
 * state directly would look identical on screen while testing nothing. The `state` group exists
 * only for what you cannot practically reach by spending — a shiny is 1-in-64, a Ditto 1-in-128.
 *
 * Labels are English and deliberately **not** localised: this surface is developer-only, gated
 * behind `tokendex.devMode`, and never ships enabled.
 */

import type { ItemKind, Rarity } from '../companion/model.js'
import type { CompanionState } from '../companion/model.js'
import { compact } from '../tokenFormatter.js'
import { type DevState, parseAmount, tokensToGraduation, tokensToMilestone } from './simulation.js'

/**
 * Every development-only action the worker understands.
 *
 * Declared here rather than in the worker so this table can build them without importing a
 * module that pulls in `node:worker_threads`; `WorkerAction` unions this type in.
 */
export type DevAction =
  | { action: 'devAddTokens'; provider: string; amount: number }
  | { action: 'devAddToMilestone'; scope: 'next' | 'graduation' }
  | { action: 'devClearOffsets' }
  | { action: 'devGrantItem'; item: ItemKind; count: number }
  | { action: 'devGrantTokens'; amount: number }
  | { action: 'devSetShiny'; value: boolean }
  | { action: 'devSetDitto'; value: boolean }
  | { action: 'devSetEggTier'; tier?: Rarity }
  | { action: 'devDayRollover' }
  | { action: 'devResetSave' }
  | { action: 'devSnapshot'; slot: 'save' | 'restore' }

export type DevGroup = 'tokens' | 'items' | 'state' | 'edge' | 'reset'

/** Group headings, in the order the Dev tab and the quick pick present them. */
export const DEV_GROUPS: { id: DevGroup; title: string }[] = [
  { id: 'tokens', title: 'Tokens — these run the real pipeline' },
  { id: 'items', title: 'Wallet and items' },
  { id: 'state', title: 'States you will not reach by chance' },
  { id: 'edge', title: 'Accounting edge cases' },
  { id: 'reset', title: 'Safety net' },
]

/** What the surface has to ask for before it can dispatch. */
export type DevInput =
  | { kind: 'none' }
  | { kind: 'amount'; prompt: string; defaultValue: string }
  | { kind: 'choice'; prompt: string; options: { value: string; label: string }[]; defaultValue: string }

export interface DevScenario {
  /** Stable id echoed back by the UI. Renaming one breaks a stale webview, nothing else. */
  id: string
  group: DevGroup
  label: string
  detail: string
  input: DevInput
  /** Dispatched this many times in a row, so a multi-step run reads as progress, not a jump. */
  steps?: number
  /** Present = destructive, and the host asks for a native confirmation with this text. */
  confirm?: string
  /** Builds the action from the raw input value ('' when the scenario takes none). */
  build: (value: string) => DevAction | undefined
}

const M = 1_000_000

/** The amount input accepts `1500`, `250M`, `1.5B`; anything else yields undefined. */
function amount(value: string): number | undefined {
  const parsed = parseAmount(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function grantItem(item: ItemKind, defaultCount: string): DevScenario {
  return {
    id: `grant-${item}`,
    group: 'items',
    label: `Grant ${item === 'rareCandy' ? 'Rare Candy' : item === 'mint' ? 'Mint' : 'Shiny Charm'}`,
    detail: 'Straight into the bag, without paying the shop',
    input: { kind: 'amount', prompt: 'How many?', defaultValue: defaultCount },
    build: (value) => {
      const count = amount(value)
      return count === undefined ? undefined : { action: 'devGrantItem', item, count }
    },
  }
}

export const DEV_SCENARIOS: DevScenario[] = [
  // ---- spending synthetic tokens: these run the real pipeline ----
  {
    id: 'add-tokens',
    group: 'tokens',
    label: 'Add tokens',
    detail: 'Injects fictitious tokens into the observation (accepts 250M, 1.5B)',
    input: { kind: 'amount', prompt: 'Tokens to add', defaultValue: '50M' },
    build: (value) => {
      const parsed = amount(value)
      return parsed === undefined
        ? undefined
        : { action: 'devAddTokens', provider: 'claude_code', amount: parsed }
    },
  },
  {
    id: 'to-milestone',
    group: 'tokens',
    label: 'Just enough for the next milestone',
    detail: 'Hatch, evolution or graduation — whichever is next. Computed, never a fixed number.',
    input: { kind: 'none' },
    build: () => ({ action: 'devAddToMilestone', scope: 'next' }),
  },
  {
    id: 'to-graduation',
    group: 'tokens',
    label: 'All the way to graduation',
    detail: 'Walks the whole line and files it in the Pokédex',
    input: { kind: 'none' },
    build: () => ({ action: 'devAddToMilestone', scope: 'graduation' }),
  },
  {
    id: 'work-burst',
    group: 'tokens',
    label: 'Simulate a spell of work (5 steps)',
    detail: 'Five increments in a row, to watch the bar move like it does in real use',
    input: { kind: 'none' },
    steps: 5,
    build: () => ({ action: 'devAddTokens', provider: 'claude_code', amount: 20 * M }),
  },
  {
    id: 'clear-offsets',
    group: 'tokens',
    label: 'Drop every fictitious token',
    detail: 'Back to the real observation. The ledger treats the drop as a regression and rebases.',
    input: { kind: 'none' },
    build: () => ({ action: 'devClearOffsets' }),
  },

  // ---- wallet and items ----
  {
    id: 'add-balance',
    group: 'items',
    label: 'Add spendable balance',
    detail: 'Raises usedSinceInstall so the shop becomes affordable',
    input: { kind: 'amount', prompt: 'Balance to add', defaultValue: '5B' },
    build: (value) => {
      const parsed = amount(value)
      return parsed === undefined ? undefined : { action: 'devGrantTokens', amount: parsed }
    },
  },
  grantItem('rareCandy', '5'),
  grantItem('mint', '2'),
  grantItem('shinyCharm', '1'),

  // ---- states that are impractical to reach by chance ----
  {
    id: 'shiny-on',
    group: 'state',
    label: 'Make the current one shiny',
    detail: '1 in 64 in production; here, directly',
    input: { kind: 'none' },
    build: () => ({ action: 'devSetShiny', value: true }),
  },
  {
    id: 'shiny-off',
    group: 'state',
    label: 'Remove the shiny',
    detail: '',
    input: { kind: 'none' },
    build: () => ({ action: 'devSetShiny', value: false }),
  },
  {
    id: 'ditto-on',
    group: 'state',
    label: 'Disguise as Ditto',
    detail: '1 in 128. Revealed when the first evolution threshold is reached.',
    input: { kind: 'none' },
    build: () => ({ action: 'devSetDitto', value: true }),
  },
  {
    id: 'ditto-off',
    group: 'state',
    label: 'Remove the Ditto disguise',
    detail: '',
    input: { kind: 'none' },
    build: () => ({ action: 'devSetDitto', value: false }),
  },
  {
    id: 'egg-tier',
    group: 'state',
    label: 'Guarantee a tier for the egg',
    detail: 'Pretends a premium egg was bought, without spending',
    input: {
      kind: 'choice',
      prompt: 'Which guarantee?',
      defaultValue: 'none',
      options: [
        { value: 'none', label: 'No guarantee' },
        { value: 'uncommon', label: 'Uncommon or better' },
        { value: 'rare', label: 'Rare or better' },
      ],
    },
    // Legendary is deliberately absent: capture_rate cannot express it, so the egg would never
    // hatch. `sanitized()` drops it on load and the shop refuses to sell it.
    build: (value) =>
      value === 'uncommon' || value === 'rare'
        ? { action: 'devSetEggTier', tier: value }
        : { action: 'devSetEggTier' },
  },

  // ---- edge cases the accounting has to survive ----
  {
    id: 'day-rollover',
    group: 'edge',
    label: 'Simulate a day change',
    detail: "Forces the ledger's rollover branch on the next refresh",
    input: { kind: 'none' },
    build: () => ({ action: 'devDayRollover' }),
  },

  // ---- safety net ----
  {
    id: 'snapshot-save',
    group: 'reset',
    label: 'Save a copy of the game',
    detail: 'A point to come back to before experimenting',
    input: { kind: 'none' },
    build: () => ({ action: 'devSnapshot', slot: 'save' }),
  },
  {
    id: 'snapshot-restore',
    group: 'reset',
    label: 'Restore the copy',
    detail: 'Back to the last saved point',
    input: { kind: 'none' },
    build: () => ({ action: 'devSnapshot', slot: 'restore' }),
  },
  {
    id: 'reset-save',
    group: 'reset',
    label: 'Start from scratch',
    detail: 'Deletes the game and the fictitious tokens. No way back except the copy.',
    input: { kind: 'none' },
    confirm: 'The game will be deleted, Pokédex included. The fictitious tokens are cleared too.',
    build: () => ({ action: 'devResetSave' }),
  },
]

export function devScenarioByID(id: string): DevScenario | undefined {
  return DEV_SCENARIOS.find((scenario) => scenario.id === id)
}

/**
 * The state the Dev tab shows above the buttons, already formatted.
 *
 * It answers the two questions you actually ask while testing: how far the companion is from
 * the next event, and how much of what you are seeing is synthetic.
 */
export function devSummary(state: CompanionState, dev: DevState): { label: string; value: string }[] {
  const milestone = tokensToMilestone(state)
  const offsets = Object.entries(dev.offsetByProvider).filter(([, value]) => value !== 0)
  const rows = [
    {
      label: 'Companion',
      value:
        state.active === undefined
          ? `egg · ${compact(state.eggUsage)} incubated`
          : `#${state.active.baseID} · stage ${state.active.stageIndex + 1}/${state.active.totalForms} · ${state.active.rarity}`,
    },
    { label: `To next ${milestone.label}`, value: compact(milestone.amount) },
    { label: 'To graduation', value: compact(tokensToGraduation(state)) },
    { label: 'Lifetime tokens', value: compact(state.usedSinceInstall) },
    { label: 'Spent in the shop', value: compact(state.spentTokens) },
    {
      label: 'Synthetic offsets',
      value:
        offsets.length === 0
          ? 'none'
          : offsets.map(([provider, value]) => `${provider} +${compact(value)}`).join(' · '),
    },
  ]
  // Only shown when set, because a date override silently changes what every later refresh means.
  if (dev.dateOverride !== undefined) {
    rows.push({ label: 'Date override', value: dev.dateOverride })
  }
  return rows
}
