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
  EGG_STOCK_MAX,
  type EggStock,
  type AppLanguage,
  type CompanionState,
  type DexEntry,
  type MonState,
  NATURES,
  type PokemonNature,
  RARITIES,
  type Rarity,
  type Mood,
  type Temperament,
  type TrailEntry,
  type WildEncounter,
  type WildLine,
  type Lure,
  type WildFind,
  freshCompanionState,
  freshSpeciesProgress,
  pokemonTypes,
  type SpeciesProgress,
} from './model.js'
import { seedRegistry } from './registry.js'
import {
  EncounterBalance,
  LegendaryBalance,
  MilestoneBalance,
  StreakBalance,
  TrailBalance,
  isFindableItem,
} from './encounters.js'

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
  if (value['chosenWhenRegistered'] === true) mon.chosenWhenRegistered = true
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

/** All or nothing: a lure aimed at an impossible species, or with no end, is dropped. */
function decodeLure(value: unknown): Lure | undefined {
  if (!isObject(value)) return undefined
  const speciesID = lenientOptional(value, 'speciesID', isInt)
  const baseID = lenientOptional(value, 'baseID', isInt)
  const stageIndex = lenientOptional(value, 'stageIndex', isInt)
  const until = lenientOptional(value, 'until', isNumber)
  if (
    speciesID === undefined ||
    baseID === undefined ||
    stageIndex === undefined ||
    until === undefined
  ) {
    return undefined
  }
  if (speciesID <= 0 || baseID <= 0 || stageIndex < 0) return undefined
  // As a wild line's: a base is its own line's base, an evolved form is not.
  if ((stageIndex === 0) !== (baseID === speciesID)) return undefined
  return { speciesID, baseID, stageIndex, until }
}

/**
 * All four or nothing, and consistent with the species it prices: a base is its own line's base,
 * an evolved form is not. A partial or contradictory position would price a registration wrongly.
 */
function decodeWildLine(value: unknown, speciesID: number): WildLine | undefined {
  if (!isObject(value)) return undefined
  const baseID = lenientOptional(value, 'baseID', isInt)
  const stageIndex = lenientOptional(value, 'stageIndex', isInt)
  const totalForms = lenientOptional(value, 'totalForms', isInt)
  const rarity = lenientOptional(value, 'rarity', isRarity)
  if (
    baseID === undefined ||
    stageIndex === undefined ||
    totalForms === undefined ||
    rarity === undefined
  ) {
    return undefined
  }
  if (baseID <= 0 || stageIndex < 0 || totalForms < 1 || totalForms > 12 || stageIndex >= totalForms) {
    return undefined
  }
  if ((stageIndex === 0) !== (baseID === speciesID)) return undefined
  return { baseID, stageIndex, totalForms, rarity }
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
  const line = decodeWildLine(value['line'], speciesID)
  if (line !== undefined) encounter.line = line
  // Everything below is optional and dropped rather than defaulted when malformed: an absent mood
  // reads as the initial mood for its temperament, which is the player-favourable direction — a
  // corrupt value must never arrive as "furious".
  const nature = lenientOptional(value, 'nature', isNature)
  if (nature !== undefined) encounter.nature = nature
  const temperament = decodeTemperament(value['temperament'])
  if (temperament !== undefined) encounter.temperament = temperament
  const mood = decodeMood(value['mood'])
  if (mood !== undefined) encounter.mood = mood
  if (value['primed'] === true) encounter.primed = true
  const stolen = lenientOptional(value, 'stolen', isInt)
  if (stolen !== undefined && stolen > 0) encounter.stolen = stolen
  const trackedCount = lenientOptional(value, 'trackedCount', isInt)
  if (trackedCount !== undefined && trackedCount > 0) encounter.trackedCount = trackedCount
  const types = pokemonTypes(value['types'])
  if (types !== undefined) encounter.types = types
  return encounter
}

const isPercent = (v: unknown): v is number => isNumber(v) && v >= 0 && v <= 100

/** A 0–100 triple, or nothing: one field out of range drops the whole reading. */
function decodeTemperament(value: unknown): Temperament | undefined {
  if (!isObject(value)) return undefined
  const { aggression, skittishness, appetite } = value
  if (!isPercent(aggression) || !isPercent(skittishness) || !isPercent(appetite)) return undefined
  return { aggression, skittishness, appetite }
}

function decodeMood(value: unknown): Mood | undefined {
  if (!isObject(value)) return undefined
  const { anger, nervousness, trust } = value
  if (!isPercent(anger) || !isPercent(nervousness) || !isPercent(trust)) return undefined
  return { anger, nervousness, trust }
}

/**
 * An item lying in the queue. Only items that can actually be found are accepted — a hand-edited
 * `masterBall` find would otherwise be a free Master Ball one click away.
 */
