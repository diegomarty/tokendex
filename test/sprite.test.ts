import { describe, expect, it } from 'vitest'
import { ANIMATED_SPECIES_MAX, hasAnimatedSprite, stillSpriteURL } from '../src/core/companion/model.js'
import {
  ANIMATED_SPRITE_MAX,
  hasAnimatedSprite as webviewHasAnimatedSprite,
  itemSpriteIsSheet,
  itemSpriteURL,
  menuIconURL,
  sceneSpriteURL,
  spriteURL,
} from '../src/webview/sprite.js'

// The webview cannot import the core — different bundle, no Node — so the Gen-V ceiling exists in
// both trees. This file is what makes that copy safe: it is the only place where both are in scope.

describe('the animated-sprite ceiling', () => {
  it('agrees across the bundle boundary', () => {
    // If these ever diverge, the hatch pool draws species the UI cannot animate (or the UI asks
    // for GIFs that do not exist), and the symptom is a broken image for one species in a hundred.
    expect(ANIMATED_SPRITE_MAX).toBe(ANIMATED_SPECIES_MAX)
  })

  it('classifies the boundaries the same way', () => {
    for (const id of [0, 1, 648, 649, 650, 1025]) {
      expect(webviewHasAnimatedSprite(id), `species ${id}`).toBe(hasAnimatedSprite(id))
    }
  })
})

describe('spriteURL', () => {
  it('uses the Gen-V animated path inside the range', () => {
    expect(spriteURL(25, false, true)).toBe(
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/25.gif',
    )
    expect(spriteURL(25, true, true)).toContain('/animated/shiny/25.gif')
  })

  // [trigger branch] Asking for an animation that does not exist used to be answered with a URL
  // that 404s, which shows a broken image on every render until the request fails.
  it('falls back to the still sprite outside the range', () => {
    expect(spriteURL(700, false, true)).toBe(
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/700.png',
    )
    expect(spriteURL(700, true, true)).toContain('/shiny/700.png')
  })

  it('returns the still sprite when no animation is asked for', () => {
    expect(spriteURL(6, false, false)).toContain('/pokemon/6.png')
    expect(spriteURL(6, true, false)).toContain('/pokemon/shiny/6.png')
  })

  // [trigger branch] The encounter scene bottom-aligns trainer, companion and wild on one
  // ground line, which holds only while every creature in it is a frame cropped to its feet.
  // The still sheet is not: it centres the art on a 96px canvas over a variable amount of
  // transparent floor, so a scene built from stills stands each species at its own height.
  // Asking for `animated: false` here is the regression, and it is invisible in a still image
  // of one species — hence a test rather than a screenshot.
  it('always asks for the cropped animated frame for anything standing in the scene', () => {
    for (const id of [1, 25, 133, 649]) {
      expect(sceneSpriteURL(id, false)).toBe(spriteURL(id, false, true))
      expect(sceneSpriteURL(id, false)).toMatch(/\.gif$/)
      expect(sceneSpriteURL(id, true)).toContain('/animated/shiny/')
    }
  })

  // The status bar tooltip is the one *core* consumer of a sprite URL, and the core cannot
  // import the webview's builder. This is the pin that makes that second copy safe — the same
  // arrangement the animated ceiling above lives under.
  it('agrees with the core still-sprite URL used by the tooltip', () => {
    for (const id of [1, 25, 649]) {
      expect(stillSpriteURL(id, false)).toBe(spriteURL(id, false, false))
      expect(stillSpriteURL(id, true)).toBe(spriteURL(id, true, false))
    }
  })
})

// The egg is not an item: PokéAPI keeps it with the Pokémon, on their 96px sheet. Named `egg` by
// the core like any item sprite, it has to resolve there — the items folder's egg.png is a fried egg — and
// be flagged as a sheet, so the 30px icon box crops its middle instead of shrinking it.
describe('the egg sprite', () => {
  it('resolves to the Pokémon sheet, not the items folder', () => {
    expect(itemSpriteURL('egg')).toBe(
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/egg.png',
    )
    expect(itemSpriteURL('poke-ball')).toBe(
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/poke-ball.png',
    )
  })

  // [trigger branch] The small spots (a drawer's icon, the stock slots, a shop row) take the
  // games' menu egg: a 40×30 icon with the egg ~16px, at the scale of the item sprites beside
  // it. The sheet's 28×30 crop at ×1 filled its box and read as twice their size.
  it('has a menu icon for the small spots, at the item sprites’ scale', () => {
    expect(itemSpriteURL('egg-icon')).toBe(
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-vii/icons/egg.png',
    )
    expect(itemSpriteIsSheet('egg-icon')).toBe(false)
  })

  it('is the one icon drawn from a full sheet', () => {
    expect(itemSpriteIsSheet('egg')).toBe(true)
    expect(itemSpriteIsSheet('poke-ball')).toBe(false)
  })
})

// The battle menu's "Pokémon" button carries the companion as the games' party menu draws it: the
// small menu icon, served by PokéAPI at runtime like every sprite, never bundled.
describe('menuIconURL', () => {
  it('points at the party-menu icon of the species', () => {
    expect(menuIconURL(25)).toBe(
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-vii/icons/25.png',
    )
  })
})
