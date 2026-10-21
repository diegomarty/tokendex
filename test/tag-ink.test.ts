import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceRoot } from './repoRoot.js'

// Plan 9.9. A pill (`.tag`) brings its own fill and ink (`--tag-fill`, `--tag-ink`). The catch
// card's detail became a `.tag.gain` while an older rule still painted its text `var(--gain)`:
// green on green, an empty green pill. The class a pill carries for its *place* must leave its
// colours to the pill.

const CSS = readFileSync(join(sourceRoot(), 'webview', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const SCRIPT = readFileSync(join(sourceRoot(), 'webview', 'main.ts'), 'utf8')

/** Every static class list the webview writes: `class="tag gain catch-detail${x}"` → its words. */
const classLists = [...SCRIPT.matchAll(/class="([^"]*)"/g)].map((m) =>
  (m[1] ?? '')
    .replace(/\$\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .filter((c) => /^[a-z][-a-z0-9]*$/.test(c)),
)

/** Classes only ever written beside `tag`: a pill's place, not a modifier shared elsewhere. */
const pillOnly = (() => {
  const withTag = new Set<string>()
  const without = new Set<string>()
  for (const list of classLists) {
    for (const c of list) (list.includes('tag') ? withTag : without).add(c)
  }
  return [...withTag].filter((c) => c !== 'tag' && !without.has(c))
})()

/** `selector { body }` pairs, nested at-rules flattened. */
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? '').trim().replace(/\s+/g, ' '),
  body: m[2] ?? '',
}))

describe('a pill’s colours', () => {
  it('finds the pills it guards', () => {
    expect(pillOnly).toContain('catch-detail')
  })

  it('are never repainted by the class that places it', () => {
    const offenders: string[] = []
    for (const { selector, body } of rules) {
      if (!/(^|[;\s])(color|background(-color)?)\s*:/.test(body)) continue
      for (const part of selector.split(',')) {
        // The element the rule paints is the last compound of the selector.
        const last =
          part
            .trim()
            .split(/[\s>+~]+/)
            .pop() ?? ''
        if (last.includes('.tag')) continue
        const hit = pillOnly.find((c) => new RegExp(`\\.${c}(?![-a-z0-9])`).test(last))
        if (hit !== undefined) offenders.push(`${part.trim()} (.${hit})`)
      }
    }
    expect(offenders).toEqual([])
  })
})
