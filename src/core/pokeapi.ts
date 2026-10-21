/**
 * PokéAPI client.
 *
 * Pokémon data is fetched at runtime and never bundled in the repository — that is a licence
 * obligation, not a size optimisation.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as AppPaths from './appPaths.js'
import { atomicWriteFile } from './coordination/atomicWrite.js'
import type { BaseStats } from './companion/encounters.js'
import {
  ANIMATED_SPECIES_MAX,
  type EvoLine,
  type EvoNode,
  PokemonOdds,
  type PokemonType,
  type Rarity,
  makeEvoLine,
  meetsRarityFloor,
  pokemonTypes,
  rarityFrom,
} from './companion/model.js'

/**
 * A hatch candidate: the start of an evolution line, plus its official rarity signals.
 *
 * The two flags are what make a legendary-only pool possible at all — `capture_rate` cannot
 * express the tier (see `captureRateCeiling`), so without them a guaranteed-legendary
 * encounter would have to be faked from a hard-coded species list, which is both a licence
 * problem and a lie. They cost one column each on the index query that was already being made.
 *
 * Optional because an index cached by an earlier version predates them. A missing flag reads
 * as "not legendary", so the other three tiers are unaffected and the legendary pool is empty
 * rather than wrong until the cache is refreshed — which `INDEX_SCHEMA` forces on first use.
 */
export interface BaseSpecies {
  id: number
  /** 3 (Mewtwo-class) to 255 (Caterpie-class). */
  captureRate: number
  isLegendary?: boolean
  isMythical?: boolean
  /**
   * The line's other forms, for wild encounters (`chooseWildFromIndex`). Absent in an index built
   * over REST or written before schema 3: the wild then meets bases only, as it always did.
   */
  forms?: WildForm[]
  /** Forms on the longest road through the line, the base included. Absent = 1. */
  lineForms?: number
}

/** A form past the base: its stage (1 = first evolution) and the forms on the road through it. */
export interface WildForm {
  id: number
  stage: number
  captureRate: number
  totalForms: number
}

/**
 * One species as a wild encounter needs it.
 *
 * Deliberately **not** an `EvoLine`: an encounter is a single Pokémon, and fetching its whole
 * chain would cost one request per form for a species that may well flee. What it does need
 * beyond the index is the pair of legendary flags — `capture_rate` alone cannot express the
 * legendary tier (see `captureRateCeiling`), so a Mewtwo drawn from the index would otherwise be
 * labelled "rare".
 */
export interface WildSpecies {
  id: number
  captureRate: number
  rarity: Rarity
  /** langCode -> name, restricted to the languages the app supports. */
  names: Record<string, string>
  /** PokéAPI `base_happiness`; feeds the temperament's appetite. Absent when unknown. */
  baseHappiness?: number
  /**
   * Base stats of the default form, from `/pokemon/{id}`. Absent when that request failed — the
   * temperament then falls back to neutral rather than the spawn waiting on it.
   */
  stats?: BaseStats
  /** Types of the default form, primary first. Absent with the stats: one request carries both. */
  types?: PokemonType[]
}

/** Injectable so tests use a stub rather than the network. */
export interface PokeProviding {
  line(baseSpeciesID: number): Promise<EvoLine>
  /** Every gen 1-5 base, one GraphQL query, cached on disk. */
  baseSpeciesIndex(): Promise<BaseSpecies[]>
  /** A single species, or undefined when it is not a line start. */
  baseSpecies(id: number): Promise<BaseSpecies | undefined>
  /** One species for a wild encounter. Throws when the network is down; never returns partial. */
  wildSpecies(id: number): Promise<WildSpecies>
}

