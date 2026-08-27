/**
 * The stateful companion orchestrator: the piece that owns persistence and sequencing while
 * every rule it applies lives in the pure modules beside it (`ledger`, `growth`, `shop`,
 * `display`).
 *
 * That split is deliberate. Interleaving the rules with saving, notifications and network
 * calls is what leaves branches without a reachable test. Here the orchestrator is thin
 * enough to read in one sitting.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as AppPaths from '../appPaths.js'
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
  type ThrowOutcome,
} from './encounters.js'
import { trainerIDOrDefault } from './trainers.js'
import {
  computeDisplayState,
  eggReadyToHatch,
  rollDittoDisguise,
  rollShiny,
  type BurnTier,
} from './display.js'
import { applyUsage, makeEvolutionPlan, normalizedEvolutionState, type RNG } from './growth.js'
import { applyProviderLedger, creditDelta, spendableBalance } from './ledger.js'
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
  PokemonOdds,
  RareCandy,
  currentSpeciesID,
  evoDepth,
  freshCompanionState,
  localizedName,
  totalForms,
} from './model.js'
import { decodeCompanionState, encodeCompanionState } from './persistence.js'
import { backupFileName, sanitized } from './saveTransfer.js'

/** Window during which a hatch/evolve/graduate celebration keeps the display in `levelUp`. */
const EVENT_WINDOW_MS = 4_000
const GRADUATE_EVENT_WINDOW_MS = 6_000
/** At most one encounter toast per hour, and only for a shiny or a legendary. */
const ENCOUNTER_TOAST_COOLDOWN_MS = 60 * 60_000

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

export interface StoreOptions {
  provider: PokeProviding
  filePath?: string
  now?: () => number
  rng?: RNG
  hostLanguage?: string
  /** Disabled in tests so the Ditto disguise roll is deterministic. */
  dittoEnabled?: boolean
  /**
   * Read at each spawn (a callback, because the setting can change while the store lives).
   * `false` silences even the shiny/legendary encounter toast; the badge and the panel still
   * update. Absent means on.
   */
  encounterToastsEnabled?: () => boolean
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
  private loaded = false
  /** Mirrors `hatching`: a spawn awaits the network, and two overlapping runs would double-pay. */
  private spawning = false

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

  // MARK: - Persistence

  /**
   * A payload that is not an object at all is backed up before starting fresh, so a bad file
   * is never silently destroyed — the user can still send it in.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
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
    try {
      await fs.mkdir(join(this.filePath, '..'), { recursive: true })
      await fs.writeFile(join(this.filePath, '..', backupFileName(this.now)), raw, 'utf8')
    } catch {
      // Backing up is best effort; failing it must not block recovery.
    }
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(join(this.filePath, '..'), { recursive: true })
      // Written to a temp file and renamed: an interrupted write must never truncate a save.
      const temp = `${this.filePath}.tmp`
      await fs.writeFile(temp, encodeCompanionState(this.state), 'utf8')
      await fs.rename(temp, this.filePath)
    } catch {
      // Never let a save failure break a refresh; the next tick retries.
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
   * Replaces the state in place, used by shop actions and by importing a save.
   *
   * `keepLine` matters: a shop purchase does not change the species, so dropping the loaded
   * evolution line would force a needless refetch and briefly disable the candy (which is
   * gated on the line being loaded).
   */
  replaceState(state: CompanionState, keepLine = true): void {
    const sameSpecies =
      keepLine &&
      this.state.active !== undefined &&
      state.active !== undefined &&
      state.active.baseID === this.state.active.baseID
    this.state = sanitized(state)
    if (!sameSpecies) {
      this.line = undefined
      this.eventUntil = 0
    }
  }

  /** Injects one Rare Candy's XP through the ordinary growth path (carry, evolve, graduate). */
  applyCandy(): void {
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

    const { state, delta } = applyProviderLedger(this.state, observation)
    this.state = state

    if (delta > 0) {
      this.state = creditDelta(this.state, delta)
      // creditDelta already moved usedAtStage, so growth is evaluated with a zero delta.
      if (this.state.active !== undefined) this.grow(0)
      // Accrued beside `creditDelta`, not inside it: that function routes a delta to exactly one
      // of two destinations (the egg or the current stage), while an encounter accrues in either
      // case. Folding it in would make a two-way choice a three-way one it is not.
      this.state = {
        ...this.state,
        encounterUsage: addEncounterUsage(this.state.encounterUsage, delta),
      }
    }

    const networkAllowed = this.now >= this.nextNetworkAttempt
    if (eggReadyToHatch(this.state) && !this.hatching && networkAllowed) await this.hatchIfNeeded()
    if (this.state.active !== undefined && this.line === undefined && !this.hatching && networkAllowed) {
      await this.loadCurrentLine()
    }
    if (networkAllowed && !this.spawning) await this.spawnEncountersIfNeeded()
    await this.save()
  }

  // MARK: - Wild encounters

