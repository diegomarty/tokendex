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
  // The trainer is the human reference and the only sprite with no wiggle room: 80px is the
  // Showdown sheet at native size. Everyone else is placed against where its feet land.
  const ground = px('.wild-scene .trainer', 'top') + px('.wild-scene .trainer', 'height')

  it('stands the wild Pokémon on the trainer’s ground line', () => {
    expect(px('.wild-mon', 'top') + px('.wild-mon', 'height')).toBe(ground)
  })

  // [trigger branch] The companion is the sprite whose box does NOT end at its feet — the
  // still sheet pads the art — so it is the one a later nudge is most likely to lift off the
  // floor. Its container bottom is the line; the compensation lives on the image.
  it('stands the companion on the trainer’s ground line', () => {
    expect(px('.companion-mon', 'top') + px('.companion-mon', 'height')).toBe(ground)
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
    // 103px) is centred rather than cornered, and the ground line arithmetic above stays one
    // subtraction rather than a per-species table.
    expect(px('.companion-mon', 'width')).toBe(SHEET)
    expect(px('.companion-mon', 'height')).toBe(SHEET)
  })

  it('leaves the quiet scene room for a full-size follower', () => {
    // No rack, no title — just the team standing there — so this is the short scene and the
    // one that would clip a tall companion. It has to clear the ground line, not just reach it.
    expect(px('.wild-scene:not(.has-wild)', 'min-height')).toBeGreaterThan(ground)
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
