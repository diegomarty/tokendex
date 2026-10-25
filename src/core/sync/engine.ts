/**
 * One sync round: pull every other device's save, merge each into ours, publish ours.
 *
 * The merge is `mergeSaves`, unchanged; this module only decides **what to read, what to fold
 * and when to write**, and the two rules that make a round converge rather than echo:
 *
 *  - **Absorbing is not a change of ours.** `CompanionStore.absorbRemote` commits the merge
 *    without bumping our revision (the merge already carries both vectors, per-key max). A bump
 *    would hand the other device a history it has not seen, it would fork against us, bump in
 *    turn, and the two would fork for ever.
 *  - **Push only what is new.** The payload leaves this machine's ledger out (`payload.ts`), and
 *    it is pushed only when its digest differs from the copy the gist holds — read this round, or
 *    on a 304 the one last pushed.
 *
 * Peers are folded in device-id order, so a round with three devices is deterministic.
 *
 * Core: no `vscode`, no timers. The worker schedules rounds and owns the backoff.
 */

import { promises as fs } from 'node:fs'
import { atomicWriteFile } from '../coordination/atomicWrite.js'
import { type DeviceIdentity } from '../companion/device.js'
import { type MergeOptions, type MergeResult, mergeSaves } from '../companion/merge.js'
import { type CompanionState } from '../companion/model.js'
import { type SaveSummary, SaveTransferFailure, summarize } from '../companion/saveTransfer.js'
import { decodeSyncPayload, deviceOfSyncFile, encodeSyncPayload, syncFileName } from './payload.js'
import { type RemoteFile, SyncError, type SyncTransport } from './transport.js'

/** A merge as the save committed it, and whether the companion on stage changed. */
export type SyncMerge = MergeResult & { companionReplaced: boolean }

/** What the engine needs from the save. `CompanionStore` is the real one. */
export interface SyncTarget {
  load(): Promise<void>
  snapshot(): Readonly<CompanionState>
  /** `undefined`: the save's lock was busy and nothing was written. */
  absorbRemote(remote: CompanionState, options?: MergeOptions): Promise<SyncMerge | undefined>
}

/** What a round remembers between rounds, in `ourData()/sync-state.json`. Never travels. */
export interface SyncMemory {
  etag?: string
  pushedDigest?: string
}

export interface SyncMemoryStore {
  read(): Promise<SyncMemory>
  write(memory: SyncMemory): Promise<void>
}

/** The memory as a small JSON file. Losing it costs one full read and, at worst, one push. */
export function fileMemory(path: string): SyncMemoryStore {
  return {
    async read() {
      try {
        const raw: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
        if (typeof raw !== 'object' || raw === null) return {}
        const { etag, pushedDigest } = raw as Record<string, unknown>
        return {
          ...(typeof etag === 'string' ? { etag } : {}),
          ...(typeof pushedDigest === 'string' ? { pushedDigest } : {}),
        }
      } catch {
        return {}
      }
    },
    async write(memory) {
      try {
        await atomicWriteFile(path, JSON.stringify(memory), 'utf8')
      } catch {
        // Best effort: the next round re-reads and compares against the gist instead.
      }
    },
  }
}

export interface SyncPeer {
  deviceID: string
  label: string
  appVersion: string
  summary: SaveSummary
}

export type SkipReason = 'newerSchema' | 'unreadable'

export interface SyncReport {
  /** Whether the gist had moved, so peers were read and folded. */
  pulled: boolean
  pushed: boolean
  merges: { peer: SyncPeer; result: SyncMerge }[]
  /** Every device seen in the gist this round, ours excluded. Empty when nothing was pulled. */
  peers: SyncPeer[]
  skipped: { deviceID: string; reason: SkipReason }[]
  /** The save's lock was busy for at least one merge; the round is retried in full next time. */
  busy: boolean
}

export interface SyncPreview {
  local: SaveSummary
  /** This machine has a companion or a Pokédex of its own — something a fork could cost. */
  hasOwnGame: boolean
  peers: SyncPeer[]
  /**
   * Whether syncing now would have to pick one history over another while this machine has a game
   * of its own — the case that deserves a question (`docs/sync.md` §7.1).
   */
  wouldFork: boolean
  /** The peer the question is about: of those that would fork, the one with the most progress. */
  forkPeer?: SyncPeer
}

