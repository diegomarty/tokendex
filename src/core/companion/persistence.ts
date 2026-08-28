/**
 * Lenient decoding of the persisted companion state.
 *
 * The governing rule is **partial recovery beats a full reset**: a missing key, a `null`, or
 * a type mismatch in one field must not wipe a Pokédex someone spent months filling. Only a
 * top-level shape that is not an object is fatal, and the caller then backs the file up and
 * starts fresh.
 */

import {
  APP_LANGUAGES,
  COMPANION_STATE_SCHEMA,
  type AppLanguage,
  type CompanionState,
  type DexEntry,
  type MonState,
  NATURES,
  type PokemonNature,
  RARITIES,
  type Rarity,
  type WildEncounter,
  freshCompanionState,
} from './model.js'
import { EncounterBalance } from './encounters.js'

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Absorbs missing key, null and type mismatch into the default. */
function lenient<T>(json: Json, key: string, guard: (v: unknown) => v is T, def: T): T {
  const v = json[key]
  return guard(v) ? v : def
}

function lenientOptional<T>(json: Json, key: string, guard: (v: unknown) => v is T): T | undefined {
  const v = json[key]
  return guard(v) ? v : undefined
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => isNumber(v) && Number.isInteger(v)
const isString = (v: unknown): v is string => typeof v === 'string'

const isRarity = (v: unknown): v is Rarity => isString(v) && (RARITIES as readonly string[]).includes(v)
const isNature = (v: unknown): v is PokemonNature =>
  isString(v) && (NATURES as readonly string[]).includes(v)
const isLanguage = (v: unknown): v is AppLanguage =>
  isString(v) && (APP_LANGUAGES as readonly string[]).includes(v)

const isIntArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)

function isNumberRecord(v: unknown): v is Record<string, number> {
  return isObject(v) && Object.values(v).every(isInt)
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isObject(v) && Object.values(v).every(isString)
}

function isNameMap(v: unknown): v is Record<number, Record<string, string>> {
  if (!isObject(v)) return false
  return Object.values(v).every((entry) => isObject(entry) && Object.values(entry).every(isString))
}

/**
 * Decodes a Pokémon.
 *
 * Empty `pathIDs` is treated as corruption and rejected, so the whole state falls back to an
 * egg rather than rendering an out-of-bounds species on every frame. `stageIndex` is clamped
 * into the path's real bounds for the same reason.
 */
export function decodeMonState(value: unknown): MonState | undefined {
  if (!isObject(value)) return undefined
  const baseID = lenientOptional(value, 'baseID', isInt)
  const pathIDs = lenientOptional(value, 'pathIDs', isIntArray)
  if (baseID === undefined || pathIDs === undefined || pathIDs.length === 0) return undefined

  const rarity = lenientOptional(value, 'rarity', isRarity)
  const totalForms = lenientOptional(value, 'totalForms', isInt)
  if (rarity === undefined || totalForms === undefined) return undefined

  const savedPlan = lenientOptional(value, 'plannedPathIDs', isIntArray)
  const mon: MonState = {
    baseID,
    pathIDs,
    plannedPathIDs: savedPlan !== undefined && savedPlan.length > 0 ? savedPlan : pathIDs,
    stageIndex: Math.min(Math.max(0, lenient(value, 'stageIndex', isInt, 0)), pathIDs.length - 1),
    usedAtStage: lenient(value, 'usedAtStage', isInt, 0),
    rarity,
    totalForms,
    // Absent in older saves.
    isShiny: lenient(value, 'isShiny', isBool, false),
    dittoRevealed: lenient(value, 'dittoRevealed', isBool, false),
  }
  const nature = lenientOptional(value, 'nature', isNature)
  if (nature !== undefined) mon.nature = nature
  const disguise = lenientOptional(value, 'dittoDisguise', isInt)
  if (disguise !== undefined) mon.dittoDisguise = disguise
  return mon
}

export function decodeDexEntry(value: unknown): DexEntry | undefined {
  if (!isObject(value)) return undefined
  const baseID = lenientOptional(value, 'baseID', isInt)
  const finalID = lenientOptional(value, 'finalID', isInt)
  const chainOrder = lenientOptional(value, 'chainOrder', isIntArray)
  const rarity = lenientOptional(value, 'rarity', isRarity)
  if (baseID === undefined || finalID === undefined || chainOrder === undefined || rarity === undefined) {
    return undefined
  }

  const entry: DexEntry = {
    id: lenient(value, 'id', isString, `${baseID}-${finalID}-${chainOrder.join('.')}`),
    baseID,
    finalID,
    chainOrder,
    rarity,
    isShiny: lenient(value, 'isShiny', isBool, false),
  }
  const caughtAt = value['caughtAt']
  if (isNumber(caughtAt)) entry.caughtAt = caughtAt
  else if (isString(caughtAt)) {
    const parsed = Date.parse(caughtAt)
    if (!Number.isNaN(parsed)) entry.caughtAt = parsed
  }
  const nature = lenientOptional(value, 'nature', isNature)
  if (nature !== undefined) entry.nature = nature
  // Degraded to absent rather than failing the entry: an older format stored a single
  // name map for the final species only. The view backfills from a line lookup.
  const names = lenientOptional(value, 'names', isNameMap)
  if (names !== undefined) entry.names = names
  // Only 'wild' is a value; anything else degrades to absent, which reads as "raised" — the
  // original meaning, so a save written before encounters existed needs no migration.
  if (value['source'] === 'wild') entry.source = 'wild'
  return entry
}