export function decodeWildFind(value: unknown): WildFind | undefined {
  if (!isObject(value)) return undefined
  const id = lenientOptional(value, 'id', isString)
  const item = lenientOptional(value, 'item', isString)
  const count = lenientOptional(value, 'count', isInt)
  const rarity = lenientOptional(value, 'rarity', isRarity)
  if (id === undefined || item === undefined || !isFindableItem(item) || rarity === undefined)
    return undefined
  if (count === undefined || count < 1 || count > 10) return undefined
  return { id, item, count, rarity, appearedAt: lenient(value, 'appearedAt', isNumber, 0) }
}

/** A legendary that got away. Needs what it takes to bring the same Pokémon back. */
export function decodeTrailEntry(value: unknown): TrailEntry | undefined {
  if (!isObject(value)) return undefined
  const id = lenientOptional(value, 'id', isString)
  const speciesID = lenientOptional(value, 'speciesID', isInt)
  const captureRate = lenientOptional(value, 'captureRate', isInt)
  const lostAt = lenientOptional(value, 'lostAt', isNumber)
  if (id === undefined || speciesID === undefined || captureRate === undefined || lostAt === undefined) {
    return undefined
  }
  const entry: TrailEntry = {
    id,
    speciesID,
    captureRate,
    isShiny: lenient(value, 'isShiny', isBool, false),
    trackedCount: Math.min(TrailBalance.maxTracks, Math.max(0, lenient(value, 'trackedCount', isInt, 0))),
    lostAt,
  }
  const names = lenientOptional(value, 'names', isStringRecord)
  if (names !== undefined) entry.names = names
  const nature = lenientOptional(value, 'nature', isNature)
  if (nature !== undefined) entry.nature = nature
  const temperament = decodeTemperament(value['temperament'])
  if (temperament !== undefined) entry.temperament = temperament
  const types = pokemonTypes(value['types'])
  if (types !== undefined) entry.types = types
  return entry
}

/** `yyyy-MM-dd`, the only shape the streak rules can read. */
export const isDayKey = (v: unknown): v is string => isString(v) && /^\d{4}-\d{2}-\d{2}$/.test(v)

/**
 * Accrual days: shape-filtered, de-duplicated and capped at the window's width.
 *
 * A duplicate would count one day twice toward the streak, and an unbounded array (a hand
 * edit, a save from a future version with a wider window) would both bloat the file and make
 * the "3 days" test trivially true, so both are fixed here rather than trusted.
 */
function decodeAccrualDays(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const unique = [...new Set(value.filter(isDayKey))].sort()
  return unique.slice(-StreakBalance.windowDays)
}

const isShare = (v: unknown): v is number => isNumber(v) && v >= 0 && v <= 1

/** One species' entry, or nothing: a malformed entry is dropped, never defaulted upward. */
export function decodeSpeciesProgress(value: unknown): SpeciesProgress | undefined {
  if (!isObject(value)) return undefined
  const fresh = freshSpeciesProgress()
  const progress: SpeciesProgress = {
    xp: Math.max(0, lenient(value, 'xp', isInt, 0)),
    unlocked: lenient(value, 'unlocked', isBool, false),
    seen: lenient(value, 'seen', isBool, false),
    registered: lenient(value, 'registered', isBool, false),
    caught: Math.max(0, lenient(value, 'caught', isInt, 0)),
    candiesUsed: Math.max(0, lenient(value, 'candiesUsed', isInt, 0)),
  }
  const threshold = lenientOptional(value, 'threshold', isInt)
  if (threshold !== undefined && threshold > 0) progress.threshold = threshold
  const baseID = lenientOptional(value, 'baseID', isInt)
  if (baseID !== undefined && baseID > 0) progress.baseID = baseID
  const stageIndex = lenientOptional(value, 'stageIndex', isInt)
  if (stageIndex !== undefined && stageIndex >= 0) progress.stageIndex = stageIndex
  const totalForms = lenientOptional(value, 'totalForms', isInt)
  if (totalForms !== undefined && totalForms > 0) progress.totalForms = totalForms
  const lineRarity = lenientOptional(value, 'lineRarity', isRarity)
  if (lineRarity !== undefined) progress.lineRarity = lineRarity
  const pendingShare = lenientOptional(value, 'pendingShare', isShare)
  if (pendingShare !== undefined && pendingShare > 0) progress.pendingShare = pendingShare
  const shinyXP = lenientOptional(value, 'shinyXP', isInt)
  if (shinyXP !== undefined && shinyXP > 0) progress.shinyXP = shinyXP
  const shinyBoosted = lenientOptional(value, 'shinyBoosted', isInt)
  if (shinyBoosted !== undefined && shinyBoosted > 0) progress.shinyBoosted = shinyBoosted
  if (value['shinyUnlocked'] === true) progress.shinyUnlocked = true
  if (value['shinyRegistered'] === true) progress.shinyRegistered = true
  const nature = lenientOptional(value, 'nature', isNature)
  if (nature !== undefined) progress.nature = nature
  if (value['companionShiny'] === true) progress.companionShiny = true
  // An entry that says nothing is dropped: it would only make the map grow.
  const empty = Object.entries(progress).every(([key, v]) => v === fresh[key as keyof SpeciesProgress])
  return empty ? undefined : progress
}

