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
