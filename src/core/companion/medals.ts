/**
 * Medals: intermediate goals on a road of one to two years. Pure.
 *
 * Every medal is a condition on the save — registered species, shinies, catches, a line raised
 * to its end, a region complete — and derives its progress from the registry each time, so it
 * can never disagree with it. The save only keeps which medals were already *celebrated*
 * (`medals`), so each is announced once; a save from before medals gets what it already meets
 * silently (`medalsSeeded`).
 */

import type { CompanionState } from './model.js'
import { REGIONS, type RegionID, regionProgress } from './regions.js'

export type MedalKind = 'registered' | 'shiny' | 'caught' | 'line' | 'region'

export interface Medal {
  id: string
  kind: MedalKind
  /** The count it asks for; for a region, its size. */
  target: number
  region?: RegionID
}

export const MEDALS: readonly Medal[] = [
  ...[1, 10, 50, 100, 250, 649].map((n) => ({
    id: `registered-${n}`,
    kind: 'registered' as const,
    target: n,
  })),
  ...[1, 10, 50].map((n) => ({ id: `shiny-${n}`, kind: 'shiny' as const, target: n })),
  ...[10, 100, 1000].map((n) => ({ id: `caught-${n}`, kind: 'caught' as const, target: n })),
  { id: 'line-1', kind: 'line', target: 1 },
  ...REGIONS.map((r) => ({
    id: `region-${r.id}`,
    kind: 'region' as const,
    target: r.to - r.from + 1,
    region: r.id,
  })),
]

/** How far the save is toward a medal. `undefined` for an id the catalogue does not hold. */
export function medalProgress(
  state: CompanionState,
  medalID: string,
): { current: number; target: number } | undefined {
  const medal = MEDALS.find((m) => m.id === medalID)
  if (medal === undefined) return undefined
  return { current: medalCount(state, medal), target: medal.target }
}

function medalCount(state: CompanionState, medal: Medal): number {
  const species = Object.values(state.species)
  switch (medal.kind) {
    case 'registered':
      return species.filter((p) => p.registered).length
    case 'shiny':
      return species.filter((p) => p.shinyRegistered === true).length
    case 'caught': {
      // The registry counts catches per species; a save from before it counts them in the catch
      // log. Whichever is larger, so an older save does not lose what it caught.
      const counted = species.reduce((sum, p) => sum + p.caught, 0)
      const logged = state.dex.filter((e) => e.source === 'wild').length
      return Math.max(counted, logged)
    }
    case 'line':
      return state.dex.filter((e) => e.source === undefined).length
    case 'region':
      return regionProgress(state).find((r) => r.id === medal.region)?.registered ?? 0
  }
}

/** Every medal the save meets now. */
export function metMedals(state: CompanionState): string[] {
  return MEDALS.filter((m) => medalCount(state, m) >= m.target).map((m) => m.id)
}

/**
 * Records the medals newly met and says which, to be announced. The first call on a save from
 * before medals records what it already meets and announces nothing.
 */
export function awardMedals(state: CompanionState): { state: CompanionState; newly: string[] } {
  const celebrated = new Set(state.medals ?? [])
  const met = metMedals(state)
  const fresh = met.filter((id) => !celebrated.has(id))
  if (state.medalsSeeded !== true) {
    return { state: { ...state, medals: [...celebrated, ...fresh], medalsSeeded: true }, newly: [] }
  }
  if (fresh.length === 0) return { state, newly: [] }
  return { state: { ...state, medals: [...celebrated, ...fresh] }, newly: fresh }
}
