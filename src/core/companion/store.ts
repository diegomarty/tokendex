/**
 * The stateful companion orchestrator: the piece that owns persistence and sequencing while
 * every rule it applies lives in the pure modules beside it (`ledger`, `growth`, `shop`,
 * `display`).
 *
 * That split is deliberate. Interleaving the rules with saving, notifications and network
 * calls is what leaves branches without a reachable test. Here the orchestrator is thin
 * enough to read in one sitting.
 *
 * ## Every write is a transaction (`docs/multi-window.md` §5(d))
 *
 * Every open VS Code window — and every profile, fork and Extension Development Host on the
 * machine — runs its own copy of this store over the *same* `companion-state.json`. The state
 * used to be read once per worker and written unconditionally at the end of every scan, so
 * two windows alternated writing hours-old private forks over each other.
 *
 * The fix is `mutate`/`transact`: take a short file lock, **re-read the file**, apply, write,
 * release. Re-reading is the whole design, and the reason it is cheap is that
 * `applyProviderLedger(previous, observation)` is already the merge function. Fold the same
 * observation against a ledger the other window has already advanced and the answer is
 * `delta = 0` — no double hatch, no double encounter, no double toast, by arithmetic rather
 * than by exclusion. Everything else in the state is then safe by construction: with no stale
 * base to write from, last-writer-wins has nothing left to lose.
 *
 * **The lock is never held across a PokéAPI call.** `update()` is a pure fold committed in one
 * hold, followed by the network effects (hatch, spawn, pre-roll) each committing its own
 * result in a second short hold. `test/companion-store.test.ts` asserts that against the stub
 * provider rather than trusting the intent.
 *
 * The in-memory-only fields — `line`, `eventUntil`, the network backoff, `pendingEvents` —
 * deliberately stay per window. They are display state, not progress.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as AppPaths from '../appPaths.js'
import { atomicWriteFile } from '../coordination/atomicWrite.js'
import { FileLock, lockPathFor, type LockResult } from '../coordination/fileLock.js'
import type { BaseSpecies, PokeProviding } from '../pokeapi.js'
import { chooseBaseFromIndex, chooseBaseViaREST } from '../pokeapi.js'
import {
  EncounterBalance,
  addEncounterUsage,
  enqueueEncounter,
  owedEncounters,
  payForEncounter,
  runFromEncounter,
  throwBall,
  withoutWanderedOff,
  type ThrowOutcome,
} from './encounters.js'
import { trainerIDOrDefault } from './trainers.js'
import {
  computeDisplayState,
  eggProgress,
  eggReadyToHatch,
  rollDittoDisguise,
  rollShiny,
  type BurnTier,
} from './display.js'
import { applyUsage, makeEvolutionPlan, normalizedEvolutionState, type RNG } from './growth.js'
import {
  applyLegendaryTriggers,
  applyProviderLedger,
  creditDelta,
  noteAccrualDay,
  spendableBalance,
  type LegendaryAward,
} from './ledger.js'
import {
  type BallKind,
  type CompanionState,
  type CompanionStateKind,
  type DexEntry,
  type EvoLine,
  type MonState,
  NATURES,
  type Rarity,
  type WildEncounter,
  PokemonBalance,
  PokemonOdds,
  RareCandy,
  currentSpeciesID,
  evoDepth,
  freshCompanionState,
  localizedName,
  totalForms,
} from './model.js'
import { decodeCompanionState, encodeCompanionState } from './persistence.js'
import { backupFileName, pruneBackups, sanitized } from './saveTransfer.js'

/** Window during which a hatch/evolve/graduate celebration keeps the display in `levelUp`. */
const EVENT_WINDOW_MS = 4_000
const GRADUATE_EVENT_WINDOW_MS = 6_000
/** At most one encounter toast per hour, and only for a shiny or a legendary. */
const ENCOUNTER_TOAST_COOLDOWN_MS = 60 * 60_000
/** Egg progress past which the next species is pre-rolled. See `prefetchHatchIfNeeded`. */
const HATCH_PREFETCH_PROGRESS = 0.5
/**
 * How long a transaction waits for the save's lock before giving up.
 *
 * Generous, because every hold is milliseconds of local I/O: reaching this deadline means
 * another window is wedged, not merely busy. What happens then is the caller's decision —
 * an accrual skips (the delta stays unclaimed in the file's ledger and folds on the next
 * tick) and a user action throws `SaveBusyError`.
 */
const LOCK_TIMEOUT_MS = 5_000

export type CompanionEvent =
  | { kind: 'hatched'; speciesID: number; name: string; isShiny: boolean }
  | { kind: 'evolved'; speciesID: number; name: string }
  | { kind: 'graduated'; name: string }
  | { kind: 'dittoRevealed'; disguisedAs: string; isShiny: boolean }
  | { kind: 'candyGranted'; count: number; windowName: string }
  /**
   * A wild Pokémon appeared and it is worth interrupting for. The filter runs *before* the
   * push (`noteEncounterAppeared`): only a shiny or a legendary, at most one per hour. Ordinary
   * encounters never become events — they surface through the panel and the badge. A catch is
   * not an event either: the player is watching the animation that announces it.
   */
  | { kind: 'wildAppeared'; speciesID: number; name: string; rarity: Rarity; isShiny: boolean }
  /**
   * A guaranteed legendary was *earned*. Emitted by the trigger, at the moment it fires, and
   * separate from `wildAppeared` on purpose: the two answer different questions ("why did this
   * happen" and "who turned up"), and the reward can be owed for a while before the species is
   * known — offline, or with a full queue. The copy therefore says a legendary is on its way
   * rather than that one has appeared.
   *
   * **One event per fold, however many triggers fired.** Both can fire at once — a milestone
   * crossed on the third day of a week — and two notifications in the same second for one
   * piece of work read as a bug rather than as a bigger reward. The entitlements still add up
   * (two legendaries are owed); only the announcement is merged.
   */
  | { kind: 'legendaryEarned'; via: 'streak'; days: number }
  | { kind: 'legendaryEarned'; via: 'milestone'; tokens: number }
  | { kind: 'legendaryEarned'; via: 'both'; days: number; tokens: number }

