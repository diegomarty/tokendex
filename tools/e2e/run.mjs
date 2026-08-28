/**
 * E2E smoke: launches a real VS Code, loads the packaged extension source, and proves the one
 * thing no unit test can — that activation succeeds end to end. `extension.ts` is the only
 * file allowed to import `vscode`, and until this existed it was also the only file with no
 * safety net at all.
 *
 * Needs a display: locally run `xvfb-run -a npm run test:e2e`; CI wires xvfb itself.
 */

import { runTests } from '@vscode/test-electron'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, 'tools/e2e/suite.cjs'),
    // The scan must not touch the developer's real save; same guard the launch configs use.
    extensionTestsEnv: { TOKENDEX_STATE_DIR: resolve(root, '.dev-state/e2e') },
    launchArgs: ['--disable-extensions', '--disable-gpu'],
  })
} catch (error) {
  console.error('E2E failed:', error)
  process.exit(1)
}