const REST_BASE = 'https://pokeapi.co/api/v2'
const GRAPHQL_URL = 'https://graphql.pokeapi.co/v1beta2'
const LANG_CODES = ['ko', 'en', 'ja-Hrkt', 'ja', 'es']
const INDEX_TTL_MS = 30 * 86_400_000
/**
 * Shape of the on-disk index. A file written at a lower version is treated as *expired* rather
 * than deleted: it is refetched at the next opportunity, but it still stands in offline, where
 * a stale index beats no index — the only thing it cannot do is answer a legendary pool, and a
 * reward that waits is better than one that hands over the wrong species. History: 1 = id and
 * capture rate only, 2 = with `is_legendary`/`is_mythical`, 3 = with every form of each line.
 */
const INDEX_SCHEMA = 3
// 8 s, not the previous 15: PokéAPI answers in well under a second when healthy, and the
// timeout is what bounds how long a sick network can hold `update()` — and with it the scan.
const REQUEST_TIMEOUT_MS = 8_000
/** Below this, a REST-built index is too thin to persist; retry next session instead. */
const MIN_REST_INDEX_SIZE = 150

interface SpeciesDTO {
  capture_rate: number
  is_legendary: boolean
  is_mythical: boolean
  evolution_chain?: { url?: string }
  evolves_from_species?: unknown
  names?: { name: string; language: { name: string } }[]
  base_happiness?: number | null
}

/**
 * The slice of `/pokemon/{id}` an encounter reads: the stats for its temperament, the types for
 * its terrain. The rest — the whole learnset — is ignored.
 */
interface PokemonDTO {
  stats?: { base_stat: number; stat: { name: string } }[]
  types?: { slot: number; type: { name: string } }[]
}

/** What an encounter keeps from `/pokemon/{id}`. */
interface PokemonDetails {
  stats?: BaseStats
  types?: PokemonType[]
}

/** Primary first, by slot. A type this build does not know is dropped rather than guessed. */
function typesFrom(dto: PokemonDTO): PokemonType[] | undefined {
  const sorted = [...(dto.types ?? [])].sort((a, b) => a.slot - b.slot)
  return pokemonTypes(sorted.map((entry) => entry.type?.name))
}

const STAT_KEYS: Record<string, keyof BaseStats> = {
  hp: 'hp',
  attack: 'attack',
  defense: 'defense',
  'special-attack': 'specialAttack',
  'special-defense': 'specialDefense',
  speed: 'speed',
}

/** All six stats, or nothing: a partial reading would quietly skew the temperament. */
function baseStatsFrom(dto: PokemonDTO): BaseStats | undefined {
  const stats: Partial<BaseStats> = {}
  for (const entry of dto.stats ?? []) {
    const key = STAT_KEYS[entry.stat.name]
    if (key !== undefined && Number.isFinite(entry.base_stat)) stats[key] = entry.base_stat
  }
  return Object.keys(STAT_KEYS).every((name) => stats[STAT_KEYS[name]!] !== undefined)
    ? (stats as BaseStats)
    : undefined
}

interface ChainLinkDTO {
  species: { url: string }
  evolves_to: ChainLinkDTO[]
}

/**
 * The base-stats request's own deadline, well under `REQUEST_TIMEOUT_MS`. The stats only shape a
 * temperament that has a neutral fallback, and the species data they wait beside is usually
 * already cached — a slow `/pokemon` must not hold the spawn for the full request timeout.
 */
const STATS_TIMEOUT_MS = 2_500

async function getJSON<T>(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return (await response.json()) as T
}

/** The species' names, narrowed to the languages the app can display. */
function namesByLanguage(dto: SpeciesDTO): Record<string, string> {
  const byLang: Record<string, string> = {}
  for (const entry of dto.names ?? []) {
    if (LANG_CODES.includes(entry.language.name)) byLang[entry.language.name] = entry.name
  }
  return byLang
}

/** Species id from a PokéAPI resource URL (".../pokemon-species/25/"). */
function speciesIDFromURL(url: string): number {
  const match = /\/(\d+)\/?$/.exec(url)
  return match === null ? 0 : Number(match[1])
}

