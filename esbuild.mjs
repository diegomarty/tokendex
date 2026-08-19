import { build } from 'esbuild'

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: process.argv.includes('--production'),
  logLevel: 'info',
}

await Promise.all([
  // The extension host provides `vscode` at runtime; bundling it would fail.
  build({ ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
  build({ ...shared, entryPoints: ['src/worker/scanWorker.ts'], outfile: 'dist/scanWorker.js' }),
  // The webview runs in a browser context: IIFE, no Node builtins.
  build({
    ...shared,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
  }),
  build({ ...shared, entryPoints: ['src/webview/styles.css'], outfile: 'dist/webview.css', bundle: false }),
])