  /**
   * Materialises the encounters the accumulated usage has paid for.
   *
   * Usage is spent only once an encounter exists (`payForEncounter` after the fetch, never
   * before), so an offline spell defers encounters instead of losing them — the same bargain
   * `hatchIfNeeded` strikes with the egg, and it shares that path's backoff.
   */
  private async spawnEncountersIfNeeded(): Promise<void> {
    const owed = owedEncounters(this.state.encounterUsage, this.state.encountersSeen)
    // A full queue banks the usage instead of minting: paying the threshold and letting
    // `enqueueEncounter` drop something would waste tokens on encounters nobody sees — and could
    // announce a Pokémon that was itself the one dropped. Working through the queue is what
    // releases the banked spawns.
    const room = EncounterBalance.maxQueue - this.state.wild.length
    if (owed === 0 || room <= 0) return

    this.spawning = true
    try {
      let index: BaseSpecies[] | undefined
      try {
        index = await this.options.provider.baseSpeciesIndex()
      } catch {
        index = undefined
      }
      // No REST fallback here, unlike hatching. A hatch is the whole game and worth up to
      // sixteen probing requests; an encounter is one of many, and burning that on a Caterpie
      // would slow every scan for a decoration. It waits for the index instead.
      if (index === undefined || index.length === 0) {
        this.noteNetworkFailure()
        return
      }

      for (let i = 0; i < Math.min(owed, room); i++) {
        const encounter = await this.rollEncounter(index)
        if (encounter === undefined) {
          this.noteNetworkFailure()
          return // usage stays banked: this encounter is deferred, not lost
        }

        const paid = payForEncounter(this.state.encounterUsage, this.state.encountersSeen)
        this.state = {
          ...this.state,
          ...paid,
          wild: enqueueEncounter(this.state.wild, encounter),
        }
        this.noteEncounterAppeared(encounter)
      }
      this.noteNetworkSuccess()
    } finally {
      this.spawning = false
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
  private async rollEncounter(index: BaseSpecies[]): Promise<WildEncounter | undefined> {
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

    const speciesID = chooseBaseFromIndex(index, undefined, seen, this.rng)
    if (speciesID === undefined) return undefined

    try {
      const species = await this.options.provider.wildSpecies(speciesID)
      // The Shiny Charm applies to wilds too — it is described as raising shiny odds, and
      // exempting half the game from it would be the surprising reading.
      const isShiny = rollShiny(this.state, this.rng)
      const encounter: WildEncounter = {
        id: `w${this.now}-${speciesID}-${this.state.encountersSeen}`,
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
   */
  async throwBallAt(encounterID: string, ball: BallKind): Promise<ThrowOutcome> {
    await this.load()
    const result = throwBall(this.state, encounterID, ball, this.rng, this.now)
    this.state = result.state

    // No pendingEvent on a catch: the player is looking at the panel — they just clicked the
    // throw — so a native toast would only repeat what the animation is showing. The event
    // window still runs so the status bar celebrates alongside.
    if (result.outcome.kind === 'caught') this.eventUntil = this.now + EVENT_WINDOW_MS

    await this.save()
    return result.outcome
  }

  /** The player walks away. Spends nothing, so there is nothing to celebrate either. */
  async runFrom(encounterID: string): Promise<void> {
    await this.load()
    this.state = runFromEncounter(this.state, encounterID)
    await this.save()
  }

  async setTrainer(trainerID: string): Promise<void> {
    await this.load()
    this.state = { ...this.state, trainerID: trainerIDOrDefault(trainerID) }
    await this.save()
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

  private async loadCurrentLine(): Promise<void> {
    const active = this.state.active
    if (active === undefined) return
    try {
      const line = await this.options.provider.line(active.baseID)
      this.line = line
      // Reconcile the saved path against the current asset tree without consuming RNG when
      // the plan is still complete — otherwise a restart would silently reroll the branch.
      this.state = {
        ...this.state,
        active: normalizedEvolutionState(
          active,
          line.tree,
          new Set(this.state.collectedFinals),
          this.rng,
        ),
      }
      // A threshold may already have been passed while the line was unavailable.
      this.grow(0)
      this.noteNetworkSuccess()
    } catch {
      // Offline: keep the Pokémon and retry once the backoff allows.
      this.noteNetworkFailure()
    }
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

      const line = await this.options.provider.line(baseID)
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
        usedAtStage: Math.max(0, this.state.eggUsage - 5_000_000),
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
      this.noteNetworkSuccess()
    } catch {
      // Network trouble: the egg survives and the retry waits out the backoff.
      this.noteNetworkFailure()
    } finally {
      this.hatching = false
    }
  }

  /** Weighted pick, falling back to REST rejection sampling when the index is unavailable. */
  private async chooseBase(): Promise<number | undefined> {
    const tier = this.state.eggTier
    let index: BaseSpecies[] | undefined
    try {
      index = await this.options.provider.baseSpeciesIndex()
    } catch {
      index = undefined
    }
    if (index !== undefined && index.length > 0) {
      return chooseBaseFromIndex(index, tier, new Set(this.state.collectedFinals), this.rng)
    }
    return chooseBaseViaREST(this.options.provider, tier, this.rng)
  }
}

export { evoDepth }