/**
 * PokéAPI's own URLs are validated rather than trusted: a malformed or empty value throws so
 * the app simply keeps the egg, instead of crashing on a force-unwrap.
 */
function validatedChainURL(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export class PokeAPIClient implements PokeProviding {
  private speciesCache = new Map<number, SpeciesDTO>()
  /** Only the six numbers are kept: the full `/pokemon` response carries the whole learnset. */
  private detailsCache = new Map<number, PokemonDetails>()
  /** Prefetching populates this so hatching costs no network at all. */
  private lineCache = new Map<number, EvoLine>()
  private baseIndexCache: BaseSpecies[] | undefined
  /**
   * Coalesces concurrent index loads. Two callers can want it in the same pass (an encounter
   * spawn and an egg pre-roll), and without this they each pay the full GraphQL round trip.
   *
   * Cleared when it settles rather than memoised: caching a *rejection* would turn one dropped
   * request into "no index" for the rest of the session.
   */
  private indexInFlight: Promise<BaseSpecies[]> | undefined
  private restBuildTried = false

  constructor(
    private readonly indexFilePath = join(AppPaths.ourData(), 'base-index.json'),
    private readonly options: { statsTimeoutMs?: number } = {},
  ) {}

  // MARK: - Lines

  async line(baseSpeciesID: number): Promise<EvoLine> {
    const cached = this.lineCache.get(baseSpeciesID)
    if (cached !== undefined) return cached

    const base = await this.species(baseSpeciesID)
    const chainURL = validatedChainURL(base.evolution_chain?.url)
    if (chainURL === undefined) throw new Error(`species ${baseSpeciesID}: bad evolution_chain url`)

    const chain = await getJSON<{ chain: ChainLinkDTO }>(chainURL)
    const tree = nodeFrom(chain.chain)
    // Asked by a form that is not the chain's root (a wild Charmeleon, chosen as companion): the
    // line is the root's — its base and its rarity — never one priced by the evolved form.
    if (tree.speciesID !== baseSpeciesID) {
      const rooted = await this.line(tree.speciesID)
      this.lineCache.set(baseSpeciesID, rooted)
      return rooted
    }
    const rarity = rarityFrom(base.capture_rate, base.is_legendary, base.is_mythical)

    // Names for every species in the line, restricted to the languages the app supports.
    // Fetched in parallel: the ids are distinct (a chain never repeats a species), so this
    // costs one round-trip instead of one per form.
    const names: Record<number, Record<string, string>> = {}
    const ids = allIDs(tree)
    const dtos = await Promise.all(ids.map((id) => this.species(id)))
    for (const [index, dto] of dtos.entries()) {
      names[ids[index]!] = namesByLanguage(dto)
    }

    const line = makeEvoLine(baseSpeciesID, tree, rarity, names)
    this.lineCache.set(baseSpeciesID, line)
    return line
  }

  /**
   * One request, and usually zero: `species()` memoises, and a wild species is very often one
   * the index or a previous encounter already pulled.
   */
  async wildSpecies(id: number): Promise<WildSpecies> {
    // In parallel, and the stats may fail on their own: they shape the temperament, which has a
    // neutral fallback, so a slow or missing `/pokemon` response must never throw here — throwing
    // would defer the encounter and count against the network backoff.
    const [dto, details] = await Promise.all([this.species(id), this.pokemonDetails(id)])
    const wild: WildSpecies = {
      id,
      captureRate: dto.capture_rate,
      rarity: rarityFrom(dto.capture_rate, dto.is_legendary, dto.is_mythical),
      names: namesByLanguage(dto),
    }
    if (typeof dto.base_happiness === 'number') wild.baseHappiness = dto.base_happiness
    if (details.stats !== undefined) wild.stats = details.stats
    if (details.types !== undefined) wild.types = details.types
    return wild
  }

  /**
   * Base stats and types for the default form. For the gen 1–5 species the game draws from, the
   * default variety's id is the species id. A failure is not cached, so the next spawn of that
   * species tries again.
   */
  private async pokemonDetails(id: number): Promise<PokemonDetails> {
    const cached = this.detailsCache.get(id)
    if (cached !== undefined) return cached
    try {
      const dto = await getJSON<PokemonDTO>(
        `${REST_BASE}/pokemon/${id}`,
        this.options.statsTimeoutMs ?? STATS_TIMEOUT_MS,
      )
      const details: PokemonDetails = {}
      const stats = baseStatsFrom(dto)
      if (stats !== undefined) details.stats = stats
      const types = typesFrom(dto)
      if (types !== undefined) details.types = types
      if (stats !== undefined) this.detailsCache.set(id, details)
      return details
    } catch {
      return {}
    }
  }

  private async species(id: number): Promise<SpeciesDTO> {
    const cached = this.speciesCache.get(id)
    if (cached !== undefined) return cached
    const dto = await getJSON<SpeciesDTO>(`${REST_BASE}/pokemon-species/${id}`)
    this.speciesCache.set(id, dto)
    return dto
  }

  // MARK: - Base index

  /**
   * Priority: memory -> disk (30-day TTL) -> GraphQL (refreshing disk on success) -> a stale
   * disk copy if there is one (offline). Only when all of that fails does it throw, leaving
   * the egg intact so the next tick retries.
   */
  async baseSpeciesIndex(): Promise<BaseSpecies[]> {
    if (this.baseIndexCache !== undefined) return this.baseIndexCache
    this.indexInFlight ??= this.loadBaseIndex().finally(() => {
      this.indexInFlight = undefined
    })
    return this.indexInFlight
  }

  private async loadBaseIndex(): Promise<BaseSpecies[]> {
    const disk = await this.readDiskIndex()
    if (
      disk !== undefined &&
      disk.version === INDEX_SCHEMA &&
      Date.now() - disk.fetchedAt < INDEX_TTL_MS &&
      disk.entries.length > 0
    ) {
      this.baseIndexCache = disk.entries
      return disk.entries
    }

    try {
      const entries = await this.fetchBaseIndex()
      this.baseIndexCache = entries
      await this.writeDiskIndex(entries)
      return entries
    } catch (error) {
      if (disk !== undefined && disk.entries.length > 0) {
        this.baseIndexCache = disk.entries // offline: a stale index beats no index
        return disk.entries
      }
      // GraphQL down with no cache: build an index over REST in the background, once per
      // session. This hatch is handled by the per-hatch REST fallback; once the build lands,
      // selection returns to weighted, collection-aware and offline-capable.
      if (!this.restBuildTried) {
        this.restBuildTried = true
        void this.buildBaseIndexViaREST()
      }
      throw error
    }
  }

  private async fetchBaseIndex(): Promise<BaseSpecies[]> {
    // Official GraphQL: evolves_from IS NULL (a base) and id <= 649, the gen-V animated
    // sprite ceiling. Ditto (#132) is excluded — it exists only for the disguise reveal. The
    // second selection, in the same request, is every other form, for wild encounters.
    const query = `{ bases: pokemonspecies(where: {evolves_from_species_id: {_is_null: true}, id: {_lte: ${ANIMATED_SPECIES_MAX}, _neq: ${PokemonOdds.dittoSpeciesID}}}, order_by: {id: asc}) { id capture_rate is_legendary is_mythical } forms: pokemonspecies(where: {evolves_from_species_id: {_is_null: false}, id: {_lte: ${ANIMATED_SPECIES_MAX}}}, order_by: {id: asc}) { id capture_rate evolves_from_species_id } }`
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`graphql: HTTP ${response.status}`)
    const decoded = (await response.json()) as {
      data?: {
        bases?: {
          id: number
          capture_rate: number
          is_legendary?: boolean
          is_mythical?: boolean
        }[]
        forms?: { id: number; capture_rate: number; evolves_from_species_id: number }[]
      }
    }
    const rows = decoded.data?.bases ?? []
    if (rows.length === 0) throw new Error('graphql: empty base index')
    return attachForms(
      rows.map((r) => ({
        id: r.id,
        captureRate: r.capture_rate,
        isLegendary: r.is_legendary === true,
        isMythical: r.is_mythical === true,
      })),
      (decoded.data?.forms ?? []).map((f) => ({
        id: f.id,
        captureRate: f.capture_rate,
        from: f.evolves_from_species_id,
      })),
    )
  }

  /**
   * REST fallback that rebuilds and persists the index when the GraphQL endpoint is down, so
   * hatching is never permanently tied to one endpoint's survival. Small concurrency out of
   * courtesy to PokéAPI.
   */
  async buildBaseIndexViaREST(): Promise<void> {
    if (this.baseIndexCache !== undefined) return
    const bases: BaseSpecies[] = []
    const batchSize = 6
    for (let start = 1; start <= ANIMATED_SPECIES_MAX; start += batchSize) {
      const end = Math.min(start + batchSize - 1, ANIMATED_SPECIES_MAX)
      const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i)
      const found = await Promise.all(ids.map((id) => this.baseSpecies(id).catch(() => undefined)))
      for (const b of found) if (b !== undefined) bases.push(b)
    }
    // Mostly-failed (flaky network) builds are not persisted; retry next session instead.
    if (bases.length < MIN_REST_INDEX_SIZE) return
    bases.sort((a, b) => a.id - b.id)
    this.baseIndexCache = bases
    // No forms over REST, so it is written under the schema before forms: it still stands in
    // offline, and the next load with GraphQL up replaces it instead of it passing for current.
    await this.writeDiskIndex(bases, INDEX_SCHEMA - 1)
  }

  /** Single-species REST check: is this a line start, and what is its capture rate. */
  async baseSpecies(id: number): Promise<BaseSpecies | undefined> {
    if (id === PokemonOdds.dittoSpeciesID) return undefined // reveal-only, never hatched
    const dto = await this.species(id)
    if (dto.evolves_from_species !== null && dto.evolves_from_species !== undefined) return undefined
    // The flags travel with the REST path too, so the fallback index is not a second-class one
    // that silently cannot express a legendary.
    return {
      id,
      captureRate: dto.capture_rate,
      isLegendary: dto.is_legendary,
      isMythical: dto.is_mythical,
    }
  }

  private async readDiskIndex(): Promise<
    { version: number; fetchedAt: number; entries: BaseSpecies[] } | undefined
  > {
    try {
      const raw = await fs.readFile(this.indexFilePath, 'utf8')
      const parsed = JSON.parse(raw) as {
        version?: number
        fetchedAt?: number
        entries?: BaseSpecies[]
      }
      if (!Array.isArray(parsed.entries)) return undefined
      // A file with no version is the original shape, which predates the legendary flags.
      return { version: parsed.version ?? 1, fetchedAt: parsed.fetchedAt ?? 0, entries: parsed.entries }
    } catch {
      return undefined
    }
  }

  private async writeDiskIndex(entries: BaseSpecies[], version = INDEX_SCHEMA): Promise<void> {
    try {
      // Temp-then-rename, per writer: a torn index reads back as `undefined` and the client
      // rebuilds it over REST — hundreds of requests across the whole species range.
      await atomicWriteFile(
        this.indexFilePath,
        JSON.stringify({ version, fetchedAt: Date.now(), entries }),
      )
    } catch {
      // A cache write failure must never break hatching.
    }
  }
}

