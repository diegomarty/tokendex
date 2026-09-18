/**
 * Records the README's hero GIF from the real shipped bundles.
 *
 *   node tools/bench/record.mjs [url] [seconds] [outfile]
 *
 * Starts the bench server itself, loads `shot.html` (by default with an auto-thrown Ultra Ball
 * so the full capture choreography plays), records a webm with playwright-core against the
 * browser `chromium.mjs` finds, and turns it into a palette-optimised GIF with ffmpeg. The GIF
 * therefore shows the exact animation the extension ships — not a mock-up.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { chromiumPath } from './chromium.mjs'
import { buildAll } from '../../esbuild.mjs'

const url =
  process.argv[2] ??
  'http://localhost:4321/tools/bench/shot.html?fixture=wild-queue&tab=home&throw=ultraBall&at=1600'
const seconds = Number(process.argv[3] ?? 8)
const outfile = process.argv[4] ?? 'media/readme/hero.gif'

await buildAll({ dev: true, watch: false })
const { spawn } = await import('node:child_process')
const server = spawn('node', ['tools/bench/serve.mjs'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1500))

try {
  const dir = mkdtempSync(join(tmpdir(), 'tokendex-rec-'))
  const browser = await chromium.launch({ executablePath: chromiumPath() })
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    recordVideo: { dir, size: { width: 360, height: 640 } },
  })
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForTimeout(seconds * 1000)
  await context.close()
  await browser.close()

  const webm = readdirSync(dir).find((f) => f.endsWith('.webm'))
  if (webm === undefined) throw new Error('no video recorded')
  // Two-pass palette: a GIF quantised without one bands the dark theme's gradients badly.
  execFileSync('ffmpeg', [
    '-y',
    '-i',
    join(dir, webm),
    '-vf',
    'fps=12,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    outfile,
  ])
  console.log(`wrote ${outfile}`)
} finally {
  server.kill()
}
