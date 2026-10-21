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

  // [trigger branch] The narrow layout is one width, not one per zone. With four (a 300px media
  // query, containers at 300, 310 and 320 — panels of 324, 334 and 344px), each zone switched on
  // its own, and between them a plate was narrow while its percentage pill was not, and the name
  // clipped. Two names: `narrow` (340px, where the battle menu's three across stop fitting —
  // measured) and `squeezed` (300px, where the page itself gives up air). Text that may or may not
  // fit in a given language is measured by the webview (`fitTight`), never given a width here.
  it('switches to the narrow layout at one width', () => {
    const widths = [...CODE.matchAll(/@(media|container)[^{]*max-width:\s*(\d+)px/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    )
    expect(widths.length).toBeGreaterThan(0)
    expect([...new Set(widths)].sort()).toEqual(['media 300', 'media 340'])
  })

  // [trigger branch] The lid, the Pokédex and the shop wear one head (plan 09 §9.2): the same
  // casing row — lens, three lights, the title in the TOKENDEX logo's style, a screen on the
  // right — drawn by one rule, so the three cannot drift apart in height, padding or type. Diego
  // saw the Pokédex's next to the lid with its title off-centre and its count loose in white.
  it('draws the lid and the tab heads as one head', () => {
    const shared = topLevelSelectors().filter((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .includes('.wallet-bar'),
    )
    const both = shared.find((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .includes('.device-head'),
    )
    expect(both, 'one rule for `.wallet-bar` and `.device-head`').toBeDefined()
    const pattern = (both ?? '')
      .split(',')
      .map((p) => p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s*,\\s*')
    const body = new RegExp(`(?:^|})\\s*${pattern}\\s*\\{([^}]*)\\}`).exec(CODE)?.[1] ?? ''
    for (const property of ['min-height', 'padding', 'border-radius', 'align-items'])
      expect(body, `${property} in the shared head rule`).toContain(`${property}:`)
    // The titles are the logo's, in capitals from the stylesheet (the core's words unchanged).
    expect(/\.brand-name\s*\{[^}]*text-transform:\s*uppercase/.test(CODE)).toBe(true)
    expect(SCRIPT).not.toContain('class="dex-title"')
    expect([...SCRIPT.matchAll(/deviceHead\(/g)].length).toBeGreaterThanOrEqual(3)
  })

  // [trigger branch] One bar for a Pokémon's road (plan 09 §9.10): the companion plate's EXP bar,
  // drawn by `expMeter()` — the only place the games' "EXP" is printed. A registration or
  // experience bar drawn straight with `gameMeter` is a second look for the same thing.
  it('draws every experience and registration bar as the plate’s EXP bar', () => {
    expect([...SCRIPT.matchAll(/glyph: 'EXP'/g)].length, "`glyph: 'EXP'` outside expMeter()").toBe(1)
    const straight = [
      ...SCRIPT.matchAll(/gameMeter\(\s*(sp\.percent|reg\.toPercent|item\.percent|c\.expPercent)\b/g),
    ].map((m) => m[1])
    expect(straight, 'a road drawn with gameMeter instead of expMeter').toEqual([])
    expect([...SCRIPT.matchAll(/expMeter\(/g)].length).toBeGreaterThanOrEqual(7)
  })

  // [trigger branch] Plan 9.12 #9. With the registry, the species of the Pokémon being raised is
  // the player's for good; a dashed card said "not yours yet", the "seen" look, on something owned.
  it('draws no "raising" marker on a Pokédex card', () => {
    expect(CODE).not.toMatch(/\.dex \.cell\.raising/)
    expect(SCRIPT).not.toMatch(/isRaising \? ' raising'/)
  })

  // [trigger branch] Plan 9.12 #15. A figure the player reads is the core's text, never a number
  // the webview prints itself: `${stat.value}` and `${f.count}` were two, now `valueText` and
  // `countText`. Machine values (`aria-valuenow`…) are numbers by nature and are not counted.
  // The ×N of items and the log's filter counts followed (`countText`), so none is left.
  it('prints no raw count or value as text', () => {
    const raw = [...SCRIPT.matchAll(/(aria-value\w+="|)\$\{[\w.?]+\.(count|value)\}/g)].filter(
      (m) => m[1] === '',
    )
    expect(SCRIPT).not.toMatch(/\$\{stat\.value\}|\$\{f\.count\}/)
    expect(
      raw.map((m) => m[0]),
      'raw `${….count}` / `${….value}` printed as text',
    ).toEqual([])
  })

  // One button per layer: the game's paper `.btn`, its priced screen and the battle `.command`.
  // VS Code's blue `button.action` belongs to the counter — only the developer tab draws one now.
  it('draws the game buttons as .btn, leaving VS Code’s blue to the counter', () => {
    const native = [...SCRIPT.matchAll(/class="action\b/g)].length
    expect(native, '`class="action` in main.ts (the developer tab is the one allowed)').toBe(1)
    for (const retired of [
      '.dialog-action:hover',
      '.save-actions .action',
      ':is(#shop, .lcd-actions) button',
    ])
      expect(CODE, retired).not.toContain(retired)
  })

  // One pill: every short label is a `.tag`, sized and coloured by meaning, not a family of its own.
  it('draws every pill as a .tag', () => {
    for (const retired of ['.badge.wild', '.status.primed', '.status.stolen', '.wallet-delta.gain'])
      expect(CODE, retired).not.toContain(retired)
    for (const pill of [
      'rarity-badge',
      'plate-pct',
      'risk-item',
      'catch-detail',
      'challenge-reward',
      'companion-tag',
    ])
      expect(SCRIPT, pill).not.toMatch(new RegExp(`class="(?!tag\\b)[^"]*\\b${pill}\\b`))
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
