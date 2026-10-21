/**
 * Economy simulator: N days of play for a few usage profiles, through the **real** engine.
 *
 * It drives a `CompanionStore` exactly as the worker does — one observation per refresh, the
 * player acting between refreshes — with no network: a synthetic world with the real index's
 * shape (`buildWorld`), and the clock and the RNG injected. Everything that decides a token's fate is production code, so a number printed here
 * is the number the game would produce, not a model of it.
 *
 * What it answers (docs/plans/01b-economia-simulador.md): how long a line takes to register,
 * how much of the Pokédex a profile reaches, how the wallet moves and what share of income is
 * spent — the facts every price and reward in the later phases is calibrated against.
 *
 *   make sim                       # all profiles, 180 days
 *   make sim ARGS="--days 365 --profile heavy --seed 7"
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompanionStore } from '../src/core/companion/store.js'
import {
  PokemonBalance,
  type BallKind,
  type EvoLine,
  type Rarity,
  currentSpeciesID,
  rarityFrom,
} from '../src/core/companion/model.js'
import type { BaseSpecies, PokeProviding, WildSpecies } from '../src/core/pokeapi.js'
import { makeEvoLine } from '../src/core/companion/model.js'
import {
  buyItem,
  canBuyItem,
  canUseRareCandy,
  consumeRareCandy,
  shinyBoostRoom,
} from '../src/core/companion/shop.js'
import { spendableBalance } from '../src/core/companion/ledger.js'
import { registrationPercent } from '../src/core/companion/registry.js'
import { compact } from '../src/core/tokenFormatter.js'

// MARK: - Arguments

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  const value = process.argv[i + 1]
  if (key !== undefined && key.startsWith('--') && value !== undefined) args.set(key.slice(2), value)
}
const DAYS = Number(args.get('days') ?? 180)
const SEED = Number(args.get('seed') ?? 1)
const PROFILE = args.get('profile') ?? 'all'

/** Tokens per working day, by profile. See docs/plans/00-master.md § C6. */
const PROFILES: Record<string, number> = {
  chat: 2_000_000,
  light: 20_000_000,
  medium: 100_000_000,
  heavy: 500_000_000,
}
/** Refreshes per working day: the extension re-reads usage every two minutes; the player acts less. */
const REFRESHES_PER_DAY = 12
/** How often the player looks at the queue: one encounter in eight gets a throw. */
const ATTEMPT_ONE_IN = 8
const MAX_THROWS = 5
/** What the player keeps in the wallet before boosting a shiny bar with the rest. */
const SHINY_RESERVE = 1_000_000_000
const WORKDAY_MS = 8 * 3_600_000
const DAY_MS = 24 * 3_600_000

// MARK: - Deterministic RNG (mulberry32)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
}

// MARK: - Provider: a synthetic gen 1–5 world

/**
 * The world the simulation plays in: 328 lines with the real index's rarity mix (175 common,
 * 33 uncommon, 72 rare, 48 legendary) and 649 species in all, numbered 1..649 with each line's
 * forms consecutive — so every id is one the engine accepts (`ANIMATED_SPECIES_MAX`) and the
 * index carries forms the way schema 3 does. Commons split between three-form and two-form lines
 * to land on the real species count. Evolved forms catch harder, as in the games.
 */
interface SimLine {
  base: BaseSpecies
  ids: number[]
}

function buildWorld(): SimLine[] {
  const shapes: { n: number; captureRate: number; forms: number; legendary?: boolean }[] = [
    { n: 41, captureRate: 190, forms: 3 },
    { n: 134, captureRate: 190, forms: 2 },
    { n: 33, captureRate: 90, forms: 2 },
    { n: 72, captureRate: 45, forms: 2 },
    { n: 48, captureRate: 3, forms: 1, legendary: true },
  ]
  const out: SimLine[] = []
  let next = 1
  for (const shape of shapes) {
    for (let i = 0; i < shape.n; i++) {
      const ids = Array.from({ length: shape.forms }, (_, k) => next + k)
      next += shape.forms
      out.push({
        ids,
        base: {
          id: ids[0]!,
          captureRate: shape.captureRate,
          isLegendary: shape.legendary === true,
          lineForms: shape.forms,
          forms: ids.slice(1).map((id, k) => ({
            id,
            stage: k + 1,
            captureRate: formCaptureRate(shape.captureRate, k + 1),
            totalForms: shape.forms,
          })),
        },
      })
    }
  }
  return out
}

/** An evolved form's capture rate: 120 then 45 for a common line, the base's own past that. */
function formCaptureRate(base: number, stage: number): number {
  return Math.min(base, stage === 1 ? 120 : 45)
}

