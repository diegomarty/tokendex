/**
 * Throwaway harness: runs the ported parsers over the real logs on this machine, twice, so
 * the cold and warm cache paths are both measured. Fixtures cover what was foreseen; 1.4 GB
 * of real logs cover what was not.
 */
import { LocalUsageCache } from '../src/core/usage/cache.js'
import {
  daily,
  enrichmentScanStart,
  entryTotal,
  monthKey,
  period,
  todayKey,
} from '../src/core/usage/entry.js'
import { claudeProjectsDir, codexSessionsDir } from '../src/core/usage/roots.js'
import { compact, cost, grouped } from '../src/core/tokenFormatter.js'

const now = Date.now()
const since = enrichmentScanStart(now)
const today = todayKey(now)
const month = monthKey(now)
const cacheFile = process.argv[2] ?? '/tmp/ptb-real-cache.json.gz'

async function pass(label: string) {
  const cache = new LocalUsageCache({
    claudeRoots: [claudeProjectsDir()],
    codexRoot: codexSessionsDir(),
    filePath: cacheFile,
  })
  const t0 = performance.now()
  const claude = await cache.claudeEntries(since)
  const tClaude = performance.now()
  const codex = await cache.codexEntries(since)
  const tCodex = performance.now()
  await cache.save()

  console.log(`\n  ${label}`)
  console.log(
    `    claude   ${String(Math.round(tClaude - t0)).padStart(6)} ms   ${grouped(claude.length, 'en-US').padStart(7)} entries`,
  )
  console.log(
    `    codex    ${String(Math.round(tCodex - tClaude)).padStart(6)} ms   ${grouped(codex.length, 'en-US').padStart(7)} entries`,
  )
  console.log(`    TOTAL    ${String(Math.round(tCodex - t0)).padStart(6)} ms`)
  return { claude, codex }
}

const first = await pass('1st pass (cold cache)')
const second = await pass('2nd pass (new instance: snapshot load + scan)')

// The extension keeps one long-lived cache, so the snapshot load happens once at startup.
// This is the number that actually repeats every 120 s.
{
  const cache = new LocalUsageCache({
    claudeRoots: [claudeProjectsDir()],
    codexRoot: codexSessionsDir(),
    filePath: cacheFile,
  })
  await cache.claudeEntries(since)
  await cache.codexEntries(since)
  console.log('\n  Steady state (same instance, as in the extension)')
  for (let i = 1; i <= 3; i++) {
    const t0 = performance.now()
    await cache.claudeEntries(since)
    await cache.codexEntries(since)
    console.log(`    refresh ${i}   ${String(Math.round(performance.now() - t0)).padStart(5)} ms`)
  }
}

const all = [...second.claude, ...second.codex]
const d = daily(all, today)
const m = period(all, month, `${month}-01`, `${month}-31`)
console.log(`\n  Combined usage`)
console.log(`    today      ${d ? compact(d.totalTokens) : '—'} tokens   ${d ? cost(d.totalCost) : ''}`)
console.log(`    this month ${compact(m.totalTokens)} tokens   ${cost(m.totalCost)}`)
console.log(
  `\n  parity between passes: ${first.claude.length === second.claude.length && first.codex.length === second.codex.length ? 'OK (same counts)' : 'THEY DIFFER!'}\n`,
)
