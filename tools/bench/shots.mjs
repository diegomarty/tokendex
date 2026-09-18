/**
 * Regenerates the README's still captures from the real shipped bundles.
 *
 *   node tools/bench/shots.mjs [name ...]
 *
 * The companion to `record.mjs`, which does the same for the hero GIF. Both start the bench
 * server themselves and drive `shot.html`, so what lands in `media/readme/` is the actual
 * webview rendering the actual `PanelState` the core builds — never a mock-up.
 *
 * It exists because these four were captured by hand, which is why they kept drifting: the
 * shipped images showed copy, prices and a shop layout the extension had long stopped sending.
 * Pass names to redo a subset (`node tools/bench/shots.mjs dex`).
 *
 * Sizes are the ones the README's `<img width>` attributes were laid out against; changing one
 * here means changing the table there too.
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { buildAll } from '../../esbuild.mjs'
import { chromiumPath } from './chromium.mjs'

const PORT = 4399
const OUT = 'media/readme'

/**
 * `wait` is for the sprites: they are fetched from PokéAPI at runtime (a licence obligation,
 * not an optimisation), so a screenshot taken too early catches empty frames.
 */
const SHOTS = [
  { name: 'home', query: 'fixture=branching&tab=home', width: 360, height: 700 },
  { name: 'shop', query: 'fixture=wild-queue&tab=shop', width: 360, height: 700 },
  { name: 'settings', query: 'fixture=wild-queue&tab=settings', width: 360, height: 520 },
  { name: 'dex', query: 'fixture=dex-full&tab=dex&dex=6', width: 920, height: 620 },
]

const wanted = process.argv.slice(2)
const shots = wanted.length === 0 ? SHOTS : SHOTS.filter((s) => wanted.includes(s.name))
if (shots.length === 0) {
  console.error(`no such shot: ${wanted.join(', ')} — have ${SHOTS.map((s) => s.name).join(', ')}`)
  process.exit(1)
}

await buildAll({ dev: true, watch: false })
await mkdir(OUT, { recursive: true })
const server = spawn('node', ['tools/bench/serve.mjs'], {
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT) },
})
await new Promise((resolve) => setTimeout(resolve, 1500))

try {
  const browser = await chromium.launch({ executablePath: chromiumPath() })
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: { width: shot.width, height: shot.height },
    })
    const page = await context.newPage()
    // A page error would otherwise be published as a screenshot of a half-rendered panel.
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://localhost:${PORT}/tools/bench/shot.html?${shot.query}`)
    await page.waitForTimeout(3500)
    if (errors.length > 0) throw new Error(`${shot.name}: ${errors.join(' | ')}`)
    await page.screenshot({ path: `${OUT}/${shot.name}.png` })
    console.log(`wrote ${OUT}/${shot.name}.png (${shot.width}x${shot.height})`)
    await context.close()
  }
  await browser.close()
} finally {
  server.kill()
}
