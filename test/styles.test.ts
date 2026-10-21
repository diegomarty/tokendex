import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceRoot } from './repoRoot.js'

// The webview's stylesheet is drawn from named tokens (docs/plans/08-ui-unificada.md): one block
// at the top of `styles.css` names every colour, size and duration, by layer — the device, the
// paper, the counter. These guards keep it that way. Each counted one is a ratchet: it may only
// go down, and the number here is lowered as each step of the plan lands.

const CSS = readFileSync(join(sourceRoot(), 'webview', 'styles.css'), 'utf8')
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const SCRIPT = readFileSync(join(sourceRoot(), 'webview', 'main.ts'), 'utf8')

/** Every `property: value;` in the sheet, custom properties included. */
const declarations = [...CODE.matchAll(/([-a-zA-Z]+)\s*:\s*([^;{}]+);/g)].map((m) => ({
  property: m[1] ?? '',
  value: m[2] ?? '',
}))

/** The selector of every top-level rule, normalised; at-rules and their contents left out. */
function topLevelSelectors(): string[] {
  const selectors: string[] = []
  let depth = 0
  let buffer = ''
  for (const c of CODE) {
    if (c === '{') {
      if (depth === 0) selectors.push(buffer.trim().replace(/\s+/g, ' '))
      depth++
      buffer = ''
    } else if (c === '}') {
      depth--
      buffer = ''
    } else if (depth === 0) buffer += c
  }
  return selectors.filter((s) => !s.startsWith('@'))
}

describe('the stylesheet', () => {
  // A colour belongs in a token — a custom property — and is used by name. Terrains are tokens
  // too (each scene sets its own `--sky-top`, `--ground-top`…), so they are not counted.
  it('keeps literal colours to custom properties, and their number only falls', () => {
    const literals = declarations
      .filter((d) => !d.property.startsWith('--'))
      .flatMap((d) => d.value.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [])
    expect(literals.length).toBeLessThanOrEqual(115)
  })

  it('takes pixel font sizes from the type scale, and their number only falls', () => {
    const raw = declarations.filter((d) => d.property === 'font-size' && /^\s*[\d.]+px/.test(d.value))
    expect(raw.length).toBeLessThanOrEqual(24)
  })

  // [trigger branch] A token used but never defined is an empty value, and the browser drops the
  // declaration without a word — exactly how a rename leaves half the sheet on the old name.
  it('defines every token it uses', () => {
    // Defined in the sheet, or set at runtime by the webview through the CSSOM (the throw's arc).
    const runtime = [...SCRIPT.matchAll(/setProperty\(\s*'(--[-a-zA-Z0-9]+)'/g)].map((m) => m[1] ?? '')
    const defined = new Set([
      ...declarations.filter((d) => d.property.startsWith('--')).map((d) => d.property),
      ...runtime,
    ])
    const used = [...CODE.matchAll(/var\(\s*(--[-a-zA-Z0-9]+)/g)].map((m) => m[1] ?? '')
    const missing = [...new Set(used)].filter(
      (name) => !name.startsWith('--vscode-') && !defined.has(name),
    )
    expect(missing).toEqual([])
  })

  // A rule written twice is a later layer silently overriding an earlier one: what the element
  // looks like then depends on the order of a 4,000-line file. A shared rule beside a specific
  // one (`.a, .b {}` then `.a {}`) is fine; the same selector list twice is not.
  it('writes every top-level rule once', () => {
    const seen = new Map<string, number>()
    for (const selector of topLevelSelectors()) seen.set(selector, (seen.get(selector) ?? 0) + 1)
    const twice = [...seen].filter(([, n]) => n > 1).map(([selector]) => selector)
    expect(twice).toEqual([])
  })

  // [trigger branch] One bar for the game: a bar drawn any other way is a second look for the
  // same idea. The only `.bar` the webview may write by hand is the counter's (official limits);
  // everything else goes through `gameMeter()`.
  it('draws every game bar through gameMeter', () => {
    for (const retired of ['.reg-bar', '.exp-track', '.catch-reg-bar', '.bar.gauge', '.exp-line'])
      expect(CODE, retired).not.toContain(retired)
    const handWritten = [...SCRIPT.matchAll(/class="bar"/g)].length
    expect(handWritten, 'hand-written `class="bar"` in main.ts (the limits are the one allowed)').toBe(1)
  })

  // [trigger branch] A span on a meter's track (a gain, a loss, the bar that was) is an `<i>` like
  // the fill, so `.game-meter .bar.game-meter-track i` paints it unless the span's rule outranks
  // it: the catch card's gain was never white for that reason. Each one names the track in full.
  it('lets a span on the track outrank the fill it sits on', () => {
    const spans = topLevelSelectors().filter((s) => /game-meter-track \./.test(s))
    expect(spans.length).toBeGreaterThan(0)
    for (const selector of spans)
      for (const part of selector.split(','))
        expect(part.trim(), selector).toMatch(/^\.game-meter(\.[-a-z]+)* \.bar\.game-meter-track \./)
  })

  it('names the three layers at the top, before any rule', () => {
    const tokens = CSS.indexOf('---- tokens ----')
    expect(tokens).toBeGreaterThan(-1)
    expect(tokens).toBeLessThan(CSS.indexOf('box-sizing'))
    for (const token of [
      '--device-casing',
      '--lcd-glass',
      '--paper',
      '--ink',
      '--track',
      '--fs-m',
      '--r-l',
      '--t-mid',
    ])
      expect(CSS.slice(0, CSS.indexOf('box-sizing'))).toContain(`${token}:`)
  })
})
