/**
 * Build for every bundle in the repo.
 *
 * Flags:
 *   --watch        rebuild on change (esbuild context API, ~20 ms per pass)
 *   --dev          also build the development-only bundles (bench, tools)
 *   --production   minify
 *
 * The dev bundles are gated behind `--dev` so a packaging build can never ship them; the
 * belt-and-braces `dist/bench` / `dist/tools` entries in `.vscodeignore` are the second guard.
 */

import { context } from 'esbuild'
import { constants, copyFile, mkdir } from 'node:fs/promises'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // No sourcemap in production: `.vscodeignore` excludes `**/*.map`, so shipping the comment
  // would leave a dangling sourceMappingURL pointing at a file the `.vsix` does not contain.
  sourcemap: !flag('production'),
  minify: flag('production'),
  logLevel: 'info',
}

/** Shipped in the `.vsix`. */
const shipped = [
  // The extension host provides `vscode` at runtime; bundling it would fail.
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  },
  { ...shared, entryPoints: ['src/worker/scanWorker.ts'], outfile: 'dist/scanWorker.js' },
  // The webview runs in a browser context: IIFE, no Node builtins.
  {
    ...shared,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
  },
  {
    ...shared,
    entryPoints: ['src/webview/styles.css'],
    outfile: 'dist/webview.css',
    bundle: false,
  },
]

/**
 * Development only. The bench renders the real webview bundle against fixture `PanelState`s in
 * a plain browser, which is the fast loop for UI work; the tools are node scripts that need
 * no editor at all. Both are ESM (`.mjs`) because they use top-level await.
 */
const development = [
  {
    ...shared,
    entryPoints: ['tools/bench/app.ts'],
    outfile: 'dist/bench/app.js',
    platform: 'browser',
    format: 'iife',
  },
  {
    // The README screenshot harness (shot.html) — one fixture, full window, screenshot-clean.
    ...shared,
    entryPoints: ['tools/bench/shot.ts'],
    outfile: 'dist/bench/shot.js',
    platform: 'browser',
    format: 'iife',
  },
  {
    ...shared,
    entryPoints: ['tools/status-preview.ts'],
    outfile: 'dist/tools/status-preview.mjs',
    format: 'esm',
  },
  {
    ...shared,
    entryPoints: ['tools/scan-real.ts'],
    outfile: 'dist/tools/scan-real.mjs',
    format: 'esm',
  },
]

/**
 * `sql.js` ships SQLite as WebAssembly. esbuild bundles its JS glue but not the `.wasm`, and
 * `src/core/usage/sqlite.ts` resolves it with `locateFile` next to the bundle — so it has to be
 * copied into `dist/`. Missing it makes every SQLite provider report nothing, silently.
 *
 * Copied rather than declared `external` so `vsce package --no-dependencies` still produces a
 * self-contained `.vsix`.
 */
/**
 * VS Code's own icon font, so the webview can draw the same glyphs as the rest of the editor
 * instead of emoji. It is not exposed to webviews automatically: the two files have to be served
 * from the extension, which is why they are copied next to the bundle.
 *
 * A devDependency rather than a runtime one — the files are copied at build time, so
 * `vsce package --no-dependencies` still produces a self-contained `.vsix`.
 */
async function copyCodicons() {
  const base = 'node_modules/@vscode/codicons/dist'
  try {
    await mkdir('dist/codicons', { recursive: true })
    for (const file of ['codicon.css', 'codicon.ttf']) {
      await copyFile(`${base}/${file}`, `dist/codicons/${file}`, constants.COPYFILE_FICLONE)
    }
  } catch (error) {
    console.warn(`  warning: could not copy the codicons (${error.code ?? error.message})`)
  }
}

async function copyWasm() {
  const source = 'node_modules/sql.js/dist/sql-wasm.wasm'
  try {
    await mkdir('dist', { recursive: true })
    await copyFile(source, 'dist/sql-wasm.wasm', constants.COPYFILE_FICLONE)
  } catch (error) {
    // Not fatal: the SQLite providers are optional, and `npm ci` may not have run yet.
    console.warn(`  warning: could not copy ${source} (${error.code ?? error.message})`)
  }
}

/** Builds once, or starts watching. Reused by `tools/bench/serve.mjs`. */
export async function buildAll({ dev = false, watch = false } = {}) {
  const configs = dev ? [...shipped, ...development] : shipped
  await copyWasm()
  await copyCodicons()
  const contexts = await Promise.all(configs.map((config) => context(config)))
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()))
    return contexts
  }
  for (const c of contexts) {
    await c.rebuild()
    await c.dispose()
  }
  return []
}

// Only act as a CLI when invoked directly, so importing this file does not build.
if (process.argv[1]?.endsWith('esbuild.mjs')) {
  await buildAll({ dev: flag('dev'), watch: flag('watch') })
}
