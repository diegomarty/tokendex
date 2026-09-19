import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PUBLISHED_SCAN_FILE,
  type ScanObservation,
  ScanLease,
  observeThroughLease,
  publishScan,
  readPublishedScan,
} from '../src/core/coordination/scanLease.js'
import type { ProviderReport } from '../src/core/snapshot.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ptb-lease-'))
}

/** A clock both windows share, so "the holder went quiet for 90 s" costs no wall-clock time. */
function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

function provider(id: string, tokens: number): ProviderReport {
  return {
    providerID: id,
    displayName: id,
    entries: 1,
    today: {
      date: '2026-09-19',
      inputTokens: 1,
      outputTokens: tokens - 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: tokens,
      totalCost: 0.5,
    },
  }
}

/**
 * A window, as the lease sees one: its own `ScanLease` over the shared directory and a corpus
 * read that counts how often it actually ran. Two of these on one directory are the whole
 * cross-window matrix — no editor, no worker.
 */
function window(
  directory: string,
  clock: ReturnType<typeof fakeClock>,
  tokens: number,
  staleAfterMs = 90_000,
) {
  const lease = new ScanLease({ directory, now: clock.now, staleAfterMs })
  let scans = 0
  const scanCorpus = async (): Promise<ScanObservation> => {
    scans += 1
    return { scannedAt: clock.now(), providers: [provider('claude_code', tokens)], errors: [] }
  }
  return {
    lease,
    get scans(): number {
      return scans
    },
    observe: () => observeThroughLease({ directory, lease, scanCorpus }),
  }
}

describe('the scan lease elects one window', () => {
  it('lets the holder scan and publish', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    const a = window(dir, clock, 100)

    const result = await a.observe()
    expect(result).toMatchObject({ owned: true, scanned: true })
    expect(a.scans).toBe(1)
    expect((await readPublishedScan(dir))?.providers[0]?.today?.totalTokens).toBe(100)
  })

  // The headline property of stage 2. Four windows used to mean four cold parses of the same
  // 1.4 GB, racing to publish a snapshot only one of which survived (§3.6).
  it('does not scan in a second window while a live lease is held', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    const holder = window(dir, clock, 100)
    const follower = window(dir, clock, 999) // its own scan would report a different number

    await holder.observe()
    const result = await follower.observe()

    expect(follower.scans).toBe(0) // the whole point: no disk pass in the second window
    expect(result).toMatchObject({ owned: false, scanned: false })
    expect(result.observation.providers[0]?.today?.totalTokens).toBe(100) // the holder's numbers
  })

  /**
   * The follower dates its snapshot from the holder's scan, not from its own clock.
   *
   * Honesty in the tooltip is the small half. The large half is the ledger: `compose` folds
   * the observation against `todayKey(scannedAt)`, and a follower that used its own `now`
   * across midnight would fold yesterday's cumulative totals against today's date, which is
   * the day-rollover branch — the whole of yesterday credited a second time.
   */
  it('carries the holder scan time, not the follower clock', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    // A ceiling neither window can cross here, so the gap below is a quiet holder rather
    // than a dead one: what is being tested is the follower's arithmetic, not takeover.
    const day = 24 * 3_600_000
    const holder = window(dir, clock, 100, day)
    await holder.observe()
    const publishedAt = clock.now()

    clock.advance(11 * 3_600_000) // the follower wakes on the far side of midnight
    const follower = window(dir, clock, 999, day)
    const result = await follower.observe()

    expect(result.observation.scannedAt).toBe(publishedAt)
  })

  it('hands the lease straight over when the holder releases it', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    const holder = window(dir, clock, 100)
    const next = window(dir, clock, 200)

    await holder.observe()
    expect((await next.observe()).owned).toBe(false)

    await holder.lease.release()
    expect((await next.observe()).owned).toBe(true) // no waiting out the staleness ceiling
    expect(next.scans).toBe(1)
  })
})

