import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompanionStore } from '../src/core/companion/store.js'
import {
  type CompanionState,
  type DexEntry,
  freshCompanionState,
  freshSpeciesProgress,
  makeEvoLine,
  type EvoNode,
} from '../src/core/companion/model.js'
import { encodeCompanionState } from '../src/core/companion/persistence.js'
import {
  BACKUP_FILE_PREFIX,
  SAVE_SCHEMA_VERSION,
  SYNC_BACKUP_FILE_PREFIX,
} from '../src/core/companion/saveTransfer.js'
import type { BaseSpecies, PokeProviding } from '../src/core/pokeapi.js'
import { SyncEngine, fileMemory, retryDelay } from '../src/core/sync/engine.js'
import {
  LOCAL_ONLY_FIELDS,
  decodeSyncPayload,
  encodeSyncPayload,
  syncFileName,
} from '../src/core/sync/payload.js'
import { mergeSaves } from '../src/core/companion/merge.js'
import { type ReadResult, SyncError, type SyncTransport } from '../src/core/sync/transport.js'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)

const node = (id: number, children: EvoNode[] = []): EvoNode => ({ speciesID: id, children })

/** No network, deterministic lines. */
function stubProvider(): PokeProviding {
  return {
    line: async (baseID: number) =>
      makeEvoLine(baseID, node(baseID, [node(baseID + 1)]), 'common', {
        [baseID]: { en: `Base${baseID}` },
        [baseID + 1]: { en: `Evo${baseID}` },
      }),
    baseSpeciesIndex: async (): Promise<BaseSpecies[]> => [{ id: 1, captureRate: 255 }],
    baseSpecies: async (id: number) => ({ id, captureRate: 255 }),
    wildSpecies: async (id: number) => ({
      id,
      captureRate: 255,
      rarity: 'common' as const,
      names: { en: `Wild${id}` },
    }),
  }
}

function dex(id: string): DexEntry {
  return { id, baseID: 1, finalID: 3, chainOrder: [1, 2, 3], rarity: 'common', isShiny: false }
}

/** The shared gist, in memory: one file per device, an etag that moves on every write. */
class MemoryTransport implements SyncTransport {
  files = new Map<string, string>()
  version = 0
  writes = 0
  async read(etag?: string): Promise<ReadResult> {
    if (etag === String(this.version)) return { kind: 'notModified' }
    const files = [...this.files].map(([name, text]) => ({ name, text }))
    return { kind: 'files', files, etag: String(this.version) }
  }
  async write(name: string, text: string): Promise<void> {
    this.files.set(name, text)
    this.version += 1
    this.writes += 1
  }
}

const DAY = '2026-10-22'

/** One machine: its own state directory, its own device id, a store and an engine on one gist. */
function machine(device: string, transport: SyncTransport, over: Partial<CompanionState> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tokendex-sync-'))
  const filePath = join(directory, 'companion-state.json')
  const begun: CompanionState = {
    ...freshCompanionState('en'),
    species: { 600: { ...freshSpeciesProgress(), unlocked: true } },
    installBaselineSet: true,
    lastDate: DAY,
    claimedTodayTokensByProvider: {},
    ...over,
  }
  writeFileSync(filePath, encodeCompanionState(begun), 'utf8')
  const store = new CompanionStore({
    provider: stubProvider(),
    filePath,
    deviceID: device,
    now: () => Date.parse(`${DAY}T12:00:00Z`),
    dittoEnabled: false,
  })
  const engine = new SyncEngine({
    transport,
    target: store,
    device: { id: device, label: `device-${device.slice(0, 6)}` },
    appVersion: '1.0.0',
    memory: fileMemory(join(directory, 'sync-state.json')),
  })
  return { store, engine, directory }
}

function mon(baseID: number): NonNullable<CompanionState['active']> {
  return {
    baseID,
    pathIDs: [baseID],
    plannedPathIDs: [baseID, baseID + 1],
    stageIndex: 0,
    usedAtStage: 0,
    rarity: 'common',
    totalForms: 2,
    isShiny: false,
    dittoRevealed: false,
  } as NonNullable<CompanionState['active']>
}

