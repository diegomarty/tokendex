import { describe, expect, it } from 'vitest'
import { ANIMATED_SPECIES_MAX, hasAnimatedSprite, stillSpriteURL } from '../src/core/companion/model.js'
import {
  ANIMATED_SPRITE_MAX,
  hasAnimatedSprite as webviewHasAnimatedSprite,
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