/** Clamped to the stock's capacity; a day that is not day-shaped never matches, so it re-grants. */
export function decodeEggStock(value: unknown): EggStock {
  if (!isObject(value)) return { count: 0 }
  const stock: EggStock = {
    count: Math.min(EGG_STOCK_MAX, Math.max(0, lenient(value, 'count', isInt, 0))),
  }
  const lastGrantDay = lenientOptional(value, 'lastGrantDay', isDayKey)
  if (lastGrantDay !== undefined) stock.lastGrantDay = lastGrantDay
  return stock
}

/**
 * Entry by entry, so one bad species never takes the map with it — which is why this does not
 * go through `isNumberRecord`-style validation of the whole object.
 */
export function decodeSpeciesMap(value: unknown): Record<number, SpeciesProgress> {
  const out: Record<number, SpeciesProgress> = {}
  if (!isObject(value)) return out
  for (const [key, raw] of Object.entries(value)) {
    const id = Number(key)
    if (!Number.isInteger(id) || id <= 0) continue
    const progress = decodeSpeciesProgress(raw)
    if (progress !== undefined) out[id] = progress
  }
  return out
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
    earnedTokens: Math.max(0, lenient(value, 'earnedTokens', isInt, 0)),
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
    // Absent (an older save) decodes to no recorded days at all, which is the no-retro-award
    // direction: the streak starts from the next fold that actually accrues, so upgrading
    // never hands out a legendary for days that were never observed. Entries are filtered to
    // the expected shape and capped, because everything downstream indexes by day.
    accrualDays: decodeAccrualDays(value['accrualDays']),
    // Seeded rather than defaulted — see below.
    milestonesAwarded: 0,
    owedLegendaryEncounters: Math.min(
      LegendaryBalance.maxOwed,
      Math.max(0, lenient(value, 'owedLegendaryEncounters', isInt, 0)),
    ),
    // Absent in a save from before sync: no attributed usage and no history yet, which is
    // exactly what a merge must assume about it.
    usedByDevice: lenient(value, 'usedByDevice', isNumberRecord, {}),
    revision: lenient(value, 'revision', isNumberRecord, {}),
    // Per-item isolation, as with the queue. Finds share the queue's room with the Pokémon.
    finds: (Array.isArray(value['finds']) ? value['finds'] : [])
      .map(decodeWildFind)
      .filter((f): f is WildFind => f !== undefined),
    legendaryTrail: (Array.isArray(value['legendaryTrail']) ? value['legendaryTrail'] : [])
      .map(decodeTrailEntry)
      .filter((e): e is TrailEntry => e !== undefined)
      .slice(-TrailBalance.maxEntries),
    // Absent means armed: a save from before the notice existed may announce its next fill.
    queueFullArmed: lenient(value, 'queueFullArmed', isBool, true),
    species: decodeSpeciesMap(value['species']),
    eggStock: decodeEggStock(value['eggStock']),
  }
  state.finds = state.finds.slice(0, Math.max(0, EncounterBalance.maxQueue - state.wild.length))

  /**
   * The milestone ratchet is the one field where "absent" must not mean zero.
   *
   * Zero on a save carrying billions of lifetime tokens would read as "every milestone is
   * still unclaimed" and pay a legendary out on the first refresh after an update — the exact
   * retro-award `candyFeatureSeeded` exists to prevent for candies. Key present (even as 0)
   * means the feature has already seen this save, so it is honoured verbatim.
   */
  state.milestonesAwarded = Object.hasOwn(value, 'milestonesAwarded')
    ? Math.max(0, lenient(value, 'milestonesAwarded', isInt, 0))
    : Math.floor(state.usedSinceInstall / MilestoneBalance.tokens)

  // Shape-checked, not date-checked: a value that is not a real date simply never matches a
  // day, which leaves the guard open rather than jammed shut.
  const lastStreakAwardDate = lenientOptional(value, 'lastStreakAwardDate', isString)
  if (lastStreakAwardDate !== undefined) state.lastStreakAwardDate = lastStreakAwardDate

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
  if (value['keepCompletedCompanion'] === true) state.keepCompletedCompanion = true
  const lure = decodeLure(value['lure'])
  if (lure !== undefined) state.lure = lure
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

  // The registry is seeded from what the save already shows — flags and zeros only — but
  // **only when the key is absent**: a save that carries the key, even empty, has been seeded
  // once. Same rule as `milestonesAwarded` and for the same reason: "absent" is the one thing
  // that must not read as "none" — and a key that is present but unusable (`null`, a string) is
  // absent for this purpose. Last, after the active Pokémon is in place, because the seed also
  // resets its stage progress.
  return isObject(value['species']) ? state : seedRegistry(state)
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
