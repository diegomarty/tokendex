/**
 * The species card as a Pokédex entry (plan 9.7): PokéAPI's genus, text, size and stats, and the
 * evolution line, formatted for the card. Pure; the worker fetches, this only reads.
 *
 * As in the games, a species only seen gives its genus and types; the text, the size and the
 * stats are the reward for obtaining it.
 */

import type { BaseStats } from '../companion/encounters.js'
import { type CompanionState, type EvoLine, type EvoNode, resolveName } from '../companion/model.js'
import type { DexDetails } from '../dexDetails.js'
import * as D from '../i18n/dispatch.js'
import type { PanelPokedexEntry } from '../../webview/protocol.js'

/** The games' order. */
const STATS: (keyof BaseStats)[] = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed']

/** The ceiling a base stat is drawn against: the highest one a Pokémon can have. */
const STAT_MAX = 255

type Status = PanelPokedexEntry['line'][number]['status']

function statusOf(state: CompanionState, speciesID: number): Status {
  const progress = state.species[speciesID]
  if (progress?.registered === true) return 'registered'
  if (progress?.unlocked === true) return 'unlocked'
  if (progress?.seen === true) return 'seen'
  return 'unknown'
}

/** The line's forms, breadth first: a branch's forms share a stage. */
function forms(node: EvoNode, stage = 0): { id: number; stage: number }[] {
  const out: { id: number; stage: number }[] = []
  let level = [node]
  for (let depth = stage; level.length > 0; depth++) {
    for (const form of level) out.push({ id: form.speciesID, stage: depth })
    level = level.flatMap((form) => form.children)
  }
  return out
}

export function pokedexEntry(
  state: CompanionState,
  speciesID: number,
  details: DexDetails | undefined,
  line: EvoLine | undefined,
): PanelPokedexEntry {
  const lang = state.language
  const labels = D.dexEntryLabels(lang)
  const status = statusOf(state, speciesID)
  const obtained = status === 'unlocked' || status === 'registered'
  const entry: PanelPokedexEntry = {
    speciesID,
    types: (details?.types ?? []).map((type) => ({ id: type, label: D.typeName(lang, type) })),
    heightLabel: labels.height,
    weightLabel: labels.weight,
    statsTitle: labels.stats,
    lineTitle: labels.line,
    line: (line === undefined ? [{ id: speciesID, stage: 0 }] : forms(line.tree)).map((form) => {
      const formStatus = statusOf(state, form.id)
      const names = line?.names[form.id]
      const name = formStatus === 'unknown' || names === undefined ? undefined : resolveName(lang, names)
      return { ...form, name: name ?? '???', status: formStatus, isThis: form.id === speciesID }
    }),
  }
  if (details === undefined) {
    entry.unavailableText = D.dexEntryUnavailableText(lang)
    return entry
  }
  const genus = details.genus[lang] ?? details.genus['en']
  if (genus !== undefined) entry.genusText = genus
  if (!obtained) {
    entry.lockedText = D.dexEntryLockedText(lang)
    return entry
  }
  const flavor = details.flavor[lang] ?? details.flavor['en']
  if (flavor !== undefined) entry.flavorText = flavor
  if (details.heightDm !== undefined)
    entry.heightText = D.dexMeasureText(lang, details.heightDm / 10, 'm')
  if (details.weightHg !== undefined)
    entry.weightText = D.dexMeasureText(lang, details.weightHg / 10, 'kg')
  const stats = details.stats
  if (stats !== undefined) {
    entry.stats = STATS.map((key) => ({
      key,
      label: D.statLabel(lang, key),
      value: stats[key],
      valueText: String(stats[key]),
      percent: Math.round((stats[key] / STAT_MAX) * 100),
    }))
    entry.statTotalText = D.statTotalText(
      lang,
      STATS.reduce((sum, key) => sum + stats[key], 0),
    )
  }
  return entry
}