// MARK: - Chain parsing

function nodeFrom(link: ChainLinkDTO): EvoNode {
  return {
    speciesID: speciesIDFromURL(link.species.url),
    children: (link.evolves_to ?? []).map(nodeFrom),
  }
}

function allIDs(node: EvoNode): number[] {
  return [node.speciesID, ...node.children.flatMap(allIDs)]
}

// MARK: - The forms of each line

/**
 * Gives each base its line's other forms, walking `from` links down from it: each form's stage
 * (its depth) and the forms on the longest road through it, which prices its registration. A
 * form whose parent is not reachable from a base is dropped — it has no line to belong to.
 */
export function attachForms(
  bases: BaseSpecies[],
  evolved: { id: number; captureRate: number; from: number }[],
): BaseSpecies[] {
  const children = new Map<number, { id: number; captureRate: number }[]>()
  for (const f of evolved) {
    const list = children.get(f.from) ?? []
    list.push(f)
    children.set(f.from, list)
  }
  // Longest road from a node to a leaf, the node included. Guarded against a cyclic `from`.
  const below = (id: number, seen: Set<number>): number => {
    if (seen.has(id)) return 1
    const next = new Set(seen).add(id)
    return 1 + Math.max(0, ...(children.get(id) ?? []).map((c) => below(c.id, next)))
  }
  return bases.map((base) => {
    const forms: WildForm[] = []
    const walk = (id: number, stage: number, seen: Set<number>) => {
      for (const child of children.get(id) ?? []) {
        if (seen.has(child.id)) continue
        const next = new Set(seen).add(child.id)
        forms.push({
          id: child.id,
          stage,
          captureRate: child.captureRate,
          totalForms: stage + below(child.id, seen),
        })
        walk(child.id, stage + 1, next)
      }
    }
    walk(base.id, 1, new Set([base.id]))
    forms.sort((a, b) => a.stage - b.stage || a.id - b.id)
    return { ...base, forms, lineForms: below(base.id, new Set()) }
  })
}

