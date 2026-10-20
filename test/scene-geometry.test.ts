import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The encounter scene is a diorama: a Showdown trainer, the companion and — when one is
// waiting — a wild Pokémon, all standing on one floor. Nothing about that arrangement is
// expressible in the core (it is pure layout), so the only place it can be pinned is the
// stylesheet itself. It is worth pinning because every part of it is a bare number that
// reads as arbitrary: a later hand nudging `top` by 8px to "centre" a sprite silently lifts
// one creature off the ground the other two stand on, and nothing fails.

// Walked up rather than taken from `process.cwd()`, the arrangement `usage-environment.test.ts`
// already uses: a guard that quietly inspects nothing is worse than no guard.
const CSS = readFileSync(
  (() => {
    let dir = process.cwd()
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'src', 'webview', 'styles.css')
      if (existsSync(candidate)) return candidate
      dir = join(dir, '..')
    }
    throw new Error('src/webview/styles.css not found — the guard cannot verify anything')
  })(),
  'utf8',
)

/**
 * Declarations of one rule, by its exact selector list.
 *
 * Comments go first so a selector quoted inside prose cannot match, and the block pattern
 * forbids braces in both halves — which is what makes it skip the `@media (...)` wrapper
 * instead of swallowing it into a selector.
 */
function rule(selector: string): Record<string, string> {
  const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = [...withoutComments.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(
    (m) => (m[1] ?? '').trim().replace(/\s+/g, ' ') === selector,
  )
  expect(blocks, `exactly one \`${selector}\` rule`).toHaveLength(1)
  const out: Record<string, string> = {}
  for (const line of (blocks[0]?.[2] ?? '').split(';')) {
    const at = line.indexOf(':')
    if (at === -1) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/** The px number of one declaration. `calc(10% + 54px)` is not one, and must not parse as 54. */
function px(selector: string, property: string): number {
  const raw = rule(selector)[property]
  expect(raw, `${selector} { ${property} }`).toMatch(/^-?\d+px$/)
  return Number.parseInt(raw ?? '', 10)
}

/** PokéAPI still sheets and the Gen-V animated frames are drawn on a 96px canvas. */
const SHEET = 96

describe('the encounter scene', () => {
  // A battle layout has two floors, as the games do: your side stands on its platform at the
  // bottom left, the wild Pokémon on its own up and to the right. Each sprite must land *on* its
  // platform — a later hand nudging one number would otherwise leave a creature hovering over,
  // or sunk into, the ellipse it is drawn standing on.

  /** The vertical band a platform covers, from its top edge down. */
  function band(selector: string, top: number): { from: number; to: number } {
    return { from: top, to: top + px(selector, 'height') }
  }

  // The trainer is the human reference and the only sprite with no wiggle room: 80px is the
  // Showdown sheet at native size. Your side is anchored to the bottom, so the line is a bottom.
  it('stands the companion on the trainer’s ground line', () => {
    expect(px('.companion-mon', 'bottom')).toBe(px('.wild-scene .trainer', 'bottom'))
  })

  // Measured from the scene's bottom edge: the platform's band is [bottom, bottom + height].
  it('puts your side’s feet on your platform', () => {
    const feet = px('.wild-scene .trainer', 'bottom')
    const from = px('.pad-player', 'bottom')
    expect(feet).toBeGreaterThanOrEqual(from)
    expect(feet).toBeLessThanOrEqual(from + px('.pad-player', 'height'))
  })

  // [trigger branch] The wild side is top-anchored: its feet are where its box ends.
  it('puts the wild Pokémon’s feet on its platform', () => {
    const feet = px('.wild-mon', 'top') + px('.wild-mon', 'height')
    const pad = band('.pad-wild', px('.pad-wild', 'top'))
    expect(feet).toBeGreaterThanOrEqual(pad.from)
    expect(feet).toBeLessThanOrEqual(pad.to)
  })

  // [trigger branch] Centred on its platform, not just above it. The box used to be anchored at
  // `right: 7%` and sized by the sprite, so its centre moved with every frame width while the
  // platform's stayed put: a slim Scyther stood off to the right edge of its ellipse. Same right
  // edge and same width as the platform is the one arrangement whose centres agree for any
  // sprite and any panel width.
  it('centres the wild Pokémon on its platform', () => {
    expect(rule('.wild-mon')['right']).toBe(rule('.pad-wild')['right'])
    expect(px('.wild-mon', 'width')).toBe(px('.pad-wild', 'width'))
    expect(rule('.wild-mon')['justify-content']).toBe('center')
  })

  // [trigger branch] The wild side's platform is ground, not sky. With the horizon at 62% it sat
  // a fifth of the scene above the grass line — an ellipse of turf floating in the air. The
  // horizon is a registered property (terrains interpolate it), so its default is the
  // `initial-value` of that registration.
  it('puts the horizon above the wild Pokémon’s platform', () => {
    const declared = /@property --horizon\s*\{[^}]*initial-value:\s*(\d+)%/.exec(CSS)?.[1]
    expect(declared, '@property --horizon { initial-value }').toBeDefined()
    const horizon = Number(declared) / 100
    expect(horizon * px('.wild-scene', 'height')).toBeLessThanOrEqual(px('.pad-wild', 'top'))
    expect(horizon * px('.battle .wild-scene.has-wild', 'height')).toBeLessThanOrEqual(
      px('.battle .wild-scene.has-wild .pad-wild', 'top'),
    )
  })

  // The narrow layout moves the wild side down, below its plate. It has to move the platform
  // with it, or the Pokémon steps off.
  it('keeps the wild Pokémon on its platform in a narrow sidebar', () => {
    const feet = px('.battle .wild-scene.has-wild .wild-mon', 'top') + px('.wild-mon', 'height')
    const pad = band('.pad-wild', px('.battle .wild-scene.has-wild .pad-wild', 'top'))
    expect(feet).toBeGreaterThanOrEqual(pad.from)
    expect(feet).toBeLessThanOrEqual(pad.to)
    expect(px('.battle .wild-scene.has-wild', 'height')).toBeGreaterThan(pad.to)
  })

  // [trigger branch] The follower is the sprite that was NOT native-sized — a 48px square,
  // half Game Freak's own scale and a squash for every non-square frame. Pinning a size back
  // on is both the regression that shrinks it again and the one that lifts it off the floor,
  // because a sized box no longer ends where the frame's feet do.
  it.each(['.companion-mon img', '.wild-mon img'])('lets %s render at native ×1', (selector) => {
    const declarations = rule(selector)
    expect(Object.keys(declarations)).not.toContain('width')
    expect(Object.keys(declarations)).not.toContain('height')
    // Native means whole pixels, which is the only scale `pixelated` is exact at.
    expect(declarations['image-rendering']).toBe('pixelated')
  })

  it.each(['.companion-mon', '.wild-mon'])('bottom-aligns the frame in %s', (selector) => {
    // The frame is cropped to the feet, so "bottom of the box" and "standing on the line" are
    // the same statement only while it is flex-end.
    expect(rule(selector)['align-items']).toBe('flex-end')
  })

  it('gives the companion the whole sheet to stand in', () => {
    // The box is the 96px sheet the frames are drawn on, so the widest of them (Wailord's
    // 103px) is centred rather than cornered.
    expect(px('.companion-mon', 'width')).toBe(SHEET)
    expect(px('.companion-mon', 'height')).toBe(SHEET)
  })

  it('leaves the quiet scene room for a full-size follower', () => {
    // No wild side — just the team standing there — so this is the short scene and the one
    // that would clip a tall companion: the sheet, standing on the line, has to fit.
    expect(px('.wild-scene:not(.has-wild)', 'height')).toBeGreaterThan(
      px('.companion-mon', 'bottom') + SHEET,
    )
  })
})

describe('the compact card’s companion', () => {
  // The Explorer card is a glance, not a stage: it keeps the sprite at a clean fraction of the
  // sheet rather than growing with the scene. "Clean" is the whole point — the old 34px
  // fractional sizes elsewhere in this file are recorded as having been unreadable smudges.
  it('divides the sheet evenly', () => {
    const size = px('body.compact .stage img', 'width')
    expect(SHEET % size).toBe(0)
    expect(px('body.compact .stage img', 'height')).toBe(size)
    expect(px('body.compact .stage', 'width')).toBe(size)
  })
})

describe('the battle menu', () => {
  // Item sprites are drawn on a 30px canvas. Both menu levels show them at that native size —
  // the only one `pixelated` is exact at — so stepping from the commands into Balls or Berries
  // never changes the size of the icon under the cursor.
  const ITEM_SHEET = 30

  it('draws the commands’ icons at the size of the items behind them', () => {
    expect(px('.command-icon', 'width')).toBe(px('.command.item img', 'width'))
    expect(px('.command-icon', 'height')).toBe(px('.command.item img', 'height'))
    expect(px('.command.item img', 'width')).toBe(ITEM_SHEET)
    // The balls' row too: the same sprites, so the same size.
    expect(px('.ball-sprite img', 'width')).toBe(ITEM_SHEET)
    expect(px('.ball-sprite img', 'height')).toBe(ITEM_SHEET)
  })
})