/**
 * One queued wild encounter. Anything missing an identity, a species or a capture rate is
 * dropped rather than defaulted: a made-up capture rate would silently change the catch odds,
 * which is worse than losing one encounter the player has not seen yet.
 */
export function decodeWildEncounter(value: unknown): WildEncounter | undefined {
  if (!isObject(value)) return undefined
  const id = lenientOptional(value, 'id', isString)
  const speciesID = lenientOptional(value, 'speciesID', isInt)
  const captureRate = lenientOptional(value, 'captureRate', isInt)
  const rarity = lenientOptional(value, 'rarity', isRarity)
  if (id === undefined || speciesID === undefined || captureRate === undefined || rarity === undefined) {
    return undefined
  }

  const encounter: WildEncounter = {
    id,
    speciesID,
    captureRate,
    rarity,
    isShiny: lenient(value, 'isShiny', isBool, false),
    appearedAt: lenient(value, 'appearedAt', isNumber, 0),
    // Defaults to zero, the *player-favourable* direction: a corrupt count must not arrive as
    // "already thrown at four times" and hand them a near-certain flee.
    throws: Math.max(0, lenient(value, 'throws', isInt, 0)),
  }
  const names = lenientOptional(value, 'names', isStringRecord)
  if (names !== undefined) encounter.names = names
  return encounter
}

/**
 * Decodes the whole state. Throws only when the payload is not a JSON object at all — the
 * caller backs that file up and starts fresh.
 */
export function decodeCompanionState(value: unknown, hostLanguage?: string): CompanionState {
  if (!isObject(value)) throw new TypeError('companion state is not an object')
  const fresh = freshCompanionState(hostLanguage)

  const state: CompanionState = {
    // Normalised to the current schema on the way in: decoding IS the migration point, so a
    // state that leaves here is always current-shape. A future breaking change reads the raw
    // value first and branches before this normalisation.
    saveSchema: COMPANION_STATE_SCHEMA,
    installBaselineSet: lenient(value, 'installBaselineSet', isBool, false),
    usedSinceInstall: lenient(value, 'usedSinceInstall', isInt, 0),
    spentTokens: lenient(value, 'spentTokens', isInt, 0),
    eggUsage: lenient(value, 'eggUsage', isInt, 0),
    lastDate: lenient(value, 'lastDate', isString, ''),
    // Per-item isolation: one corrupt entry must not take the whole Pokédex with it.
    dex: (Array.isArray(value['dex']) ? value['dex'] : [])
      .map(decodeDexEntry)
      .filter((e): e is DexEntry => e !== undefined),
    collectedFinals: lenient(value, 'collectedFinals', isStringArray, []),
    language: lenient(value, 'language', isLanguage, fresh.language),
    inventory: lenient(value, 'inventory', isNumberRecord, {}),
    candyGrantTier: lenient(value, 'candyGrantTier', isNumberRecord, {}),
    candyFeatureSeeded: lenient(value, 'candyFeatureSeeded', isBool, false),
    encounterUsage: Math.max(0, lenient(value, 'encounterUsage', isInt, 0)),
    // Per-item isolation, as with the Pokédex: one corrupt encounter must not empty the queue.
    wild: (Array.isArray(value['wild']) ? value['wild'] : [])
      .map(decodeWildEncounter)
      .filter((e): e is WildEncounter => e !== undefined)
      .slice(0, EncounterBalance.maxQueue),
    // A save predating encounters decodes to 0, so its owner gets the cheap first encounter
    // too — the alternative is punishing existing players for having installed early.
    encountersSeen: Math.max(0, lenient(value, 'encountersSeen', isInt, 0)),
  }

  // An unknown rawValue degrades to "no guarantee" — the safe direction, since inventing a
  // guarantee the user never bought is worse than losing one.
  const eggTier = lenientOptional(value, 'eggTier', isRarity)
  if (eggTier !== undefined) state.eggTier = eggTier
  const pendingHatchID = lenientOptional(value, 'pendingHatchID', isInt)
  if (pendingHatchID !== undefined) state.pendingHatchID = pendingHatchID

  // Not validated against the roster here: this module knows nothing about which sprites exist,
  // and an unknown slug already falls back to the default at render time. `sanitized()` is where
  // an imported save gets its slug checked.
  const trainerID = lenientOptional(value, 'trainerID', isString)
  if (trainerID !== undefined) state.trainerID = trainerID
  const lastEncounterToastAt = lenientOptional(value, 'lastEncounterToastAt', isNumber)
  if (lastEncounterToastAt !== undefined) state.lastEncounterToastAt = lastEncounterToastAt

  // Corrupt active (empty pathIDs and friends) falls back to an egg while the Pokédex and
  // inventory survive.
  const active = decodeMonState(value['active'])
  if (active !== undefined) state.active = active

  // Key present (even as an empty map) means "already seeded". Key absent means an older
  // save whose aggregate value cannot be split per provider: it is deliberately NOT read,
  // and the next update seeds a baseline from the current snapshot without back-paying.
  if (Object.hasOwn(value, 'claimedTodayTokensByProvider')) {
    state.claimedTodayTokensByProvider = lenient(
      value,
      'claimedTodayTokensByProvider',
      isNumberRecord,
      {},
    )
  }

  return state
}

/** Parses raw JSON text, returning `undefined` when it is unusable. */
export function parseCompanionState(text: string, hostLanguage?: string): CompanionState | undefined {
  try {
    return decodeCompanionState(JSON.parse(text), hostLanguage)
  } catch {
    return undefined
  }
}

export function encodeCompanionState(state: CompanionState): string {
  return JSON.stringify(state)
}
