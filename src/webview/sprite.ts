/**
 * PokéAPI sprite URLs, shared by every webview surface.
 *
 * It lives in the webview tree rather than in `src/core` because a webview cannot import the core
 * at all — different bundle, no Node. The rules below are therefore duplicated across that
 * boundary, which is only safe because a test pins them together; see the note on
 * `ANIMATED_SPRITE_MAX`.
 *
 * Sprites are fetched from PokéAPI at runtime and never bundled — a licence obligation, not a size
 * decision. Keep the Pokémon disclaimer in the README.
 */

export const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'

/** PokéAPI item sprites, used for the pokéballs in the ball rack and the bag. 30x30. */
export const ITEM_SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items'

/**
 * Pokémon Showdown's trainer sprites, 80x80. The **second** remote host this project talks to,
 * and it needs its own `img-src` entry in the CSP (`surface.ts`) — without it the avatar is
 * silently blank, with nothing in the panel to say why.
 *
 * Showdown has no back-facing trainer sprites (`trainers-back/` is a 404), so the encounter
 * scene stands the trainer front-on, the way a Gen-1 trainer card does.
 */
export const TRAINER_SPRITE_BASE = 'https://play.pokemonshowdown.com/sprites/trainers'

/**
 * PokéAPI's Gen-V animated assets only exist for national dex #1…649.
 *
 * Mirrors `ANIMATED_SPECIES_MAX` in `core/companion/model.ts`, which the hatch pool uses to avoid
 * ever drawing a species that cannot be animated. `test/sprite.test.ts` fails if the two numbers
 * stop agreeing — that test is the only thing making this copy safe.
 */
export const ANIMATED_SPRITE_MAX = 649

export function hasAnimatedSprite(speciesID: number): boolean {
  return speciesID >= 1 && speciesID <= ANIMATED_SPRITE_MAX
}

/**
 * URL for one species.
 *
 * `animated` is a request, not a promise: outside the Gen-V range there is no GIF, so this returns
 * the still sprite instead of a URL that 404s. Relying on the error fallback there would show a
 * broken image for as long as the request takes to fail, on every render.
 */
export function spriteURL(speciesID: number, shiny: boolean, animated: boolean): string {
  if (animated && hasAnimatedSprite(speciesID)) {
    const directory = shiny ? 'animated/shiny' : 'animated'
    return `${SPRITE_BASE}/versions/generation-v/black-white/${directory}/${speciesID}.gif`
  }
  return `${SPRITE_BASE}/${shiny ? 'shiny/' : ''}${speciesID}.png`
}

/**
 * The sprite for anything *standing in the encounter scene* — the wild Pokémon and the
 * companion at the trainer's side.
 *
 * The scene bottom-aligns every creature on one ground line, and that only works with a
 * tight-cropped frame. The Gen-V animated sheet is cropped to the art, so its bottom edge *is*
 * the feet. The still sheet is not: it centres the art on a 96px canvas with however much
 * transparent floor is left over — 8px under a Charizard, 33px under a Bulbasaur — so a still
 * either hovers or sinks, by a different amount per species, and no CSS offset can fix all of
 * them at once. The follower used to be a still pinned to 48px, which hid the problem by being
 * too small to read.
 *
 * Outside the Gen-V range `spriteURL` returns the still anyway; the companion is never in that
 * case (the hatch pool is pruned by `keepingAnimatedSprites`), and a wild one would simply
 * stand a few pixels off.
 */
export function sceneSpriteURL(speciesID: number, shiny: boolean): string {
  return spriteURL(speciesID, shiny, true)
}

/**
 * The small icon the games' party menu draws a Pokémon with: Gen VII's set, 40×30, species 1–809.
 * Newer species have none, so a caller gives the still sprite as its `data-fallback`.
 */
export function menuIconURL(speciesID: number): string {
  return `${SPRITE_BASE}/versions/generation-vii/icons/${speciesID}.png`
}

/**
 * The egg's sprite is not an item: PokéAPI keeps it with the Pokémon, on their 96px sheet with
 * the egg drawn in the middle 28×30.
 */
const EGG_SPRITE = 'egg'
/**
 * The egg as the games' menus draw it, for the small spots beside item sprites: Gen VII's 40×30
 * icon, the egg ~16px — the scale of an item's drawing in its 30px box. The sheet's 28×30 crop
 * filled the same box and read twice as big. The large egg stays on stage.
 */
const EGG_ICON = 'egg-icon'

/** One item sprite, by its PokéAPI filename (`poke-ball`, `rare-candy`, ...) — or the egg. */
export function itemSpriteURL(name: string): string {
  if (name === EGG_SPRITE) return `${SPRITE_BASE}/egg.png`
  if (name === EGG_ICON) return `${SPRITE_BASE}/versions/generation-vii/icons/egg.png`
  return `${ITEM_SPRITE_BASE}/${name}.png`
}

/**
 * Whether an icon comes from a full 96px sheet rather than a 30px item sheet. Shrinking it to
 * the icon box would be a fractional scale of pixel art; the box crops its middle instead.
 */
export function itemSpriteIsSheet(name: string): boolean {
  return name === EGG_SPRITE
}

/** The player's avatar. The slug comes from the core's roster and is never built here. */
export function trainerURL(slug: string): string {
  return `${TRAINER_SPRITE_BASE}/${slug}.png`
}