/**
 * A user action that could not take the save's lock inside its deadline.
 *
 * Thrown rather than swallowed on purpose: a purchase that did not commit must never look
 * like it worked (`docs/multi-window.md` §5(d)). The worker turns this into localised text;
 * the host shows it. An *accrual* never throws — it just skips, and loses nothing.
 */
export class SaveBusyError extends Error {
  constructor() {
    super('another window is writing the save')
    this.name = 'SaveBusyError'
  }
}

/** What `mutate` reports back: it either committed under the lock, or the lock was busy. */
export type CommitResult<T> = { committed: true; value: T } | { committed: false }

/**
 * The transaction handed to `mutate`. Everything on it runs inside one lock hold, against the
 * state **as it is on disk right now** — never against the copy this window has been holding
 * since its first scan.
 */
export interface Mutation {
  /** The freshly re-read state, and the new state once `commit` has been called. */
  readonly state: Readonly<CompanionState>
  /**
   * Replaces the state. The last call wins; not calling it at all commits the re-read state
   * unchanged, which is how a rule that decides "not enough tokens" reports a no-op.
   *
   * `keepLine` matters: a shop purchase does not change the species, so dropping the loaded
   * evolution line would force a needless refetch and briefly disable the candy (which is
   * gated on the line being loaded).
   */
  commit(next: CompanionState, keepLine?: boolean): void
  /** Injects one Rare Candy's XP through the ordinary growth path (carry, evolve, graduate). */
  applyCandy(): void
}

export interface StoreOptions {
  provider: PokeProviding
  filePath?: string
  now?: () => number
  rng?: RNG
  hostLanguage?: string
  /**
   * How long a transaction waits for the save's lock. Tests shorten it so contention is a
   * fast, deterministic outcome instead of a five-second pause.
   */
  lockTimeoutMs?: number
  /** Disabled in tests so the Ditto disguise roll is deterministic. */
  dittoEnabled?: boolean
  /**
   * Read at each spawn (a callback, because the setting can change while the store lives).
   * `false` silences even the shiny/legendary encounter toast; the badge and the panel still
   * update. Absent means on.
   */
  encounterToastsEnabled?: () => boolean
}

/**
 * Folds this fold's awards into the one notification they are worth.
 *
 * Kept as a function rather than inlined so the rare both-fired case is reachable from a test
 * without driving a store through a milestone *and* a week of days — and so a third trigger has
 * one obvious place to decide what it says beside the others.
 */
function legendaryEarnedEvent(awards: readonly LegendaryAward[]): CompanionEvent | undefined {
  const days = awards.find((a) => a.kind === 'streak')?.days
  const tokens = awards.find((a) => a.kind === 'milestone')?.tokens
  if (days !== undefined && tokens !== undefined) {
    return { kind: 'legendaryEarned', via: 'both', days, tokens }
  }
  if (days !== undefined) return { kind: 'legendaryEarned', via: 'streak', days }
  if (tokens !== undefined) return { kind: 'legendaryEarned', via: 'milestone', tokens }
  return undefined
}

export class CompanionStore {
  private state: CompanionState
  private line: EvoLine | undefined
  private eventUntil = 0
  private hatching = false
  /**
   * PokéAPI failure backoff, in-memory only. Without it, an offline user re-attempted the
   * full sequential fetch chain on every scan — worst case minutes of hanging requests
   * *inside* `update()`, which the whole scan awaits before the totals reach the status bar.
   * Backoff changes only *when* the retry happens; the egg/Pokémon is preserved exactly as
   * before, and a success resets it so recovery is immediate.
   */
  private networkBackoffMs = 0
  private nextNetworkAttempt = 0
  private pendingEvents: CompanionEvent[] = []
  private loading: Promise<void> | undefined
  /** Mirrors `hatching`: a spawn awaits the network, and two overlapping runs would double-pay. */
  private spawning = false
  /** Same guard for the egg pre-roll: two overlapping runs would roll the species twice. */
  private prefetching = false
  /**
   * Disambiguates encounter ids inside one clock tick. A *paid* encounter is separated by
   * `encountersSeen`, but a granted legendary deliberately does not touch that counter, so two
   * grants of the same species in the same millisecond would otherwise share an id — and the
   * webview addresses encounters by id, so the second throw would resolve the first one.
   */
  private spawnSerial = 0

  constructor(private readonly options: StoreOptions) {
    this.state = freshCompanionState(options.hostLanguage)
  }

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  private get rng(): RNG {
    return this.options.rng ?? (() => Math.floor(Math.random() * 0x7fffffff))
  }

  private get filePath(): string {
    return this.options.filePath ?? join(AppPaths.ourData(), 'companion-state.json')
  }

  /**
   * The lock guarding `filePath`, minted once.
   *
   * Deliberately **not** given this store's injected `now`. That clock is the game's, and
   * tests freeze it; an acquire deadline computed from a frozen clock never passes, so a
   * contended lock would spin for ever instead of reporting contention. Lock timestamps are
   * operational, so they belong on the real clock.
   */
  private get lock(): FileLock {
    this.fileLock ??= new FileLock({ path: lockPathFor(this.filePath) })
    return this.fileLock
  }
  private fileLock: FileLock | undefined

