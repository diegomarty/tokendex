/**
 * The five generations the game covers, by Pokédex number: what divides a 649-species Pokédex
 * into goals of ~150. A table, not a rule — the games define them. Pure.
 */

import type { CompanionState } from './model.js'

export const REGIONS = [
  { id: 'kanto', from: 1, to: 151 },
  { id: 'johto', from: 152, to: 251 },
  { id: 'hoenn', from: 252, to: 386 },
  { id: 'sinnoh', from: 387, to: 493 },
  { id: 'unova', from: 494, to: 649 },
] as const

export type RegionID = (typeof REGIONS)[number]['id']

export function regionOf(speciesID: number): (typeof REGIONS)[number] | undefined {
  return REGIONS.find((r) => speciesID >= r.from && speciesID <= r.to)
}

/** Registered species per region, against the region's size. */
export function regionProgress(
  state: CompanionState,
): { id: RegionID; registered: number; shinyRegistered: number; total: number }[] {
  const counts = new Map<RegionID, number>()
  const shinies = new Map<RegionID, number>()
  for (const [id, p] of Object.entries(state.species)) {
    const region = regionOf(Number(id))
    if (region === undefined) continue
    if (p.registered) counts.set(region.id, (counts.get(region.id) ?? 0) + 1)
    // The Shinydex's own count (Diego): a region's shinies, not its registrations.
    if (p.shinyRegistered === true) shinies.set(region.id, (shinies.get(region.id) ?? 0) + 1)
  }
  return REGIONS.map((r) => ({
    id: r.id,
    registered: counts.get(r.id) ?? 0,
    shinyRegistered: shinies.get(r.id) ?? 0,
    total: r.to - r.from + 1,
  }))
}