// MARK: - Wild selection

/** What the player has of a species, as the wild draw weighs it. */
export type WildStatus = 'missing' | 'owned' | 'registered'

const WILD_STATUS_WEIGHT: Record<WildStatus, number> = { missing: 4, owned: 2, registered: 1 }

/** The games' odds of meeting each stage, by the number of forms in the line (percent). */
const WILD_STAGE_ODDS: Record<number, number[]> = { 1: [100], 2: [75, 25], 3: [65, 30, 5] }

/**
 * A line's weight in the wild draw: its capture rate, ×4 while any form is missing, ×2 while
 * any is owned but unregistered, ×1 once all are registered.
 */
export function wildLineWeight(base: BaseSpecies, status: (id: number) => WildStatus): number {
  const ids = [base.id, ...(base.forms ?? []).map((f) => f.id)]
  const statuses = ids.map(status)
  const factor = statuses.includes('missing') ? 4 : statuses.includes('owned') ? 2 : 1
  return Math.max(1, base.captureRate * factor)
}

/**
 * A wild pick: the species met, and where it sits in its line (which prices registering it).
 * `line` is absent when the index cannot say — one without forms knows no line length, and a
 * made-up one would price the registration wrongly; the catch then owes its share instead.
 */
export interface WildPick {
  speciesID: number
  line?: { baseID: number; stageIndex: number; totalForms: number; rarity: Rarity }
}

