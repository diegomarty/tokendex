/**
 * The shape of a species' Pokédex entry as PokéAPI tells it, apart from the client that reads
 * it: `pokeapi.ts` pulls in Node (paths, the disk cache), and the panel's entry builder and the
 * development bench — type-checked with the webview — only need the shape.
 */

import type { BaseStats } from './companion/encounters.js'
import type { PokemonType } from './companion/model.js'

/**
 * A species' Pokédex entry as PokéAPI tells it (plan 9.7): what the species card shows beyond the
 * game's own progress. Texts are keyed by app language (`ko`, `en`, `ja`, `es`); Japanese is the
 * kana text (`ja-Hrkt`) the UI writes in, the kanji one only when there is no kana.
 */
export interface DexDetails {
  id: number
  captureRate: number
  /** "EleSpider Pokémon", by language. */
  genus: Record<string, string>
  /** The newest Pokédex text the games wrote in each language, on one line. */
  flavor: Record<string, string>
  /** PokéAPI units: decimetres and hectograms. Absent with the stats when `/pokemon` failed. */
  heightDm?: number
  weightHg?: number
  types?: PokemonType[]
  stats?: BaseStats
}