export interface RoundOptions {
  /** Read the gist in full rather than trusting the etag. */
  force?: boolean
  /**
   * The player's answer to the first-sync question about one device (`forkPeer`), folded first.
   * `local` holds for every peer of the round: keeping this computer's companion means keeping it.
   * `remote` is about that computer alone; every other peer is merged by the rule.
   */
  onFork?: 'local' | 'remote'
  forkPeer?: string
  /**
   * False once sync was turned off (or reconfigured) while this round was in flight. Asked before
   * the read, before anything is folded and before the push: past it, the round stops where it is.
   */
  stillWanted?: () => boolean
}

export interface SyncEngineOptions {
  transport: SyncTransport
  target: SyncTarget
  device: DeviceIdentity
  appVersion: string
  memory: SyncMemoryStore
}

interface DecodedPeer {
  peer: SyncPeer
  state: CompanionState
}

interface Decoded {
  peers: DecodedPeer[]
  skipped: SyncReport['skipped']
  /** This device's own file in the gist, if it is there and readable. */
  own: { state: CompanionState; digest: string } | undefined
}

export class SyncEngine {
  constructor(private readonly options: SyncEngineOptions) {}

  async runOnce(round: RoundOptions = {}): Promise<SyncReport> {
    const { transport, target, device, memory } = this.options
    await target.load()
    const remembered = await memory.read()
    const report: SyncReport = {
      pulled: false,
      pushed: false,
      merges: [],
      peers: [],
      skipped: [],
      busy: false,
    }
    const wanted = (): boolean => round.stillWanted?.() !== false
    if (!wanted()) return report
    const read = await transport.read(round.force === true ? undefined : remembered.etag)
    if (!wanted()) return report

    const next: SyncMemory = { ...remembered }
    let heldDigest: string | undefined
    // Our own file listed but not handed over: what the gist holds of ours is unknown, and pushing
    // would overwrite a copy that was never merged — the one that restores a save gone backwards.
    const ownUnread = read.kind === 'files' && (read.unread ?? []).includes(syncFileName(device.id))

    if (read.kind === 'files') {
      report.pulled = true
      const { peers, skipped, own } = this.decode(read.files)
      report.peers = peers.map((p) => p.peer)
      report.skipped = skipped
      heldDigest = own?.digest
      // Our own file first, merged like any peer's. It is the copy of this game the gist holds,
      // and a local save that went backwards — corrupt and reset, restored from an old backup —
      // must be brought forward by it, never pushed over it (code review, 2026-10-22). When the
      // local save is ahead, as it normally is, this merge keeps it and changes nothing.
      if (own !== undefined && (await target.absorbRemote(own.state)) === undefined) report.busy = true
      // The peer the answer named goes first, so it meets the save the player was asked about; a
      // peer folded before it could already have settled the fork by the rule. "Keep this
      // computer's" holds for every peer of the round — a later fork won by the rule would replace
      // the very companion the player chose to keep. "Keep theirs" was about that computer alone.
      const ordered = [
        ...peers.filter(({ peer }) => peer.deviceID === round.forkPeer),
        ...peers.filter(({ peer }) => peer.deviceID !== round.forkPeer),
      ]
      for (const { peer, state } of ordered) {
        const chosen =
          round.onFork !== undefined && (peer.deviceID === round.forkPeer || round.onFork === 'local')
        const result = await target.absorbRemote(state, chosen ? { onFork: round.onFork! } : {})
        if (result === undefined) {
          report.busy = true
          continue
        }
        report.merges.push({ peer, result })
      }
      // A file the transport listed and could not hand over is a peer not folded in: said, and
      // read again next round rather than hidden behind an etag that says nothing moved.
      for (const name of read.unread ?? []) {
        const deviceID = deviceOfSyncFile(name)
        if (deviceID !== undefined && deviceID !== device.id) {
          report.skipped.push({ deviceID, reason: 'unreadable' })
        }
      }
      // An etag is only worth keeping once everything it stands for has been folded in.
      if (report.busy || (read.unread?.length ?? 0) > 0) delete next.etag
      else if (read.etag !== undefined) next.etag = read.etag
      else delete next.etag
    }

    const payload = encodeSyncPayload(target.snapshot(), {
      appVersion: this.options.appVersion,
      label: device.label,
    })
    // What the gist holds of ours: read this round, or — on a 304 — what we last pushed. A copy
    // read this round is believed over the memory: the gist may hold an older file of ours (a move
    // to a duplicate gist, a restored memory file) that the memory says was already replaced.
    const gistHolds = read.kind === 'files' ? heldDigest : next.pushedDigest
    if (payload.digest === gistHolds) {
      next.pushedDigest = payload.digest
    } else if (!ownUnread && wanted()) {
      await transport.write(syncFileName(device.id), payload.text)
      report.pushed = true
      next.pushedDigest = payload.digest
      // Our own write moved the gist, so the etag held no longer matches and the next round reads
      // in full once. That read is not wasted: only the server knows whether a peer wrote too.
    }
    await memory.write(next)
    return report
  }