/**
 * The wild draw: a line (`wildLineWeight`), a stage by the games' odds (`WILD_STAGE_ODDS`), and
 * among branches at that stage the form the player has least of. Three draws, in that order.
 * An index without forms (REST-built, or an older schema) meets bases only.
 *
 * `tier` is a floor, passed only for a granted legendary: it narrows the pool as
 * `meetsRarityFloor` does for an egg (an empty pool returns undefined, never something else) and
 * meets the base — the one pick builder for ordinary and granted encounters alike.
 */
export function chooseWildFromIndex(
  index: BaseSpecies[],
  status: (id: number) => WildStatus,
  rng: RNG,
  tier?: Rarity,
): WildPick | undefined {
  const pool =
    tier === undefined
      ? index
      : index.filter((e) => meetsRarityFloor(tier, e.captureRate, e.isLegendary, e.isMythical))
  if (pool.length === 0) return undefined
  const base = weightedPick(pool, (e) => wildLineWeight(e, status), rng)
  const rarity = rarityFrom(base.captureRate, base.isLegendary === true, base.isMythical === true)
  const atBase = (): WildPick =>
    base.lineForms === undefined
      ? { speciesID: base.id }
      : {
          speciesID: base.id,
          line: { baseID: base.id, stageIndex: 0, totalForms: base.lineForms, rarity },
        }
  if (tier !== undefined || base.lineForms === undefined) return atBase()

  const odds = WILD_STAGE_ODDS[Math.min(Math.max(1, base.lineForms), 3)] ?? [100]
  let roll = rng() % 100
  let stage = 0
  for (; stage < odds.length - 1; stage++) {
    roll -= odds[stage]!
    if (roll < 0) break
  }
  const atStage = (base.forms ?? []).filter((f) => f.stage === stage)
  if (stage === 0 || atStage.length === 0) return atBase()
  const form = weightedPick(atStage, (f) => WILD_STATUS_WEIGHT[status(f.id)], rng)
  return {
    speciesID: form.id,
    line: { baseID: base.id, stageIndex: form.stage, totalForms: form.totalForms, rarity },
  }
}

