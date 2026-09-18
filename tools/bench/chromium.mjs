/**
 * Finds a Chromium for the capture tools.
 *
 * Its own module because `record.mjs` records the moment it is imported (top-level await), so
 * importing it just to borrow this function starts a recording — which is exactly what it did.
 *
 * `playwright-core` ships no browser registry, hence looking by hand: a Playwright-managed
 * Chromium first, because that is the reproducible one, then whatever Chrome the machine
 * already has. The managed lookup used to assume Linux layout names only, so on macOS — where
 * that cache does not exist unless you ask for it — the README captures could not be made at
 * all on the machine that ships them.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Per-platform unpack layouts of a managed Chromium; newer Linux builds use chrome-linux64. */
const MANAGED_BINARIES = [
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win/chrome.exe',
]

const SYSTEM_BINARIES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export function chromiumPath() {
  const managed = join(homedir(), '.cache', 'ms-playwright')
  let versions = []
  try {
    versions = readdirSync(managed)
      .filter((entry) => /^chromium-\d+$/.test(entry))
      .sort()
  } catch {
    // No managed cache. The system browsers below are the fallback.
  }
  const newest = versions[versions.length - 1]
  if (newest !== undefined) {
    for (const relative of MANAGED_BINARIES) {
      const candidate = join(managed, newest, relative)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const candidate of SYSTEM_BINARIES) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no Chromium found — run `npx playwright install chromium`, or install Chrome')
}
