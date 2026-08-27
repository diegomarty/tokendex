/**
 * The player's avatar: a curated roster of Pokémon Showdown trainer sprites.
 *
 * Showdown serves ~1,500 trainer sprites. Offering all of them would be a wall of pictures, so
 * this is a hand-picked set: the mainline protagonists people recognise, then the classic
 * trainer classes that read well at 80 px.
 *
 * **Only slugs live here.** The URL is built in `src/webview/sprite.ts`, because the core never
 * knows how the webview loads an image — the same split the PokéAPI sprites already use. Every
 * slug in this list was verified to return HTTP 200 at
 * `https://play.pokemonshowdown.com/sprites/trainers/<slug>.png`; `test/trainers.test.ts` pins
 * their shape, not their existence, since a test must not hit the network.
 *
 * Like every other sprite in this project these are fetched at runtime and never bundled.
 */

/** Ordered as the Settings grid draws them: protagonists first, then trainer classes. */
export const TRAINER_IDS = [
  'red',
  'blue',
  'leaf',
  'ethan',
  'lyra',
  'brendan',
  'may',
  'lucas',
  'dawn',
  'hilbert',
  'hilda',
  'nate',
  'rosa',
  'calem',
  'serena',
  'youngster',
  'bugcatcher',
  'lass',
  'hiker',
  'beauty',
  'sailor',
  'camper',
  'picnicker',
  'psychic',
  'blackbelt',
  'scientist',
  'firebreather',
  'birdkeeper',
] as const

export type TrainerID = (typeof TRAINER_IDS)[number]

/**
 * The avatar before anyone chooses one. `red` rather than a random pick: a random default would
 * differ between the sidebar and the editor tab on first paint, and would change again on any
 * machine the save is imported to.
 */
export const DEFAULT_TRAINER_ID: TrainerID = 'red'

export function isTrainerID(value: string): value is TrainerID {
  return (TRAINER_IDS as readonly string[]).includes(value)
}

/** The slug to draw: the chosen one when it is still in the roster, the default otherwise. */
export function trainerIDOrDefault(value: string | undefined): TrainerID {
  return value !== undefined && isTrainerID(value) ? value : DEFAULT_TRAINER_ID
}