const syncBackups = (directory: string) =>
  readdirSync(directory).filter((n) => n.startsWith(SYNC_BACKUP_FILE_PREFIX))

const dexIDs = (state: Readonly<CompanionState>) => state.dex.map((e) => e.id).sort()
/** What travels, so two machines can be compared without their ledgers. */
const travelling = (state: Readonly<CompanionState>) =>
  encodeSyncPayload(state, { appVersion: 'x', label: 'x' }).digest

describe('SyncEngine', () => {
  // [trigger branch] The property the whole design rests on: two machines meet and agree, and
  // then stop talking. A merge that bumped the revision would hand the other side a "new"
  // history every round, and they would fork against each other for ever.
  it('converges two machines and then goes quiet', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, {
      dex: [dex('a1')],
      revision: { [A]: 3 },
      usedByDevice: { [A]: 100 },
      usedSinceInstall: 100,
    })
    const b = machine(B, gist, {
      dex: [dex('b1')],
      revision: { [B]: 2 },
      usedByDevice: { [B]: 50 },
      usedSinceInstall: 50,
    })

    for (let round = 0; round < 2; round++) {
      await a.engine.runOnce()
      await b.engine.runOnce()
    }
    expect(dexIDs(a.store.snapshot())).toEqual(['a1', 'b1'])
    expect(travelling(a.store.snapshot())).toBe(travelling(b.store.snapshot()))

    const writes = gist.writes
    await a.engine.runOnce()
    await b.engine.runOnce()
    await a.engine.runOnce()
    expect(gist.writes).toBe(writes)
  })

  // Every token each machine saw is counted once on both, however many rounds pass.
  it("counts each machine's usage exactly once", async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, {
      revision: { [A]: 1 },
      usedByDevice: { [A]: 100 },
      usedSinceInstall: 100,
    })
    const b = machine(B, gist, {
      revision: { [B]: 1 },
      usedByDevice: { [B]: 50 },
      usedSinceInstall: 50,
      claimedTodayTokensByProvider: { codex: 0 },
    })
    for (let round = 0; round < 3; round++) {
      await a.engine.runOnce()
      await b.engine.runOnce()
    }
    // The loser of the first fork had its 100 or 50 credited to the winner: 150 on both.
    expect(a.store.snapshot().usedSinceInstall).toBe(150)
    expect(b.store.snapshot().usedSinceInstall).toBe(150)

    await b.store.update({ todayTokensByProvider: { codex: 30 }, todayDate: DAY, hasUsageData: true })
    await b.engine.runOnce()
    await a.engine.runOnce()
    expect(a.store.snapshot().usedSinceInstall).toBe(180)
    expect(b.store.snapshot().usedSinceInstall).toBe(180)
  })

  it('reads nothing new and writes nothing when the gist has not moved', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { revision: { [A]: 1 } })
    await a.engine.runOnce()
    // The round after our own push reads it back once: the etag moved, and only the server knows
    // whether a peer wrote too.
    await a.engine.runOnce()
    const report = await a.engine.runOnce()
    expect(report.pulled).toBe(false)
    expect(report.pushed).toBe(false)
    expect(gist.writes).toBe(1)
  })

  // A fresh state directory (a reinstall) has no memory of what it pushed. The file already in
  // the gist says it, so nothing is re-uploaded for nothing.
  it('does not re-push what the gist already holds', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { revision: { [A]: 1 } })
    await a.engine.runOnce()
    const again = new SyncEngine({
      transport: gist,
      target: a.store,
      device: { id: A, label: `device-${A.slice(0, 6)}` },
      appVersion: '1.0.0',
      memory: fileMemory(join(mkdtempSync(join(tmpdir(), 'tokendex-sync-')), 'sync-state.json')),
    })
    expect((await again.runOnce()).pushed).toBe(false)
    expect(gist.writes).toBe(1)
  })

  it('continues the history the player chose on the first sync', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { dex: [dex('a1')], eggUsage: 111, revision: { [A]: 9 } })
    const b = machine(B, gist, { dex: [dex('b1')], eggUsage: 222, revision: { [B]: 1 } })
    await a.engine.runOnce()

    const peek = await b.engine.peek()
    expect(peek.wouldFork).toBe(true)
    expect(peek.peers.map((p) => p.deviceID)).toEqual([A])

    const report = await b.engine.runOnce({ onFork: 'local', forkPeer: A })
    expect(report.merges[0]?.result.narrative).toBe('local')
    expect(b.store.snapshot().eggUsage).toBe(222)
    // …and the other machine adopts that choice instead of re-deciding it.
    await a.engine.runOnce()
    expect(a.store.snapshot().eggUsage).toBe(222)
    expect(dexIDs(a.store.snapshot())).toEqual(['a1', 'b1'])
  })

  // [trigger branch] The code review's simulation, kept: two machines open and both in use. Every
  // scan used to bump the revision, so 15 of 16 merges forked and the sync backups rotated the
  // import backups away. Accrual is not history now: after the first meeting, nothing forks.
  it('never forks two machines that are merely both in use', async () => {
    const gist = new MemoryTransport()
    const begin = (device: string) => ({
      revision: { [device]: 1 },
      usedByDevice: { [device]: 10 },
      usedSinceInstall: 10,
      claimedTodayTokensByProvider: { codex: 0 },
    })
    const a = machine(A, gist, begin(A))
    const b = machine(B, gist, begin(B))
    for (let i = 0; i < 3; i++)
      writeFileSync(join(a.directory, `${BACKUP_FILE_PREFIX}2026-01-0${i + 1}-000000.json`), '{}')
    // The day's first accrual grants the daily egg and deals the day's challenges: history, once a
    // day, on each machine. Done before the two meet, so the rounds below are pure accrual.
    await a.store.update({ todayTokensByProvider: { codex: 5 }, todayDate: DAY, hasUsageData: true })
    await b.store.update({ todayTokensByProvider: { codex: 5 }, todayDate: DAY, hasUsageData: true })
    await a.engine.runOnce()
    await b.engine.runOnce()
    await a.engine.runOnce()

    let aTokens = 5
    let bTokens = 5
    const outcomes: string[] = []
    for (let round = 0; round < 8; round++) {
      aTokens += 100 + round
      bTokens += 100 + (round % 3) * 20
      await a.store.update({
        todayTokensByProvider: { codex: aTokens },
        todayDate: DAY,
        hasUsageData: true,
      })
      await b.store.update({
        todayTokensByProvider: { codex: bTokens },
        todayDate: DAY,
        hasUsageData: true,
      })
      for (const m of [...(await a.engine.runOnce()).merges, ...(await b.engine.runOnce()).merges]) {
        outcomes.push(m.result.outcome)
      }
    }
    await a.engine.runOnce()
    expect(outcomes).not.toContain('forked')
    expect(a.store.snapshot().usedSinceInstall).toBe(20 + aTokens + bTokens)
    expect(b.store.snapshot().usedSinceInstall).toBe(20 + aTokens + bTokens)
    expect(readdirSync(a.directory).filter((n) => n.startsWith(BACKUP_FILE_PREFIX))).toHaveLength(3)
  })

  it('does not count a scan that only accrued as a revision', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { revision: { [A]: 4 }, claimedTodayTokensByProvider: { codex: 0 } })
    // The day's first accrual is history once (the daily egg, the day's challenges)…
    await a.store.update({ todayTokensByProvider: { codex: 10 }, todayDate: DAY, hasUsageData: true })
    const afterFirst = a.store.snapshot().revision[A]
    // …and every scan after it that only accrues is not.
    await a.store.update({ todayTokensByProvider: { codex: 50 }, todayDate: DAY, hasUsageData: true })
    await a.store.update({ todayTokensByProvider: { codex: 90 }, todayDate: DAY, hasUsageData: true })
    expect(a.store.snapshot().usedSinceInstall).toBe(90)
    expect(a.store.snapshot().revision[A]).toBe(afterFirst)
  })

  // [trigger branch] The player kept this machine's companion when turning sync on; the other
  // machine receives the result as an adoption — a save that contains its own — and its companion
  // is replaced. That machine is the one that lost something, so it is the one that backs up.
  it('backs up a machine whose companion is replaced by an adoption', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { active: mon(4), revision: { [A]: 1 } })
    const b = machine(B, gist, { active: mon(7), revision: { [B]: 9 } })
    await b.engine.runOnce()
    await a.engine.runOnce({ onFork: 'local', forkPeer: B })
    expect(a.store.snapshot().active?.baseID).toBe(4)
    expect(syncBackups(a.directory)).toHaveLength(0)

    const report = await b.engine.runOnce()
    expect(report.merges[0]?.result.outcome).toBe('adoptedRemote')
    expect(report.merges[0]?.result.companionReplaced).toBe(true)
    expect(b.store.snapshot().active?.baseID).toBe(4)
    expect(syncBackups(b.directory)).toHaveLength(1)
  })

  // An adoption that keeps the same companion lost nothing: the other machine only played on.
  it('does not back up an adoption that keeps the companion', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { active: mon(4), revision: { [A]: 1 } })
    await a.engine.runOnce()
    const b = machine(B, gist, { active: mon(4), revision: { [A]: 1 } })
    await b.engine.runOnce()
    expect(syncBackups(b.directory)).toHaveLength(0)
  })

  // [trigger branch] This device's own file in the gist was only fingerprinted. A save that went
  // backwards (corrupt and reset, restored from an old backup) overwrote the newer copy there —
  // the only other copy of the game. It is merged like any peer's now, so the newer one wins.
  it("restores this machine's newer save from the gist when the local one went backwards", async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { dex: [dex('kept')], revision: { [A]: 50 } })
    await a.engine.runOnce()
    const reset = machine(A, gist, { revision: { [A]: 1 } })
    await reset.engine.runOnce()
    expect(dexIDs(reset.store.snapshot())).toEqual(['kept'])
    expect(reset.store.snapshot().revision[A]).toBe(50)
  })

  // [trigger branch] With three devices, the player's answer named one of them. It used to be
  // applied to every peer in id order, so the last forking peer won instead.
  it("applies the player's choice to the device it named only", async () => {
    const gist = new MemoryTransport()
    // Two peers that never met each other: written straight into the gist.
    const peer = (active: number, revision: Record<string, number>) =>
      encodeSyncPayload(
        { ...freshCompanionState('en'), active: mon(active), revision },
        { appVersion: '1', label: 'p' },
      ).text
    await gist.write(syncFileName(B), peer(4, { [B]: 3 }))
    await gist.write(syncFileName(C), peer(9, { [C]: 2 }))
    const a = machine(A, gist, { active: mon(1), revision: { [A]: 1 } })
    await a.engine.runOnce({ onFork: 'remote', forkPeer: B })
    expect(a.store.snapshot().active?.baseID).toBe(4)
  })

  // What a fork discards is bounded; it is also recoverable. Only the losing side backs up — the
  // winner lost nothing, and a backup per round would rotate the import backups away.
  it("backs up this machine's save before a fork discards its history", async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { eggUsage: 111, revision: { [A]: 1 } })
    const b = machine(B, gist, { eggUsage: 222, revision: { [B]: 5 } })
    await b.engine.runOnce()
    const report = await a.engine.runOnce()
    expect(report.merges[0]?.result).toMatchObject({ outcome: 'forked', narrative: 'remote' })
    expect(syncBackups(a.directory)).toHaveLength(1)
    await b.engine.runOnce()
    expect(syncBackups(b.directory)).toHaveLength(0)
  })

  // A save from a newer build must not be half-understood and merged: it is skipped, reported,
  // and this machine's save is left exactly as it was.
  it('skips a peer written by a newer build', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { dex: [dex('a1')], revision: { [A]: 1 } })
    const future = JSON.stringify({ format: 'tokendex.save', schema: SAVE_SCHEMA_VERSION + 1, state: {} })
    await gist.write(syncFileName(C), future)
    await a.store.load()
    const before = travelling(a.store.snapshot())
    const report = await a.engine.runOnce()
    expect(report.skipped).toEqual([{ deviceID: C, reason: 'newerSchema' }])
    expect(travelling(a.store.snapshot())).toBe(before)
  })

  it('ignores files in the gist that are not device saves', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { revision: { [A]: 1 } })
    await gist.write('README.md', '# hello')
    const report = await a.engine.runOnce()
    expect(report.skipped).toEqual([])
    expect(report.peers).toEqual([])
  })

  // [trigger branch] Three devices: two peers that already share a game, the lower id folded first.
  // It used to settle the fork by the rule, so the named peer, folded next, was only an adoption
  // and "keep this computer's companion" was never applied.
  it("keeps this computer's companion when a peer folded before the named one would fork", async () => {
    const gist = new MemoryTransport()
    const peer = (revision: Record<string, number>) =>
      encodeSyncPayload(
        { ...freshCompanionState('en'), active: mon(4), dex: [dex('p')], revision },
        { appVersion: '1', label: 'p' },
      ).text
    await gist.write(syncFileName(B), peer({ [B]: 5, [C]: 5 }))
    await gist.write(syncFileName(C), peer({ [B]: 5, [C]: 6 }))
    const a = machine(A, gist, { active: mon(1), dex: [dex('a')], revision: { [A]: 1 } })
    await a.engine.runOnce({ onFork: 'local', forkPeer: C })
    expect(a.store.snapshot().active?.baseID).toBe(1)
    expect(dexIDs(a.store.snapshot())).toEqual(['a', 'p'])
  })

  // Two peers each ahead of the other: the named one folded first, the other still forks against
  // the result. The player's "keep this computer's" holds for it too, not the rule.
  it("keeps this computer's companion against every peer of the first round", async () => {
    const gist = new MemoryTransport()
    const peer = (revision: Record<string, number>) =>
      encodeSyncPayload(
        { ...freshCompanionState('en'), active: mon(4), revision },
        { appVersion: '1', label: 'p' },
      ).text
    await gist.write(syncFileName(B), peer({ [B]: 40, [C]: 5 }))
    await gist.write(syncFileName(C), peer({ [B]: 5, [C]: 6 }))
    const a = machine(A, gist, { active: mon(1), revision: { [A]: 1 } })
    await a.engine.runOnce({ onFork: 'local', forkPeer: C })
    expect(a.store.snapshot().active?.baseID).toBe(1)
  })

  // The question names a peer that would fork, not merely the one with the most progress.
  it('names a peer that would fork in the first-sync question', async () => {
    const gist = new MemoryTransport()
    const payload = (state: Partial<CompanionState>) =>
      encodeSyncPayload({ ...freshCompanionState('en'), ...state }, { appVersion: '1', label: 'p' }).text
    // B has already seen everything A has: no fork, however far it went.
    await gist.write(syncFileName(B), payload({ usedSinceInstall: 9_000, revision: { [A]: 2 } }))
    await gist.write(syncFileName(C), payload({ usedSinceInstall: 10, revision: { [C]: 1 } }))
    const a = machine(A, gist, { active: mon(1), revision: { [A]: 2 } })
    const peek = await a.engine.peek()
    expect(peek.wouldFork).toBe(true)
    expect(peek.forkPeer?.deviceID).toBe(C)
  })

  // [trigger branch] The other machine hatched the shared egg: an adoption that replaces the
  // companion, and lost nothing. It used to back up, toast "continued from…" and rotate away the
  // backup of a real lost fork.
  it('does not back up an adoption of a hatch on the other machine', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { revision: { [A]: 1 } })
    await a.engine.runOnce()
    await gist.write(
      syncFileName(B),
      encodeSyncPayload(
        { ...freshCompanionState('en'), active: mon(4), revision: { [A]: 1, [B]: 1 } },
        { appVersion: '1', label: 'p' },
      ).text,
    )
    const report = await a.engine.runOnce()
    expect(report.merges[0]?.result).toMatchObject({
      outcome: 'adoptedRemote',
      companionReplaced: true,
      localLost: false,
    })
    expect(a.store.snapshot().active?.baseID).toBe(4)
    expect(syncBackups(a.directory)).toHaveLength(0)
  })

  // A machine that adopted a fork's result once has lost nothing more when its peer plays on.
  it('backs up a lost fork once, not on every adoption after it', async () => {
    const gist = new MemoryTransport()
    const a = machine(A, gist, { active: mon(4), revision: { [A]: 1 } })
    const b = machine(B, gist, { active: mon(7), revision: { [B]: 9 } })
    await b.engine.runOnce()
    await a.engine.runOnce({ onFork: 'local', forkPeer: B })
    await b.engine.runOnce()
    expect(syncBackups(b.directory)).toHaveLength(1)
    // A hatches something new: history, so a revision of A's.
    await a.store.update({ todayTokensByProvider: { codex: 10 }, todayDate: DAY, hasUsageData: true })
    await a.engine.runOnce()
    const report = await b.engine.runOnce()
    expect(report.merges[0]?.result.outcome).toBe('adoptedRemote')
    expect(report.merges[0]?.result.localLost).toBe(false)
    expect(syncBackups(b.directory)).toHaveLength(1)
  })
})