  // MARK: - Persistence

  /**
   * A payload that is not an object at all is backed up before starting fresh, so a bad file
   * is never silently destroyed — the user can still send it in.
   *
   * The in-flight promise is held rather than a "loaded" boolean, for the same reason
   * `LocalUsageCache.ensureLoaded` holds one: a flag flipped before the `await` lets a second
   * caller past while the save is still being read, and it would then act on — and persist —
   * a fresh state on top of real progress. The dispatcher serialises requests today, so this
   * is a guard rather than a live bug; guards are what keep it that way when it stops.
   */
  load(): Promise<void> {
    this.loading ??= this.readSave()
    return this.loading
  }

  private async readSave(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return // no save yet
    }
    try {
      this.state = sanitized(decodeCompanionState(JSON.parse(raw), this.options.hostLanguage))
    } catch {
      await this.backupCorruptFile(raw)
      this.state = freshCompanionState(this.options.hostLanguage)
    }
  }

  private async backupCorruptFile(raw: string): Promise<void> {
    const directory = join(this.filePath, '..')
    try {
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(join(directory, backupFileName(this.now)), raw, 'utf8')
    } catch {
      // Backing up is best effort; failing it must not block recovery.
    }
    // A save that fails to parse usually fails again on the next launch, so without pruning
    // this is the path that accumulates one file per start, for ever.
    await pruneBackups(directory)
  }

  /**
   * Re-reads the save from disk, mid-life, inside a lock hold. **This is the design.**
   *
   * Without it every write starts from a base that may be hours old and the file is simply
   * overwritten; with it, the fold that follows sees what every other window has already
   * done, and `applyProviderLedger` answers `delta = 0` for work that is already claimed.
   *
   * Unlike `readSave`, an unparseable file here is *kept* rather than backed up and replaced
   * by a fresh state. `load()` owns the corruption path; repeating it on every write would
   * rotate the five kept backups away (`saveTransfer.BACKUPS_TO_KEEP`) and, worse, would let
   * one bad read persist a fresh state over real progress. Holding what we have and writing
   * it back is the strictly better recovery.
   */
  private async reread(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return // no save on disk yet: what we hold *is* the state
    }
    try {
      this.adopt(decodeCompanionState(JSON.parse(raw), this.options.hostLanguage))
    } catch {
      // Unreadable right now. Keep this window's state; the write below republishes it.
    }
  }

  private async write(): Promise<void> {
    try {
      // A private temp file, then a rename: an interrupted write must never truncate a save,
      // and every other VS Code window writes this same path with its own worker.
      await atomicWriteFile(this.filePath, encodeCompanionState(this.state), 'utf8')
    } catch {
      // Never let a save failure break a refresh; the next tick retries.
    }
  }

  /**
   * One read-modify-write under the save's lock: re-read, run `body`, write, release.
   *
   * `body` mutates `this.state` exactly as the code did before the lock existed. The only
   * thing that changed is the base it starts from. `{ acquired: false }` means the lock was
   * busy and **nothing was written** — the caller decides whether that is a skip or an error.
   *
   * Nothing inside `body` may touch the network. That is the invariant the two-hold shape of
   * `update()` exists to keep, and `test/companion-store.test.ts` asserts it on the provider.
   */
  private async transact<T>(body: () => T | Promise<T>): Promise<LockResult<T>> {
    return this.lock.withLock(async () => {
      await this.reread()
      const value = await body()
      await this.write()
      return value
    }, this.options.lockTimeoutMs ?? LOCK_TIMEOUT_MS)
  }

  /**
   * The public transaction: everything outside this module that changes the save goes through
   * it, so the `snapshot()` → transform → write-back pattern has nowhere left to live.
   *
   * ```ts
   * const result = await companion.mutate((tx) => {
   *   const next = buyItem(tx.state, 'masterBall', 1)
   *   if (next !== undefined) tx.commit(next)
   *   return next !== undefined
   * })
   * ```
   *
   * `{ committed: false }` means the lock was busy. For a user action that must be surfaced,
   * never swallowed.
   */
  async mutate<T>(fn: (tx: Mutation) => T | Promise<T>): Promise<CommitResult<T>> {
    await this.load()
    const result = await this.transact(() => fn(this.mutation()))
    return result.acquired ? { committed: true, value: result.value } : { committed: false }
  }

  /**
   * Adopts whatever another window has written, **without writing anything back**.
   *
   * This is what a watch event on `companion-state.json` runs. It takes no lock and needs
   * none: every writer publishes through `atomicWriteFile`, so a concurrent read sees one
   * writer's complete payload or the previous one, never a torn mixture — and holding a lock
   * to read would only mean waiting for a writer whose bytes we would then read anyway.
   *
   * **Not writing is the load-bearing half.** `transact` writes on every hold, changed or
   * not, so a watch handler that answered a change with a mutation would hand the other
   * window a change to answer, for ever, at the debounce interval. Two windows ping-ponging
   * once a second is worse than the two-minute staleness this exists to remove.
   */
  async syncFromDisk(): Promise<void> {
    await this.load()
    await this.reread()
  }

  private mutation(): Mutation {
    // A getter, not a captured value: `applyCandy` has to grow the state a `commit` just set.
    const store = this
    return {
      get state(): Readonly<CompanionState> {
        return store.state
      },
      commit: (next, keepLine = true) => store.adopt(next, keepLine),
      applyCandy: () => store.applyCandy(),
    }
  }

  // MARK: - Reading

  snapshot(): Readonly<CompanionState> {
    return this.state
  }

  currentLine(): EvoLine | undefined {
    return this.line
  }

  spendable(): number {
    return spendableBalance(this.state)
  }

  displayState(inputs: {
    burnTier: BurnTier
    limitWarning: boolean
    hasUsageData: boolean
    todayTokens: number
  }): CompanionStateKind {
    return computeDisplayState(this.state, { ...inputs, eventActive: this.now < this.eventUntil })
  }

  /**
   * Whether the hatch/evolve/graduate celebration window is open **right now**.
   *
   * The panel must read this live rather than trust the snapshot's `levelUp`: `render`-type
   * requests reuse the last scan verbatim, so a display state frozen there kept the panel
   * celebrating — sparkle parked over the companion — for up to a full refresh interval after
   * the window had closed.
   */
  isCelebrating(): boolean {
    return this.now < this.eventUntil
  }

  displayName(): string | undefined {
    if (this.state.active === undefined || this.line === undefined) return undefined
    return localizedName(this.line, currentSpeciesID(this.state.active), this.state.language)
  }

  /** Drains the events accumulated since the last call, for notifications and celebrations. */
  drainEvents(): CompanionEvent[] {
    const events = this.pendingEvents
    this.pendingEvents = []
    return events
  }

  /**
   * Takes on a new state — from a `commit` inside a transaction, or from re-reading the file.
   *
   * The one rule: the per-window caches (`line`, and with it the celebration window) survive
   * only while the species is the same object it was. Compared as identities including
   * "no Pokémon at all", so a graduation this window performed keeps its own six seconds of
   * celebration while a *different* window's graduation correctly ends it.
   */
  private adopt(state: CompanionState, keepLine = true): void {
    const sameSpecies = keepLine && state.active?.baseID === this.state.active?.baseID
    this.state = sanitized(state)
    if (!sameSpecies) {
      this.line = undefined
      this.eventUntil = 0
    }
  }

  /** Injects one Rare Candy's XP through the ordinary growth path (carry, evolve, graduate). */
  private applyCandy(): void {
    if (this.state.active === undefined || this.line === undefined) return
    this.grow(RareCandy.xp)
  }

  // MARK: - Update

  /**
   * Folds one usage observation in: accrue, credit, grow, and then hatch if the egg is ready.
   *
   * Usage is credited even with no evolution line loaded (just after start, or offline). The
   * per-provider ledger has already advanced, so dropping the delta here would lose it for
   * good; only the evolution decision waits for the line.
   */
  async update(observation: {
    todayTokensByProvider: Record<string, number>
    todayDate: string
    hasUsageData: boolean
  }): Promise<void> {
    await this.load()

    // Hold one: the pure fold. Nothing here touches the network, so the lock is held for a
    // read, some arithmetic and a write.
    //
    // A busy lock skips the whole tick and loses nothing. The observation is cumulative and
    // the delta is derived from what the *file* has claimed, so the tokens stay unclaimed and
    // fold on the next tick — exactly as if this window had been asleep for two minutes.
    const folded = await this.transact(() => this.foldObservation(observation))
    if (!folded.acquired) return

    // Holds two and beyond, each opened by the effect that needs it and each preceded by the
    // PokéAPI call it commits the result of. Read once: a failure reported by an earlier
    // effect must not silently cancel the later ones this pass, only the next one.
    const networkAllowed = this.now >= this.nextNetworkAttempt
    if (eggReadyToHatch(this.state) && !this.hatching && networkAllowed) await this.hatchIfNeeded()
    if (this.state.active !== undefined && this.line === undefined && !this.hatching && networkAllowed) {
      await this.loadCurrentLine()
    }
    if (networkAllowed && !this.spawning) await this.spawnEncountersIfNeeded()
    if (networkAllowed && !this.prefetching) await this.prefetchHatchIfNeeded()
  }

  /**
   * The fold itself: pure with respect to the outside world, and therefore safe to run inside
   * a lock hold.
   *
   * `applyProviderLedger` is the merge function this whole design leans on. Its `previous`
   * argument is the state re-read from disk a moment ago, so a second window folding the same
   * observation diffs it against a ledger the first has already advanced and gets `delta = 0`.
   * Everything hanging off `delta > 0` — the egg, growth, a hatch, encounter usage, the
   * legendary triggers and their toast — therefore runs exactly once per window-independent
   * unit of work rather than once per open window.
   */
  private foldObservation(observation: {
    todayTokensByProvider: Record<string, number>
    todayDate: string
    hasUsageData: boolean
  }): void {
    const { state, delta } = applyProviderLedger(this.state, observation)
    this.state = state

    // Before anything reads the queue's length. A full queue freezes accrual, so an encounter
    // that has wandered off has to free its slot *this* pass — otherwise the tokens earned in
    // the same refresh are held back against room that is no longer occupied.
    const waiting = withoutWanderedOff(this.state.wild, this.now)
    if (waiting.length !== this.state.wild.length) this.state = { ...this.state, wild: waiting }

    if (delta > 0) {
      // Before crediting, so the day is recorded from the same fact the growth meter moves on:
      // real accrual. A refresh that contributes nothing is not a day of work.
      this.state = noteAccrualDay(this.state, observation.todayDate)
      this.state = creditDelta(this.state, delta)
      // creditDelta already moved usedAtStage, so growth is evaluated with a zero delta.
      if (this.state.active !== undefined) this.grow(0)
      // Accrued beside `creditDelta`, not inside it: that function routes a delta to exactly one
      // of two destinations (the egg or the current stage), while an encounter accrues in either
      // case. Folding it in would make a two-way choice a three-way one it is not. The queue
      // length caps the accumulator: a full queue accrues nothing, so a resolved encounter is
      // never instantly replaced out of a bank.
      this.state = {
        ...this.state,
        encounterUsage: addEncounterUsage(this.state.encounterUsage, delta, this.state.wild.length),
      }

      // Evaluated after crediting, so the milestone rule reads the total this fold produced,
      // and only on a fold that accrued: both rewards are earned by *using* the tools, never by
      // leaving the editor open. The triggers decide; `grantLegendaryEncounter` (inside) owes;
      // `spawnEncountersIfNeeded` delivers. None of the three knows what the others are for.
      const triggered = applyLegendaryTriggers(this.state, observation.todayDate)
      this.state = triggered.state
      const earned = legendaryEarnedEvent(triggered.awards)
      if (earned !== undefined) this.pendingEvents.push(earned)
    }
  }

  // MARK: - Wild encounters

  /**
   * Materialises the encounters the accumulated usage has paid for.
   *
   * Usage is spent only once an encounter exists (`payForEncounter` after the fetch, never
   * before), so an offline spell defers encounters instead of losing them — the same bargain
   * `hatchIfNeeded` strikes with the egg, and it shares that path's backoff.
   *
   * Two phases, because the rolls are PokéAPI calls and the lock may not be held across one.
   * Rolling is **speculative**: this window rolls what its own copy says it is owed, and the
   * re-read state inside the hold decides how many of those are actually paid for. A window
   * whose encounters another has already minted finds `owedEncounters` at zero and drops its
   * rolls on the floor — one wasted request, no double spawn.
   */
  private async spawnEncountersIfNeeded(): Promise<void> {
    const owed = owedEncounters(this.state.encounterUsage, this.state.encountersSeen)
    const owedLegendaries = this.state.owedLegendaryEncounters
    // Never mint into a full queue: paying the threshold and letting `enqueueEncounter` drop
    // something would waste tokens on encounters nobody sees — and could announce a Pokémon
    // that was itself the one dropped. Accrual is already capped by the queue's room, but owed
    // usage can still exceed it (an imported save, or a spawn deferred by a network failure
    // while the queue filled), so the guard stays.
    const room = EncounterBalance.maxQueue - this.state.wild.length
    // A full queue holds a granted legendary too, rather than letting `enqueueEncounter` make
    // room for it: with twelve legendaries waiting, the one dropped would be a legendary.
    // Deferring costs nothing — the entitlement is persisted, so it arrives when a slot frees.
    if ((owed === 0 && owedLegendaries === 0) || room <= 0) return

    this.spawning = true
    try {
      // No REST fallback here, unlike hatching. A hatch is the whole game and worth up to
      // sixteen probing requests; an encounter is one of many, and burning that on a Caterpie
      // would slow every scan for a decoration. It waits for the index instead.
      const index = await this.baseIndex()
      if (index === undefined) {
        this.noteNetworkFailure()
        return
      }

      // At most one granted legendary per refresh. Two triggers firing in the same fold owe
      // two, and delivering both at once would dump a pair of legendaries into the queue in the
      // same second; the second is carried, not dropped.
      let slots = room
      let reward: WildEncounter | undefined
      if (owedLegendaries > 0) {
        reward = await this.rollEncounter(index, 'legendary')
        if (reward === undefined) {
          // Either the network is down or the cached index predates the legendary flags. Both
          // resolve themselves; the entitlement stays owed until one of them does.
          this.noteNetworkFailure()
          return
        }
        slots -= 1
      }

      const rolled: WildEncounter[] = []
      let rollFailed = false
      for (let i = 0; i < Math.min(owed, slots); i++) {
        const encounter = await this.rollEncounter(index)
        if (encounter === undefined) {
          rollFailed = true
          break // usage stays banked: this encounter is deferred, not lost
        }
        rolled.push(encounter)
      }
      if (rollFailed) this.noteNetworkFailure()
      else this.noteNetworkSuccess()

      // Every network call is behind us; the hold below is arithmetic and one write.
      if (reward !== undefined || rolled.length > 0) {
        await this.transact(() => this.commitSpawns(reward, rolled))
      }
    } finally {
      this.spawning = false
    }
  }

  /**
   * Files the rolled encounters against the state as it is on disk **now**.
   *
   * Both counters are re-derived here rather than carried in from the rolling phase: another
   * window that has already minted these encounters advanced `encountersSeen` and drained
   * `encounterUsage`, so `owedEncounters` answers zero and this window's rolls are dropped.
   * Same for the granted legendary, which is only delivered while the file still owes one.
   */
  private commitSpawns(reward: WildEncounter | undefined, rolled: readonly WildEncounter[]): void {
    let room = EncounterBalance.maxQueue - this.state.wild.length
    if (room <= 0) return

    if (reward !== undefined && this.state.owedLegendaryEncounters > 0) {
      this.state = {
        ...this.state,
        owedLegendaryEncounters: this.state.owedLegendaryEncounters - 1,
        wild: enqueueEncounter(this.state.wild, reward),
      }
      this.noteEncounterAppeared(reward)
      room -= 1
    }

    for (const encounter of rolled) {
      if (room <= 0) break
      if (owedEncounters(this.state.encounterUsage, this.state.encountersSeen) === 0) break
      const paid = payForEncounter(this.state.encounterUsage, this.state.encountersSeen)
      this.state = {
        ...this.state,
        ...paid,
        wild: enqueueEncounter(this.state.wild, encounter),
      }
      this.noteEncounterAppeared(encounter)
      room -= 1
    }
  }

  /**
   * Encounters are frequent by design — one per 2.5M tokens — so `wildAppeared` reaching
   * `pendingEvents` means a native toast, and that is reserved: only a shiny or a legendary
   * qualifies, and even those at most once an hour (`lastEncounterToastAt` is persisted so a
   * restart does not reopen the window). Everything else surfaces through the panel and the
   * activity-bar badge, which is the "never interrupt work" default the queue exists for.
   */
  private noteEncounterAppeared(encounter: WildEncounter): void {
    if (this.options.encounterToastsEnabled?.() === false) return
    const worthAToast = encounter.isShiny || encounter.rarity === 'legendary'
    const cooledDown = this.now - (this.state.lastEncounterToastAt ?? 0) >= ENCOUNTER_TOAST_COOLDOWN_MS
    if (!worthAToast || !cooledDown) return

    this.state = { ...this.state, lastEncounterToastAt: this.now }
    this.pendingEvents.push({
      kind: 'wildAppeared',
      speciesID: encounter.speciesID,
      name: encounter.names?.[this.state.language] ?? `#${encounter.speciesID}`,
      rarity: encounter.rarity,
      isShiny: encounter.isShiny,
    })
  }

  /**
   * One wild Pokémon.
   *
   * The species pick reuses the hatch selector verbatim: its capture-rate weighting already
   * makes common species common, and halving an already-collected line is exactly the bias a
   * Pokédex wants. No tier is passed — a wild encounter carries no guarantee.
   */
  private async rollEncounter(index: BaseSpecies[], tier?: Rarity): Promise<WildEncounter | undefined> {
    // Wild catches never enter `collectedFinals` (that set steers evolution-branch diversity),
    // so without help the same Caterpie reappears at full weight for ever. The selector's
    // halve-if-seen bias is fed a *local* set instead: the real collection, plus every species
    // already caught wild, plus everything already waiting in the queue — computed per roll and
    // never persisted, so the evolution rules cannot see it.
    const seen = new Set(this.state.collectedFinals)
    for (const entry of this.state.dex) {
      if (entry.source === 'wild') seen.add(`${entry.finalID}:${entry.finalID}`)
    }
    for (const queued of this.state.wild) seen.add(`${queued.speciesID}:${queued.speciesID}`)

    // `tier` is a floor, and the granted-legendary reward is the only caller that passes one.
    // Reusing the ordinary roll rather than a parallel path is what keeps the reward an
    // ordinary wild Pokémon: same weighting inside the pool, same shiny roll, same flee rules,
    // same 24h window, same toast. A guaranteed prize would have been a different feature.
    const speciesID = chooseBaseFromIndex(index, tier, seen, this.rng)
    if (speciesID === undefined) return undefined

    try {
      const species = await this.options.provider.wildSpecies(speciesID)
      // The Shiny Charm applies to wilds too — it is described as raising shiny odds, and
      // exempting half the game from it would be the surprising reading.
      const isShiny = rollShiny(this.state, this.rng)
      const encounter: WildEncounter = {
        id: `w${this.now}-${speciesID}-${this.state.encountersSeen}-${this.spawnSerial++}`,
        speciesID,
        captureRate: species.captureRate,
        rarity: species.rarity,
        isShiny,
        appearedAt: this.now,
        throws: 0,
      }
      if (Object.keys(species.names).length > 0) encounter.names = species.names
      return encounter
    } catch {
      return undefined
    }
  }

  /**
   * Throws one ball. The wobble count comes back with the outcome because the animation plays
   * it — deriving it again in the webview would be a second source of truth for a die already
   * cast.
   *
   * A user action, so a busy lock throws `SaveBusyError` rather than reporting a miss: a ball
   * that was never thrown must not come back as "it broke free".
   */
  async throwBallAt(encounterID: string, ball: BallKind): Promise<ThrowOutcome> {
    await this.load()
    // Under the lock and against the re-read queue: a Pokémon another window already caught
    // is simply not there, so the throw answers `unknownEncounter` instead of resurrecting it.
    const result = await this.transact(() => {
      const thrown = throwBall(this.state, encounterID, ball, this.rng, this.now)
      this.state = thrown.state

      // No pendingEvent on a catch: the player is looking at the panel — they just clicked the
      // throw — so a native toast would only repeat what the animation is showing. The event
      // window still runs so the status bar celebrates alongside.
      if (thrown.outcome.kind === 'caught') this.eventUntil = this.now + EVENT_WINDOW_MS
      return thrown.outcome
    })
    if (!result.acquired) throw new SaveBusyError()
    return result.value
  }

  /** The player walks away. Spends nothing, so there is nothing to celebrate either. */
  async runFrom(encounterID: string): Promise<void> {
    await this.load()
    const result = await this.transact(() => {
      this.state = runFromEncounter(this.state, encounterID)
    })
    if (!result.acquired) throw new SaveBusyError()
  }

  async setTrainer(trainerID: string): Promise<void> {
    await this.load()
    const result = await this.transact(() => {
      this.state = { ...this.state, trainerID: trainerIDOrDefault(trainerID) }
    })
    if (!result.acquired) throw new SaveBusyError()
  }

  /** Applies a delta through the growth rules and records whatever happened. */
  private grow(delta: number): void {
    const active = this.state.active
    if (active === undefined) return

    const result = applyUsage(active, delta, this.line, new Set(this.state.collectedFinals), this.rng)
    this.state = { ...this.state, active: result.mon }

    for (const event of result.events) {
      if (event.kind === 'evolved') {
        const name =
          this.line === undefined ? '' : localizedName(this.line, event.toSpeciesID, this.state.language)
        this.pendingEvents.push({ kind: 'evolved', speciesID: event.toSpeciesID, name })
        this.eventUntil = this.now + EVENT_WINDOW_MS
      }
      if (event.kind === 'dittoRevealed') {
        // Named from the line that is still loaded, because it is the *disguise* line — one
        // statement later there is nothing left that knows what this Pokémon pretended to be.
        const disguisedAs =
          this.line === undefined
            ? ''
            : localizedName(this.line, event.disguisedAsSpeciesID, this.state.language)
        this.pendingEvents.push({
          kind: 'dittoRevealed',
          disguisedAs,
          isShiny: result.mon.isShiny,
        })
        // Ditto is not in the disguise line's tree, so keeping it would leave the companion
        // unable to graduate. Dropping it is what makes `update` refetch for the new baseID.
        this.line = undefined
        this.eventUntil = this.now + EVENT_WINDOW_MS
      }
    }
    if (result.graduated) this.graduate(result.mon)
  }

  /**
   * Records the line in the Pokédex and hands over a fresh egg.
   *
   * `eggTier` is deliberately untouched: reaching here means a Pokémon was active, so the
   * guarantee is already absent (consumed at hatch, normalised on load). Keeping one
   * consumption point avoids two places drifting apart.
   */
  private graduate(mon: MonState): void {
    const finalID = currentSpeciesID(mon)
    const name = this.line === undefined ? '' : localizedName(this.line, finalID, this.state.language)

    const entry: DexEntry = {
      id: `${mon.baseID}-${finalID}-${this.now}`,
      baseID: mon.baseID,
      finalID,
      chainOrder: mon.pathIDs,
      rarity: mon.rarity,
      caughtAt: this.now,
      isShiny: mon.isShiny,
    }
    if (mon.nature !== undefined) entry.nature = mon.nature
    if (this.line !== undefined) {
      // Names are stored at graduation so the Pokédex renders offline and follows a language
      // switch without a network round trip.
      const names: Record<number, Record<string, string>> = {}
      for (const id of mon.pathIDs) {
        const byLang = this.line.names[id]
        if (byLang !== undefined) names[id] = byLang
      }
      entry.names = names
    }

    const collected = new Set(this.state.collectedFinals)
    collected.add(`${mon.baseID}:${finalID}`)

    const next: CompanionState = {
      ...this.state,
      dex: [...this.state.dex, entry],
      collectedFinals: [...collected],
      eggUsage: 0, // the new egg incubates from scratch
    }
    delete next.active
    this.state = next
    this.line = undefined
    this.pendingEvents.push({ kind: 'graduated', name })
    this.eventUntil = this.now + GRADUATE_EVENT_WINDOW_MS
  }

  // MARK: - Hatching

  /**
   * Rolls the species the egg will hatch into, while it is still incubating.
   *
   * The hatch is the one moment where a network round trip is visible: `hatchIfNeeded` runs
   * *inside* `update()`, which the whole scan — and with it the status bar — awaits. Deciding
   * the species ahead of time and warming the line cache moves that cost onto a tick where
   * nothing is waiting for it, which is what `pendingHatchID` was always meant to do.
   *
   * Only past the halfway mark: an egg that has just appeared may still be rerolled by a shop
   * purchase (`buyEgg` clears the pre-roll for exactly that reason), and rolling early would
   * spend a request on a species nobody ever meets. Index-only, like the encounter spawn — a
   * speculative pre-roll must never be worth sixteen REST probes.
   */
  private async prefetchHatchIfNeeded(): Promise<void> {
    if (this.state.active !== undefined || this.state.pendingHatchID !== undefined) return
    if (eggProgress(this.state) < HATCH_PREFETCH_PROGRESS) return

    this.prefetching = true
    try {
      const index = await this.baseIndex()
      if (index === undefined) {
        this.noteNetworkFailure()
        return
      }
      // An unsatisfiable guarantee empties the pool. Nothing to pre-roll, and nothing to
      // report either: `hatchIfNeeded` is where that is surfaced, once it actually matters.
      const baseID = this.pickFromIndex(index)
      if (baseID === undefined) return

      // The species is decided either way — that decision came from an index read that
      // succeeded. Warming the line is the half that makes the hatch itself free, and a
      // failure there only means the hatch fetches it the ordinary way.
      let warmed = true
      try {
        await this.options.provider.line(baseID)
      } catch {
        warmed = false
      }

      // Network done, lock now. Another window may have pre-rolled — or hatched outright —
      // while we were away; its decision is on disk and stands, and ours is discarded.
      await this.transact(() => {
        if (this.state.active !== undefined || this.state.pendingHatchID !== undefined) return
        this.state = { ...this.state, pendingHatchID: baseID }
      })
      if (warmed) this.noteNetworkSuccess()
      else this.noteNetworkFailure()
    } finally {
      this.prefetching = false
    }
  }

  private async loadCurrentLine(): Promise<void> {
    const active = this.state.active
    if (active === undefined) return
    let line: EvoLine
    try {
      line = await this.options.provider.line(active.baseID)
    } catch {
      // Offline: keep the Pokémon and retry once the backoff allows.
      this.noteNetworkFailure()
      return
    }
    this.noteNetworkSuccess()

    await this.transact(() => {
      // The fetch answered for the species we held when it started. If the file now holds a
      // different one — another window evolved, graduated or revealed a Ditto — this line
      // describes nothing, and next tick refetches for the species that is actually there.
      const current = this.state.active
      if (current === undefined || current.baseID !== active.baseID) return
      this.line = line
      // Reconcile the saved path against the current asset tree without consuming RNG when
      // the plan is still complete — otherwise a restart would silently reroll the branch.
      this.state = {
        ...this.state,
        active: normalizedEvolutionState(
          current,
          line.tree,
          new Set(this.state.collectedFinals),
          this.rng,
        ),
      }
      // A threshold may already have been passed while the line was unavailable.
      this.grow(0)
    })
  }

  private noteNetworkSuccess(): void {
    this.networkBackoffMs = 0
    this.nextNetworkAttempt = 0
  }

  /**
   * Opens (or re-opens) the backoff window.
   *
   * Several paths can fail in one pass — hatching, loading the line, spawning an encounter — and
   * the backoff describes "PokéAPI is unreachable", not how many call sites noticed. Reporting
   * twice in one pass would double the window twice, so the delay grows as 4x per tick instead
   * of 2x and reaches the 30-minute ceiling in half the ticks. Ignoring a report from inside the
   * window this pass just opened keeps one failure worth one doubling.
   */
  private noteNetworkFailure(): void {
    if (this.nextNetworkAttempt > this.now) return
    const doubled = this.networkBackoffMs === 0 ? 60_000 : this.networkBackoffMs * 2
    this.networkBackoffMs = Math.min(doubled, 30 * 60_000)
    this.nextNetworkAttempt = this.now + this.networkBackoffMs
  }

  /**
   * Hatches the egg: the species pick and the line fetch outside the lock, the hatchling
   * itself committed inside one.
   *
   * The split is what stops two windows hatching two different Pokémon from one egg. Both may
   * roll — rolling is only a couple of requests — but the commit re-reads the file first, and
   * the second window finds the egg already gone and throws its roll away without pushing a
   * `hatched` event. One egg, one Pokémon, one toast.
   */
  private async hatchIfNeeded(): Promise<void> {
    this.hatching = true
    try {
      const baseID = this.state.pendingHatchID ?? (await this.chooseBase())
      if (baseID === undefined) {
        // Keep the egg. The pick only comes back empty when the network let it down, so it
        // shares the fetch backoff rather than hammering the API again next tick.
        this.noteNetworkFailure()
        return
      }

      let line: EvoLine
      try {
        line = await this.options.provider.line(baseID)
      } catch {
        // Network trouble: the egg survives and the retry waits out the backoff.
        this.noteNetworkFailure()
        return
      }
      this.noteNetworkSuccess()

      await this.transact(() => this.commitHatch(baseID, line))
    } finally {
      this.hatching = false
    }
  }

  /** The hatch itself, inside the hold and against the re-read state. Pure but for the RNG. */
  private commitHatch(baseID: number, line: EvoLine): void {
    // Another window got there first. Its hatchling is the one in the file we just re-read;
    // ours never existed, so nothing is written and nothing is announced.
    if (this.state.active !== undefined || !eggReadyToHatch(this.state)) return

    const forms = totalForms(line)
    const plan = makeEvolutionPlan(line.tree, baseID, new Set(this.state.collectedFinals), this.rng)

    const isShiny = rollShiny(this.state, this.rng)
    // Fixed at hatch, like shininess. The Mint exists precisely to reroll it later, so
    // leaving it unset would make that item act on nothing.
    const nature = NATURES[this.rng() % NATURES.length]!
    const disguised = rollDittoDisguise(line.rarity, forms, this.options.dittoEnabled ?? true, this.rng)

    const mon: MonState = {
      baseID,
      pathIDs: [baseID],
      plannedPathIDs: plan,
      stageIndex: 0,
      // Anything spent beyond the hatch threshold carries into the hatchling's growth.
      // Read from the balance table, never retyped: a literal here is a second source of
      // truth that silently stops matching the threshold the egg was actually measured
      // against the day that number moves.
      usedAtStage: Math.max(0, this.state.eggUsage - PokemonBalance.eggHatchThreshold),
      rarity: line.rarity,
      totalForms: Math.max(forms, plan.length),
      isShiny,
      nature,
      dittoRevealed: false,
    }
    if (disguised) mon.dittoDisguise = PokemonOdds.dittoSpeciesID

    const next: CompanionState = { ...this.state, active: mon, eggUsage: 0 }
    // The guarantee is consumed here — the single consumption point.
    delete next.eggTier
    delete next.pendingHatchID
    this.state = next
    this.line = line

    this.pendingEvents.push({
      kind: 'hatched',
      speciesID: baseID,
      name: localizedName(line, baseID, this.state.language),
      isShiny,
    })
    this.eventUntil = this.now + EVENT_WINDOW_MS
  }

  /**
   * The base-species index, or `undefined` when it cannot be loaded at all. An empty index is
   * folded into `undefined` because every caller treats "nothing to pick from" as a failure.
   */
  private async baseIndex(): Promise<BaseSpecies[] | undefined> {
    try {
      const index = await this.options.provider.baseSpeciesIndex()
      return index.length === 0 ? undefined : index
    } catch {
      return undefined
    }
  }

  /**
   * Weighted pick from the index. `undefined` also means "the guarantee cannot be honoured" —
   * `chooseBaseFromIndex` empties the pool rather than silently ignoring a tier that was paid
   * for, which is why this is kept distinct from the REST fallback below.
   */
  private pickFromIndex(index: BaseSpecies[]): number | undefined {
    return chooseBaseFromIndex(index, this.state.eggTier, new Set(this.state.collectedFinals), this.rng)
  }

  /** Weighted pick, falling back to REST rejection sampling when the index is unavailable. */
  private async chooseBase(): Promise<number | undefined> {
    const index = await this.baseIndex()
    if (index !== undefined) return this.pickFromIndex(index)
    return chooseBaseViaREST(this.options.provider, this.state.eggTier, this.rng)
  }
}

export { evoDepth }