describe('the degraded mode is the current product', () => {
  // A follower that showed nothing because a publication was missing would be worse than one
  // that duplicates work. Every failure to read one ends here, on the full disk pass.
  it('scans when the lease is held but nothing has been published yet', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    const holder = window(dir, clock, 100)
    const follower = window(dir, clock, 999)

    await holder.lease.ensure() // holds the lease, still inside its first cold parse
    const result = await follower.observe()

    expect(result).toMatchObject({ owned: false, scanned: true })
    expect(follower.scans).toBe(1)
    expect(result.observation.providers[0]?.today?.totalTokens).toBe(999) // its own numbers
  })

  it('scans when the publication cannot be read', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    const holder = window(dir, clock, 100)
    const follower = window(dir, clock, 999)
    await holder.observe()

    for (const bytes of ['not json at all', JSON.stringify({ schema: 99, providers: [] })]) {
      writeFileSync(join(dir, PUBLISHED_SCAN_FILE), bytes, 'utf8')
      expect(await readPublishedScan(dir)).toBeUndefined()
    }
    const result = await follower.observe()

    expect(result.scanned).toBe(true)
    expect(result.observation.providers[0]?.today?.totalTokens).toBe(999)
  })

  it('reads a publication whose errors field is missing rather than refusing it', async () => {
    const dir = tempDir()
    await publishScan(dir, { scannedAt: 5, providers: [provider('codex', 7)], errors: [] })
    const raw = JSON.parse(readFileSync(join(dir, PUBLISHED_SCAN_FILE), 'utf8')) as Record<
      string,
      unknown
    >
    delete raw['errors']
    writeFileSync(join(dir, PUBLISHED_SCAN_FILE), JSON.stringify(raw), 'utf8')

    expect(await readPublishedScan(dir)).toMatchObject({ scannedAt: 5, errors: [] })
  })
})

describe('surviving a holder that stops', () => {
  /**
   * [trigger branch] Signal 2 alone — the heartbeat ceiling, with the pid still alive.
   *
   * Both windows run in this process, so `process.kill(pid, 0)` says the holder is very much
   * alive; only the aged heartbeat can justify the break. That is the wedged-holder and the
   * foreign-host case, and it is the one a lease actually needs: `fileLock.ts` covers the
   * dead-pid signal on its own.
   */
  it('takes over a lease whose heartbeat has aged past the ceiling', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    const gone = window(dir, clock, 100)
    const survivor = window(dir, clock, 200)

    await gone.observe()
    expect((await survivor.observe()).owned).toBe(false) // still live: not breakable

    clock.advance(90_001) // four missed touches
    const result = await survivor.observe()

    expect(result).toMatchObject({ owned: true, scanned: true })
    expect((await readPublishedScan(dir))?.providers[0]?.today?.totalTokens).toBe(200)
  })

  /**
   * [trigger branch] The residual window `fileLock.ts` documents as unclosable: between
   * reading a record and renaming it aside, the holder may still be there. A long-lived lease
   * must therefore believe `heartbeat()`, not its own memory of having acquired one — a lease
   * that ignored it would go on publishing and writing the usage cache as a second "only"
   * writer.
   */
  it('stops acting as owner once its heartbeat reports the hold was broken', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    const broken = window(dir, clock, 100)
    const thief = window(dir, clock, 200)

    await broken.observe()
    expect(broken.lease.owned).toBe(true)

    clock.advance(90_001)
    await thief.observe() // breaks the stale-looking lease and takes it

    expect(await broken.lease.touch()).toBe(false)
    expect(broken.lease.owned).toBe(false)
    // And it behaves as a follower from the next refresh, rather than publishing over the
    // window that now owns the scan.
    const result = await broken.observe()
    expect(result).toMatchObject({ owned: false, scanned: false })
    expect(result.observation.providers[0]?.today?.totalTokens).toBe(200)
  })

  it('reports no ownership from touch when the lease was never held', async () => {
    const dir = tempDir()
    const clock = fakeClock()
    expect(await window(dir, clock, 1).lease.touch()).toBe(false)
  })
})
