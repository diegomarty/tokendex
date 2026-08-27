/**
 * Development-only simulation layer.
 *
 * The governing decision: fake tokens are injected into the **observation**, never into the
 * saved state. That way they travel the real pipeline — provider ledger, crediting, growth,
 * hatching, evolution, graduation — so what you see is the production behaviour rather than a
 * mock of it. Writing straight into `usedSinceInstall` would look the same on screen while
 * skipping every rule worth exercising.
 *
 * The offset is cumulative and persisted separately from the save, so it survives a reload and
 * can be rewound without touching real accounting.
 */

import type {
  CompanionState,
  ItemKind,
  PokemonNature,
  Rarity,
  WildEncounter,
} from '../companion/model.js'
import { BALL_KINDS, PokemonBalance } from '../companion/model.js'
import { enqueueEncounter } from '../companion/encounters.js'

export interface DevState {
  /** Synthetic tokens added to each provider's observed daily total, by provider id. */
  offsetByProvider: Record<string, number>
  /** Overrides the date fed to the ledger, for exercising the day-rollover branch. */
  dateOverride?: string
  /** Forces the display state regardless of real burn rate. */
  burnOverride?: 'idle' | 'normal' | 'fast' | 'blazing'
  limitWarningOverride?: boolean
}

export function freshDevState(): DevState {
  return { offsetByProvider: {} }
}

/**
 * Applies the offsets to an observation.
 *
 * Offsets are *added* to whatever was really observed, so real usage keeps flowing through at
 * the same time — the simulation rides on top of reality instead of replacing it.
 */
export function applyDevOffsets(
  todayTokensByProvider: Record<string, number>,
  dev: DevState,
): Record<string, number> {
  const out = { ...todayTokensByProvider }
  for (const [provider, offset] of Object.entries(dev.offsetByProvider)) {
    if (offset === 0) continue
    out[provider] = (out[provider] ?? 0) + offset
  }
  return out
}

export function addOffset(dev: DevState, provider: string, amount: number): DevState {
  return {
    ...dev,
    offsetByProvider: {
      ...dev.offsetByProvider,
      [provider]: (dev.offsetByProvider[provider] ?? 0) + amount,
    },
  }
}

export function clearOffsets(dev: DevState): DevState {
  return { ...dev, offsetByProvider: {} }
}

/**
 * Parses `1500`, `250M`, `1.5B`.
 *
 * Lives here rather than beside the menu so it can be tested without pulling in `vscode`:
 * anything under `src/core/` is free of the editor API by design. Typing ten zeros by hand
 * invites an order-of-magnitude mistake, which is the whole point of the suffixes.
 */
export function parseAmount(raw: string): number {
  const match = /^\s*([\d.]+)\s*([kKmMbB]?)\s*$/.exec(raw)
  if (match === null) return Number.NaN
  const value = Number(match[1])
  if (!Number.isFinite(value)) return Number.NaN
  const scale = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[(match[2] ?? '').toLowerCase()] ?? 1
  return Math.round(value * scale)
}

// MARK: - Scenario planning

/**
 * How many synthetic tokens reach the next milestone from here.
 *
 * Computed rather than typed in by hand, because the thresholds scale with rarity and stage
 * count — a hard-coded "add 250M" stops meaning anything the moment a rare line hatches.
 */
export function tokensToMilestone(state: CompanionState): { label: string; amount: number } {
  const active = state.active
  if (active === undefined) {
    return {
      label: 'hatch',
      amount: Math.max(1, PokemonBalance.eggHatchThreshold - state.eggUsage),
    }
  }
  const threshold = PokemonBalance.phaseThreshold(active.rarity, active.totalForms, active.stageIndex)
  const remaining = Math.max(1, threshold - active.usedAtStage)
  const isFinal = active.stageIndex >= active.totalForms - 1
  return { label: isFinal ? 'graduation' : 'evolution', amount: remaining }
}