  /** Reads the gist without changing anything: who is there, and whether syncing would fork. */
  async peek(): Promise<SyncPreview> {
    const { transport, target } = this.options
    await target.load()
    const read = await transport.read()
    const peers = read.kind === 'files' ? this.decode(read.files).peers : []
    const local = target.snapshot()
    const hasOwnGame = local.active !== undefined || local.dex.length > 0
    const forkPeer = peers
      .filter(({ state }) => mergeSaves(local as CompanionState, state).outcome === 'forked')
      .map((p) => p.peer)
      .sort((a, b) => b.summary.lifetimeTokens - a.summary.lifetimeTokens)[0]
    return {
      local: summarize(local),
      hasOwnGame,
      peers: peers.map((p) => p.peer),
      wouldFork: hasOwnGame && forkPeer !== undefined,
      ...(forkPeer === undefined ? {} : { forkPeer }),
    }
  }

  /** Every other device's save in id order, and our own file apart. */
  private decode(files: RemoteFile[]): Decoded {
    const peers: DecodedPeer[] = []
    const skipped: SyncReport['skipped'] = []
    let own: Decoded['own']
    const devices = files
      .map((file) => ({ file, deviceID: deviceOfSyncFile(file.name) }))
      .filter((f): f is { file: RemoteFile; deviceID: string } => f.deviceID !== undefined)
      .sort((a, b) => (a.deviceID < b.deviceID ? -1 : a.deviceID > b.deviceID ? 1 : 0))
    for (const { file, deviceID } of devices) {
      try {
        const decoded = decodeSyncPayload(file.text)
        if (deviceID === this.options.device.id) {
          own = { state: decoded.state, digest: decoded.digest }
          continue
        }
        peers.push({
          peer: {
            deviceID,
            label: decoded.label,
            appVersion: decoded.appVersion,
            summary: summarize(decoded.state),
          },
          state: decoded.state,
        })
      } catch (error) {
        if (deviceID === this.options.device.id) continue
        const newer = error instanceof SaveTransferFailure && error.detail.kind === 'newerSchema'
        skipped.push({ deviceID, reason: newer ? 'newerSchema' : 'unreadable' })
      }
    }
    return { peers, skipped, own }
  }
}

const RETRY_BASE_MS = 60_000
const RETRY_CEILING_MS = 60 * 60_000

/**
 * How long to wait after `failures` consecutive failed rounds: doubling from a minute, capped at
 * an hour. A server that said how long (`Retry-After`, a rate-limit reset) is believed when it
 * asks for *more* — never less than the backoff, because a reset computed against a clock that
 * runs fast comes out as zero, and zero would hammer GitHub in a loop.
 */
export function retryDelay(failures: number, error?: unknown): number {
  const exponent = Math.max(0, failures - 1)
  const backoff = RETRY_BASE_MS * 2 ** Math.min(exponent, 16)
  const asked = error instanceof SyncError && error.retryAfterMs !== undefined ? error.retryAfterMs : 0
  return Math.min(Math.max(backoff, asked), RETRY_CEILING_MS)
}
