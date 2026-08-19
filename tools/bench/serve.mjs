/**
 * Static server for the development bench, with esbuild watching in the same process.
 *
 * One command, no dependencies: `npm run bench`. It serves the repository root so the page can
 * pull `/dist/webview.css`, `/dist/webview.js` and `/dist/bench/app.js` — the very files the
 * extension ships — and it stamps them at `/__bench/stamp` so the page repaints itself when a
 * rebuild lands.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAll } from '../../esbuild.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const port = Number(process.env['PORT'] ?? 4321)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  // The codicon font: without a font MIME type the browser refuses it and every icon becomes a box.
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** mtime + size of the built bundles: enough to notice a rebuild, cheap enough to poll. */
async function stamp() {
  const of = async (relative) => {
    try {
      const info = await stat(join(root, relative))
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'missing'
    }
  }
  const [js, css, app] = await Promise.all([
    of('dist/webview.js'),
    of('dist/webview.css'),
    of('dist/bench/app.js'),
  ])
  return { webview: `${js}+${css}`, app }
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://localhost:${port}`)

    if (url.pathname === '/__bench/stamp') {
      response.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(await stamp()))
      return
    }

    const relative =
      url.pathname === '/' ? 'tools/bench/index.html' : decodeURIComponent(url.pathname).slice(1)
    const path = resolve(root, relative)
    // Everything is served from the repository, so anything resolving outside it is a traversal
    // attempt, not a mistake worth guessing about.
    if (path !== root && !path.startsWith(root + sep)) {
      response.writeHead(403).end('forbidden')
      return
    }

    try {
      const body = await readFile(path)
      response.writeHead(200, {
        'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
        // Never cache: the whole point is seeing the file you just saved.
        'Cache-Control': 'no-store',
      })
      response.end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })()
})

await buildAll({ dev: true, watch: true })
server.listen(port, '127.0.0.1', () => {
  console.log(`\n  bench   http://localhost:${port}`)
  console.log('  esbuild            watching src/ and tools/\n')
})