describe('sync payload', () => {
  // [trigger branch] Every scan moves this machine's ledger. If the ledger travelled, every scan
  // would change the payload and push, two machines would upload all day for nothing.
  it("does not change when only this machine's ledger moves", () => {
    const base = { ...freshCompanionState('en'), revision: { [A]: 1 } }
    const meta = { appVersion: '1.0.0', label: 'laptop' }
    const moved: CompanionState = {
      ...base,
      claimedTodayTokensByProvider: { codex: 999 },
      lastDate: '2030-01-01',
      installBaselineSet: true,
      language: 'ja',
    }
    expect(encodeSyncPayload(moved, meta).digest).toBe(encodeSyncPayload(base, meta).digest)
    expect(encodeSyncPayload({ ...base, usedSinceInstall: 1 }, meta).digest).not.toBe(
      encodeSyncPayload(base, meta).digest,
    )
  })

  // The payload drops these because the merge never reads them from a peer. If a field were added
  // to one list and not the other, a peer would either overwrite this machine's ledger with a
  // default (dropped but not kept local) or push on every scan (kept local but still travelling).
  it('drops exactly the fields the merge keeps local', () => {
    const local: CompanionState = {
      ...freshCompanionState('en'),
      revision: { [A]: 1 },
      installBaselineSet: true,
      lastDate: '2026-10-20',
      claimedTodayTokensByProvider: { codex: 5 },
      language: 'es',
      keepCompletedCompanion: true,
      lastEncounterToastAt: 123,
      queueFullArmed: false,
    }
    const peer = decodeSyncPayload(
      encodeSyncPayload(
        { ...freshCompanionState('ja'), revision: { [A]: 1, [B]: 4 } },
        { appVersion: '1', label: 'b' },
      ).text,
    ).state
    const merged = mergeSaves(local, peer)
    expect(merged.outcome).toBe('adoptedRemote')
    for (const key of LOCAL_ONLY_FIELDS) expect(merged.state[key], key).toEqual(local[key])
  })

  it('round-trips, compressed once it is large', () => {
    const big: CompanionState = {
      ...freshCompanionState('en'),
      dex: Array.from({ length: 3000 }, (_, i) => dex(`entry-${i}`)),
      trainerID: 'red',
    }
    const { text } = encodeSyncPayload(big, { appVersion: '1.0.0', label: 'laptop' })
    expect(text.startsWith('gz:')).toBe(true)
    const decoded = decodeSyncPayload(text)
    expect(decoded.state.dex).toHaveLength(3000)
    expect(decoded.state.trainerID).toBe('red')
    expect(decoded.label).toBe('laptop')
  })
})

describe('retryDelay', () => {
  it('backs off exponentially, capped, and honours Retry-After', () => {
    expect(retryDelay(1)).toBe(60_000)
    expect(retryDelay(2)).toBe(120_000)
    expect(retryDelay(20)).toBe(60 * 60_000)
    expect(retryDelay(1, new SyncError('rateLimited', 'slow down', 900_000))).toBe(900_000)
    // [trigger branch] A reset computed against a clock that runs fast comes out as zero. Believed,
    // it retried at once, in a loop, until the server's clock caught up.
    expect(retryDelay(1, new SyncError('rateLimited', 'slow down', 0))).toBe(60_000)
    expect(retryDelay(3, new SyncError('rateLimited', 'slow down', 1_000))).toBe(240_000)
  })
})