function provider(world: SimLine[]): PokeProviding {
  const lineOf = new Map<number, SimLine>()
  for (const l of world) for (const id of l.ids) lineOf.set(id, l)
  const rarityOf = (e: BaseSpecies) =>
    rarityFrom(e.captureRate, e.isLegendary ?? false, e.isMythical ?? false)
  const lines = new Map<number, EvoLine>()
  const line = async (id: number): Promise<EvoLine> => {
    const sim = lineOf.get(id)
    if (sim === undefined) throw new Error(`sim: no line holds #${id}`)
    const cached = lines.get(sim.base.id)
    if (cached !== undefined) return cached
    let node = {
      speciesID: sim.ids[sim.ids.length - 1]!,
      children: [] as { speciesID: number; children: never[] }[],
    }
    for (let i = sim.ids.length - 2; i >= 0; i--)
      node = { speciesID: sim.ids[i]!, children: [node as never] }
    const made = makeEvoLine(sim.base.id, node as never, rarityOf(sim.base), {})
    lines.set(sim.base.id, made)
    return made
  }
  const index = world.map((l) => l.base)
  return {
    line,
    baseSpeciesIndex: async () => index,
    baseSpecies: async (id) => index.find((e) => e.id === id),
    wildSpecies: async (id): Promise<WildSpecies> => {
      const sim = lineOf.get(id)
      const stage = sim === undefined ? 0 : sim.ids.indexOf(id)
      const base = sim?.base ?? { id, captureRate: 190 }
      const captureRate = stage === 0 ? base.captureRate : formCaptureRate(base.captureRate, stage)
      return {
        id,
        captureRate,
        rarity: rarityFrom(captureRate, base.isLegendary ?? false, false),
        names: { en: `#${id}` },
      }
    },
  }
}

// MARK: - One profile

interface Outcome {
  profile: string
  tokensPerDay: number
  firstRegisteredDay: number | undefined
  firstLineDay: number | undefined
  registered: number
  shinies: number
  unlocked: number
  seen: number
  encounters: number
  caught: number
  income: number
  spent: number
  earned: number
  walletEnd: number
  walletMax: number
}

async function simulate(profile: string, tokensPerDay: number): Promise<Outcome> {
  const rng = mulberry32(SEED)
  let clock = Date.parse('2026-01-05T09:00:00Z')
  const store = new CompanionStore({
    provider: provider(buildWorld()),
    filePath: join(mkdtempSync(join(tmpdir(), 'tokendex-sim-')), 'companion-state.json'),
    now: () => clock,
    rng,
    hostLanguage: 'en',
    dittoEnabled: false,
    deviceID: 's'.repeat(32),
    encounterToastsEnabled: () => false,
  })
  await store.load()

  const out: Outcome = {
    profile,
    tokensPerDay,
    firstRegisteredDay: undefined,
    firstLineDay: undefined,
    registered: 0,
    shinies: 0,
    unlocked: 0,
    seen: 0,
    encounters: 0,
    caught: 0,
    income: 0,
    spent: 0,
    earned: 0,
    walletEnd: 0,
    walletMax: 0,
  }
  let graduations = 0

  const ballFor = (rarity: string): BallKind =>
    rarity === 'rare' || rarity === 'legendary' ? 'ultraBall' : 'pokeBall'

  for (let day = 1; day <= DAYS; day++) {
    const dayStart = clock
    const date = new Date(dayStart).toISOString().slice(0, 10)
    // Weekends off: a profile is a working day's tokens.
    const weekday = new Date(dayStart).getUTCDay()
    const working = weekday !== 0 && weekday !== 6
    let cumulative = 0
    for (let r = 1; r <= REFRESHES_PER_DAY; r++) {
      clock = dayStart + Math.round((WORKDAY_MS * r) / REFRESHES_PER_DAY)
      if (working) cumulative = Math.round((tokensPerDay * r) / REFRESHES_PER_DAY)
      await store.update({
        todayTokensByProvider: { claude_code: cumulative },
        todayDate: date,
        hasUsageData: true,
      })
      store.drainEvents()

      // The player, between refreshes.
      await store.collectAllFinds()
      const state = store.snapshot()
      const head = state.wild[0]
      if (head !== undefined && rng() % ATTEMPT_ONE_IN === 0) {
        const ball = ballFor(head.rarity)
        for (let t = 0; t < MAX_THROWS; t++) {
          let s = store.snapshot()
          if ((s.inventory[ball] ?? 0) === 0) {
            if (!canBuyItem(s, ball, 10)) break
            await store.mutate((tx) => {
              const bought = buyItem(tx.state, ball, 10)
              if (bought !== undefined) tx.commit(bought)
            })
            s = store.snapshot()
          }
          const outcome = await store.throwBallAt(head.id, ball)
          if (outcome.kind === 'caught') {
            out.caught++
            break
          }
          if (outcome.kind !== 'broke') break // fled, out of balls, or gone
        }
      }
      // Phase 2: a registered final form stays on stage, so the player picks what comes next —
      // an unlocked species still to register, else an egg from the stock.
      {
        const s = store.snapshot()
        const active = s.active
        const current =
          active === undefined ? undefined : s.species[active.pathIDs[active.stageIndex] ?? active.baseID]
        const finalForm = active !== undefined && active.stageIndex >= active.totalForms - 1
        if (active !== undefined && finalForm && current?.registered === true) {
          const next = Object.entries(s.species).find(([, p]) => p.unlocked && !p.registered)
          if (next !== undefined) await store.setCompanion(Number(next[0]))
          else if (s.eggStock.count > 0) await store.incubateEgg()
        }
      }
      // Phase 5: with nothing left to register, keep the companion for its shiny bar, and spend
      // what the wallet holds past a reserve on boosts — the sink the heavy profile was missing.
      {
        const s = store.snapshot()
        const nothingToRegister = !Object.values(s.species).some((p) => p.unlocked && !p.registered)
        if (nothingToRegister && s.keepCompletedCompanion !== true)
          await store.setKeepCompletedCompanion(true)
        if (!nothingToRegister && s.keepCompletedCompanion === true)
          await store.setKeepCompletedCompanion(false)
        const spare = spendableBalance(s) - SHINY_RESERVE
        if (spare > 0) {
          const companion = s.active === undefined ? undefined : currentSpeciesID(s.active)
          const ids = Object.keys(s.species).map(Number)
          const target = [companion, ...ids].find((id) => id !== undefined && shinyBoostRoom(s, id) > 0)
          if (target !== undefined) {
            const amount = Math.min(spare, shinyBoostRoom(s, target))
            if (amount > 0) await store.boostShiny(target, amount)
          }
        }
      }
      if (canUseRareCandy(store.snapshot(), store.currentLine() !== undefined)) {
        await store.mutate((tx) => {
          const next = consumeRareCandy(tx.state)
          if (next === undefined) return
          tx.commit(next)
          tx.applyCandy()
        })
      }
      const after = store.snapshot()
      out.walletMax = Math.max(out.walletMax, spendableBalance(after))
      const registered = Object.values(after.species).filter((p) => p.registered).length
      if (registered > 0 && out.firstRegisteredDay === undefined) out.firstRegisteredDay = day
      const grads = after.dex.filter((e) => e.source === undefined).length
      if (grads > graduations) {
        graduations = grads
        if (out.firstLineDay === undefined) out.firstLineDay = day
      }
    }
    clock = dayStart + DAY_MS
  }

  const final = store.snapshot()
  out.registered = Object.values(final.species).filter((p) => p.registered).length
  out.shinies = Object.values(final.species).filter((p) => p.shinyRegistered === true).length
  out.unlocked = Object.values(final.species).filter((p) => p.unlocked).length
  out.seen = Object.values(final.species).filter((p) => p.seen).length
  out.encounters = final.encountersSeen
  out.income = final.usedSinceInstall
  out.spent = final.spentTokens
  out.earned = final.earnedTokens
  out.walletEnd = spendableBalance(final)
  void registrationPercent
  return out
}

