/**
 * The starters a new game offers: the fifteen the gen 1–5 games open with, three per
 * generation. A table, not a rule — there is nothing to derive them from.
 */

import type { AppLanguage, PokemonType } from './model.js'

export const STARTERS = [1, 4, 7, 152, 155, 158, 252, 255, 258, 387, 390, 393, 495, 498, 501] as const

export type StarterID = (typeof STARTERS)[number]

export const isStarterID = (v: unknown): v is StarterID =>
  typeof v === 'number' && (STARTERS as readonly number[]).includes(v)

/** Primary type of each starter, for the picker's scenery; the sprites come from PokéAPI. */
const STARTER_TYPES: Record<StarterID, PokemonType> = {
  1: 'grass',
  4: 'fire',
  7: 'water',
  152: 'grass',
  155: 'fire',
  158: 'water',
  252: 'grass',
  255: 'fire',
  258: 'water',
  387: 'grass',
  390: 'fire',
  393: 'water',
  495: 'grass',
  498: 'fire',
  501: 'water',
}

export function starterType(id: StarterID): PokemonType {
  return STARTER_TYPES[id]
}

/** Official names, in AppLanguage order: ko, en, ja, es. Offline, because the picker runs before any line is fetched. */
const STARTER_NAMES: Record<StarterID, [string, string, string, string]> = {
  1: ['이상해씨', 'Bulbasaur', 'フシギダネ', 'Bulbasaur'],
  4: ['파이리', 'Charmander', 'ヒトカゲ', 'Charmander'],
  7: ['꼬부기', 'Squirtle', 'ゼニガメ', 'Squirtle'],
  152: ['치코리타', 'Chikorita', 'チコリータ', 'Chikorita'],
  155: ['브케인', 'Cyndaquil', 'ヒノアラシ', 'Cyndaquil'],
  158: ['리아코', 'Totodile', 'ワニノコ', 'Totodile'],
  252: ['나무지기', 'Treecko', 'キモリ', 'Treecko'],
  255: ['아차모', 'Torchic', 'アチャモ', 'Torchic'],
  258: ['물짱이', 'Mudkip', 'ミズゴロウ', 'Mudkip'],
  387: ['모부기', 'Turtwig', 'ナエトル', 'Turtwig'],
  390: ['불꽃숭이', 'Chimchar', 'ヒコザル', 'Chimchar'],
  393: ['팽도리', 'Piplup', 'ポッチャマ', 'Piplup'],
  495: ['주리비얀', 'Snivy', 'ツタージャ', 'Snivy'],
  498: ['뚜꾸리', 'Tepig', 'ポカブ', 'Tepig'],
  501: ['수댕이', 'Oshawott', 'ミジュマル', 'Oshawott'],
}

const LANG_INDEX: Record<AppLanguage, 0 | 1 | 2 | 3> = { ko: 0, en: 1, ja: 2, es: 3 }

export function starterName(id: StarterID, lang: AppLanguage): string {
  return STARTER_NAMES[id][LANG_INDEX[lang]]
}