/** One weighted draw: `rng() % total`, walked in order. `items` must not be empty. */
function weightedPick<T>(items: T[], weight: (item: T) => number, rng: RNG): T {
  const weights = items.map(weight)
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() % total
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!
    if (r < 0) return items[i]!
  }
  return items[items.length - 1]!
}

// MARK: - Hatch candidate selection

export type RNG = () => number

/**
 * Weighted pick from the index. A species whose line is already collected weighs half, so
 * repeats thin out without ever becoming impossible.
 *
 * A guarantee narrows the pool first, through `meetsRarityFloor`: "rare or better" still
 * contains legendary, and `'legendary'` itself now means exactly the flagged species instead
 * of the empty set it used to mean. If narrowing empties the pool the guarantee cannot be
 * honoured, so it returns undefined and the caller keeps the egg — or, for a guaranteed
 * legendary encounter, keeps the reward owed. Falling back to the full pool would silently
 * hand over something other than what was earned.
 */
export function chooseBaseFromIndex(
  index: BaseSpecies[],
  tier: Rarity | undefined,
  unlocked: ReadonlySet<number>,
  rng: RNG,
): number | undefined {
  const pool =
    tier === undefined
      ? index
      : index.filter((e) => meetsRarityFloor(tier, e.captureRate, e.isLegendary, e.isMythical))
  if (pool.length === 0) return undefined

  return weightedPick(
    pool,
    (e) => Math.max(1, unlocked.has(e.id) ? Math.floor(e.captureRate / 2) : e.captureRate),
    rng,
  ).id
}

/**
 * REST rejection sampling used when the GraphQL index is unavailable, so hatching still works.
 *
 * Weighting is skipped — rarity is computed from the real capture_rate after hatching, so the
 * resulting Pokémon's tier is still correct. The guarantee, however, is enforced with the
 * **same** rule as the weighted path: leaving it out here would silently break the guarantee
 * exactly when the index is down.
 */
export async function chooseBaseViaREST(
  provider: Pick<PokeProviding, 'baseSpecies'>,
  tier: Rarity | undefined,
  rng: RNG,
  attempts = 16,
): Promise<number | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const id = (rng() % ANIMATED_SPECIES_MAX) + 1
    let candidate: BaseSpecies | undefined
    try {
      candidate = await provider.baseSpecies(id)
    } catch {
      return undefined // network down too: keep the egg, retry next tick
    }
    if (candidate === undefined) continue // not a line start
    if (
      tier !== undefined &&
      !meetsRarityFloor(tier, candidate.captureRate, candidate.isLegendary, candidate.isMythical)
    ) {
      continue
    }
    return id
  }
  return undefined
}