/** Everything still needed to graduate the current line from where it stands. */
export function tokensToGraduation(state: CompanionState): number {
  const active = state.active
  if (active === undefined) {
    return PokemonBalance.eggHatchThreshold - state.eggUsage + PokemonBalance.graduationTotal('common')
  }
  let total = 0
  for (let stage = active.stageIndex; stage < active.totalForms; stage++) {
    const threshold = PokemonBalance.phaseThreshold(active.rarity, active.totalForms, stage)
    total += stage === active.stageIndex ? Math.max(0, threshold - active.usedAtStage) : threshold
  }
  return Math.max(1, total)
}

// MARK: - Direct state pokes
//
// These bypass the pipeline on purpose, for states that are otherwise impractical to reach
// (a shiny is 1-in-64, a Ditto 1-in-128). Anything reachable by spending tokens should be
// driven with an offset instead, so the real rules run.

export function grantItem(state: CompanionState, item: ItemKind, count: number): CompanionState {
  return {
    ...state,
    inventory: { ...state.inventory, [item]: Math.max(0, (state.inventory[item] ?? 0) + count) },
  }
}

/** What a wild-encounter test session needs in one click: a working stock of every ball. */
export function grantBalls(state: CompanionState, count: number): CompanionState {
  const inventory = { ...state.inventory }
  for (const kind of BALL_KINDS) inventory[kind] = Math.max(0, (inventory[kind] ?? 0) + count)
  return { ...state, inventory }
}

export type TestEncounterVariant = 'common' | 'rare' | 'legendary' | 'shiny'

/**
 * Fixed species per variant, chosen for recognisability at a glance in the queue. Hardcoded
 * names are fine here: this is the dev surface, and going through PokéAPI would make "test the
 * capture flow on a plane" impossible.
 */
const TEST_SPECIES: Record<
  TestEncounterVariant,
  { id: number; captureRate: number; rarity: Rarity; name: string }
> = {
  common: { id: 10, captureRate: 255, rarity: 'common', name: 'Caterpie' },
  rare: { id: 147, captureRate: 45, rarity: 'rare', name: 'Dratini' },
  legendary: { id: 150, captureRate: 3, rarity: 'legendary', name: 'Mewtwo' },
  shiny: { id: 129, captureRate: 255, rarity: 'common', name: 'Magikarp' },
}

/**
 * Queues a synthetic wild encounter, bypassing accrual and the network — the point is to test
 * the *capture* flow, and reaching a legendary through the real pipeline would take days.
 * Uses `enqueueEncounter` so the queue cap and its rarity-aware drop still apply.
 */
export function spawnTestEncounter(state: CompanionState, variant: string, now: number): CompanionState {
  const species = TEST_SPECIES[variant as TestEncounterVariant] ?? TEST_SPECIES.common
  const encounter: WildEncounter = {
    id: `dev-${now}-${Math.floor(now % 997)}-${state.wild.length}`,
    speciesID: species.id,
    captureRate: species.captureRate,
    rarity: species.rarity,
    isShiny: variant === 'shiny',
    appearedAt: now,
    throws: 0,
    names: { en: species.name, ko: species.name, ja: species.name, es: species.name },
  }
  return { ...state, wild: enqueueEncounter(state.wild, encounter) }
}

export function grantTokens(state: CompanionState, amount: number): CompanionState {
  return { ...state, usedSinceInstall: state.usedSinceInstall + amount }
}

export function setShiny(state: CompanionState, value: boolean): CompanionState {
  if (state.active === undefined) return state
  return { ...state, active: { ...state.active, isShiny: value } }
}

export function setNature(state: CompanionState, nature: PokemonNature): CompanionState {
  if (state.active === undefined) return state
  return { ...state, active: { ...state.active, nature } }
}

/** Puts a disguised Ditto in place, ready to reveal at the next evolution threshold. */
export function setDittoDisguise(state: CompanionState, on: boolean): CompanionState {
  if (state.active === undefined) return state
  const active = { ...state.active, dittoRevealed: false }
  if (on) active.dittoDisguise = 132
  else delete active.dittoDisguise
  return { ...state, active }
}

export function setEggTier(state: CompanionState, tier: Rarity | undefined): CompanionState {
  const next: CompanionState = { ...state }
  if (tier === undefined) delete next.eggTier
  else next.eggTier = tier
  return next
}