// MARK: - Report

const FULL_DEX_LINES = { common: 175, uncommon: 33, rare: 72, legendary: 48 } as const
const fullDexTokens = (Object.keys(FULL_DEX_LINES) as Rarity[]).reduce(
  (sum, r) => sum + FULL_DEX_LINES[r] * PokemonBalance.graduationTotal(r),
  0,
)

function row(o: Outcome): string {
  const days = (d: number | undefined) => (d === undefined ? '—' : `${d}d`)
  const pct = (a: number, b: number) => (b === 0 ? '0%' : `${Math.round((100 * a) / b)}%`)
  const workingDays = Math.round((DAYS * 5) / 7)
  const fullDexDays = Math.round(fullDexTokens / o.tokensPerDay / (5 / 7))
  return [
    o.profile.padEnd(7),
    compact(o.tokensPerDay).padStart(6),
    days(o.firstRegisteredDay).padStart(6),
    days(o.firstLineDay).padStart(6),
    String(o.registered).padStart(5),
    String(o.shinies).padStart(6),
    String(o.unlocked).padStart(5),
    `${o.caught}/${o.encounters}`.padStart(9),
    compact(o.walletEnd).padStart(7),
    compact(o.walletMax).padStart(7),
    pct(o.spent, o.income).padStart(6),
    `${fullDexDays}d`.padStart(7),
    `(${workingDays} working days)`,
  ].join('  ')
}

const selected = PROFILE === 'all' ? Object.keys(PROFILES) : [PROFILE]
console.log(
  `economy-sim: ${DAYS} days, seed ${SEED}, 1 attempt in ${ATTEMPT_ONE_IN} encounters, no berries`,
)
console.log(
  [
    'profile',
    'tok/d',
    '1st reg',
    '1st line',
    'regd',
    'shiny',
    'unlkd',
    'caught',
    'wallet',
    'max',
    'spent',
    'fulldex',
  ].join('  '),
)
async function main(): Promise<void> {
  for (const name of selected) {
    const tokens = PROFILES[name]
    if (tokens === undefined) {
      console.error(`unknown profile ${name}; one of ${Object.keys(PROFILES).join(', ')}`)
      process.exit(2)
    }
    console.log(row(await simulate(name, tokens)))
  }
  console.log(`full Pokédex = ${compact(fullDexTokens)} of registration (analytic, 328 lines)`)
}

void main()
