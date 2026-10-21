import { describe, expect, it } from 'vitest'
import { pokedexEntry } from '../src/core/panel/dexEntry.js'
import {
  freshCompanionState,
  freshSpeciesProgress,
  makeEvoLine,
  type CompanionState,
  type SpeciesProgress,
} from '../src/core/companion/model.js'
import type { DexDetails } from '../src/core/pokeapi.js'
import * as D from '../src/core/i18n/dispatch.js'

// Plan 9.7: the species card is a Pokédex entry. Everything it shows is formatted here, so the
// webview only lays it out.

const details: DexDetails = {
  id: 596,
  captureRate: 75,
  genus: { en: 'EleSpider Pokémon', es: 'Pokémon Electroaraña' },
  flavor: { en: 'It employs an electrically charged web.', es: 'Teje una tela electrificada.' },
  heightDm: 8,
  weightHg: 143,
  types: ['bug', 'electric'],
  stats: { hp: 70, attack: 77, defense: 60, specialAttack: 97, specialDefense: 60, speed: 108 },
}

// Joltik → Galvantula, and a made-up branch beside it so the stage order is pinned.
const line = makeEvoLine(
  595,
  {
    speciesID: 595,
    children: [
      { speciesID: 596, children: [] },
      { speciesID: 597, children: [] },
    ],
  },
  'common',
  {
    595: { en: 'Joltik', es: 'Joltik' },
    596: { en: 'Galvantula', es: 'Galvantula' },
    597: { en: 'Secret', es: 'Secreto' },
  },
)

const progress = (over: Partial<SpeciesProgress>): SpeciesProgress => ({
  ...freshSpeciesProgress(),
  ...over,
})

const save = (lang: 'en' | 'es', species: Record<number, SpeciesProgress>): CompanionState => ({
  ...freshCompanionState(lang),
  language: lang,
  species,
})

describe('pokedexEntry', () => {
  it('fills the whole entry for an obtained species, in the language’s own numbers', () => {
    const state = save('es', { 595: progress({ unlocked: true }), 596: progress({ unlocked: true }) })
    const entry = pokedexEntry(state, 596, details, line)
    expect(entry.genusText).toBe('Pokémon Electroaraña')
    expect(entry.flavorText).toBe('Teje una tela electrificada.')
    // A Spanish reader meets the decimal comma, like every other number in the panel.
    expect(entry.heightText).toBe('0,8 m')
    expect(entry.weightText).toBe('14,3 kg')
    expect(entry.types).toEqual([
      { id: 'bug', label: D.typeName('es', 'bug') },
      { id: 'electric', label: D.typeName('es', 'electric') },
    ])
    expect(entry.stats!.map((s) => s.label)).toEqual([
      'PS',
      'Ataque',
      'Defensa',
      'At. Esp.',
      'Def. Esp.',
      'Velocidad',
    ])
    expect(entry.stats![5]).toMatchObject({
      key: 'speed',
      value: 108,
      valueText: '108',
      percent: Math.round((108 / 255) * 100),
    })
    expect(entry.statTotalText).toContain('472')
    expect(entry.lockedText).toBeUndefined()
    expect(entry.unavailableText).toBeUndefined()
  })

  // [trigger branch] As in the games: seen is a name, a genus and types. The text, the size and
  // the stats are the reward for obtaining it.
  it('keeps the entry text, size and stats back while the species is only seen', () => {
    const entry = pokedexEntry(save('en', { 596: progress({ seen: true }) }), 596, details, line)
    expect(entry.genusText).toBe('EleSpider Pokémon')
    expect(entry.types).toHaveLength(2)
    expect(entry.flavorText).toBeUndefined()
    expect(entry.heightText).toBeUndefined()
    expect(entry.stats).toBeUndefined()
    expect(entry.lockedText).toBe(D.dexEntryLockedText('en'))
  })

  it('walks the line in stage order and never names a form not yet seen', () => {
    const state = save('en', {
      595: progress({ registered: true, unlocked: true }),
      596: progress({ seen: true }),
    })
    const entry = pokedexEntry(state, 596, details, line)
    expect(entry.line.map((f) => [f.id, f.stage, f.status, f.isThis])).toEqual([
      [595, 0, 'registered', false],
      [596, 1, 'seen', true],
      [597, 1, 'unknown', false],
    ])
    expect(entry.line.map((f) => f.name)).toEqual(['Joltik', 'Galvantula', '???'])
  })

  // [trigger branch] No network and no cache: the card says so, and still shows the line it has.
  it('says the entry is unavailable when PokéAPI could not be read', () => {
    const entry = pokedexEntry(save('en', { 596: progress({ unlocked: true }) }), 596, undefined, line)
    expect(entry.unavailableText).toBe(D.dexEntryUnavailableText('en'))
    expect(entry.flavorText).toBeUndefined()
    expect(entry.line).toHaveLength(3)
  })
})
