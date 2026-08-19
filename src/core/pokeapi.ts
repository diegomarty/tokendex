/**
 * PokéAPI client.
 *
 * Pokémon data is fetched at runtime and never bundled in the repository — that is a licence
 * obligation, not a size optimisation.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as AppPaths from './appPaths.js'
import {
  ANIMATED_SPECIES_MAX,
  type EvoLine,
  type EvoNode,
  PokemonOdds,
  type Rarity,
  makeEvoLine,
  rarityFrom,
  rarityIncludes,
} from './companion/model.js'

/** A hatch candidate: the start of an evolution line, plus its official rarity signal. */
export interface BaseSpecies {
  id: number
  /** 3 (Mewtwo-class) to 255 (Caterpie-class). */
  captureRate: number
}

/** Injectable so tests use a stub rather than the network. */
export interface PokeProviding {
  line(baseSpeciesID: number): Promise<EvoLine>
  /** Every gen 1-5 base, one GraphQL query, cached on disk. */
  baseSpeciesIndex(): Promise<BaseSpecies[]>
  /** A single species, or undefined when it is not a line start. */
  baseSpecies(id: number): Promise<BaseSpecies | undefined>
}

const REST_BASE = 'https://pokeapi.co/api/v2'
const GRAPHQL_URL = 'https://graphql.pokeapi.co/v1beta2'
const LANG_CODES = ['ko', 'en', 'ja-Hrkt', 'ja', 'es']
const INDEX_TTL_MS = 30 * 86_400_000
const REQUEST_TIMEOUT_MS = 15_000
/** Below this, a REST-built index is too thin to persist; retry next session instead. */
const MIN_REST_INDEX_SIZE = 150

interface SpeciesDTO {
  capture_rate: number
  is_legendary: boolean
  is_mythical: boolean
  evolution_chain?: { url?: string }
  evolves_from_species?: unknown
  names?: { name: string; language: { name: string } }[]
}

interface ChainLinkDTO {
  species: { url: string }
  evolves_to: ChainLinkDTO[]
}

async function getJSON<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return (await response.json()) as T
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
  /** Prefetching populates this so hatching costs no network at all. */
  private lineCache = new Map<number, EvoLine>()
  private baseIndexCache: BaseSpecies[] | undefined
  private restBuildTried = false

  constructor(private readonly indexFilePath = join(AppPaths.ourData(), 'base-index.json')) {}

  // MARK: - Lines

  async line(baseSpeciesID: number): Promise<EvoLine> {
    const cached = this.lineCache.get(baseSpeciesID)
    if (cached !== undefined) return cached

    const base = await this.species(baseSpeciesID)
    const chainURL = validatedChainURL(base.evolution_chain?.url)
    if (chainURL === undefined) throw new Error(`species ${baseSpeciesID}: bad evolution_chain url`)

    const chain = await getJSON<{ chain: ChainLinkDTO }>(chainURL)
    const tree = nodeFrom(chain.chain)
    const rarity = rarityFrom(base.capture_rate, base.is_legendary, base.is_mythical)

    // Names for every species in the line, restricted to the languages the app supports.
    const names: Record<number, Record<string, string>> = {}
    for (const id of allIDs(tree)) {
      const dto = await this.species(id)
      const byLang: Record<string, string> = {}
      for (const entry of dto.names ?? []) {
        if (LANG_CODES.includes(entry.language.name)) byLang[entry.language.name] = entry.name
      }
      names[id] = byLang
    }

    const line = makeEvoLine(baseSpeciesID, tree, rarity, names)
    this.lineCache.set(baseSpeciesID, line)
    return line
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

    const disk = await this.readDiskIndex()
    if (disk !== undefined && Date.now() - disk.fetchedAt < INDEX_TTL_MS && disk.entries.length > 0) {
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
    // sprite ceiling. Ditto (#132) is excluded — it exists only for the disguise reveal.
    const query = `{ pokemonspecies(where: {evolves_from_species_id: {_is_null: true}, id: {_lte: ${ANIMATED_SPECIES_MAX}, _neq: ${PokemonOdds.dittoSpeciesID}}}, order_by: {id: asc}) { id capture_rate } }`
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`graphql: HTTP ${response.status}`)
    const decoded = (await response.json()) as {
      data?: { pokemonspecies?: { id: number; capture_rate: number }[] }
    }
    const rows = decoded.data?.pokemonspecies ?? []
    if (rows.length === 0) throw new Error('graphql: empty base index')
    return rows.map((r) => ({ id: r.id, captureRate: r.capture_rate }))
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
    await this.writeDiskIndex(bases)
  }

  /** Single-species REST check: is this a line start, and what is its capture rate. */
  async baseSpecies(id: number): Promise<BaseSpecies | undefined> {
    if (id === PokemonOdds.dittoSpeciesID) return undefined // reveal-only, never hatched
    const dto = await this.species(id)
    if (dto.evolves_from_species !== null && dto.evolves_from_species !== undefined) return undefined
    return { id, captureRate: dto.capture_rate }
  }

  private async readDiskIndex(): Promise<{ fetchedAt: number; entries: BaseSpecies[] } | undefined> {
    try {
      const raw = await fs.readFile(this.indexFilePath, 'utf8')
      const parsed = JSON.parse(raw) as { fetchedAt?: number; entries?: BaseSpecies[] }
      if (!Array.isArray(parsed.entries)) return undefined
      return { fetchedAt: parsed.fetchedAt ?? 0, entries: parsed.entries }
    } catch {
      return undefined
    }
  }

  private async writeDiskIndex(entries: BaseSpecies[]): Promise<void> {
    try {
      await fs.mkdir(join(this.indexFilePath, '..'), { recursive: true })
      await fs.writeFile(this.indexFilePath, JSON.stringify({ fetchedAt: Date.now(), entries }))
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

// MARK: - Hatch candidate selection

export type RNG = () => number

/**
 * Weighted pick from the index. A species whose line is already collected weighs half, so
 * repeats thin out without ever becoming impossible.
 *
 * A guaranteed egg narrows the pool first: the capture-rate ceiling *is* the rarity floor, so
 * legendaries are naturally included ("rare or better" containing legendary is correct). If
 * narrowing empties the pool the guarantee cannot be honoured, so it returns undefined and
 * the egg is kept — falling back to the full pool would silently break what was paid for.
 */
export function chooseBaseFromIndex(
  index: BaseSpecies[],
  tier: Rarity | undefined,
  collectedFinals: ReadonlySet<string>,
  rng: RNG,
): number | undefined {
  const pool = tier === undefined ? index : index.filter((e) => rarityIncludes(tier, e.captureRate))
  if (pool.length === 0) return undefined

  const weights = pool.map((e) => {
    const seen = [...collectedFinals].some((k) => k.startsWith(`${e.id}:`))
    return Math.max(1, seen ? Math.floor(e.captureRate / 2) : e.captureRate)
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() % total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!
    if (r < 0) return pool[i]!.id
  }
  return pool[pool.length - 1]?.id // unreachable, kept as a guard
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
    if (tier !== undefined && !rarityIncludes(tier, candidate.captureRate)) continue
    return id
  }
  return undefined
}
