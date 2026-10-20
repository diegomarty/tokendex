/**
 * Economy simulator: N days of play for a few usage profiles, through the **real** engine.
 *
 * It drives a `CompanionStore` exactly as the worker does — one observation per refresh, the
 * player acting between refreshes — with no network: the species index is the real cached one
 * when it exists, evolution lines are synthesised by rarity, and the clock and the RNG are
 * injected. Everything that decides a token's fate is production code, so a number printed here
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
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as AppPaths from '../src/core/appPaths.js'
import { CompanionStore } from '../src/core/companion/store.js'
import { PokemonBalance, type BallKind, type Rarity, rarityFrom } from '../src/core/companion/model.js'
import type { BaseSpecies, EvoLine, PokeProviding, WildSpecies } from '../src/core/pokeapi.js'
import { makeEvoLine } from '../src/core/companion/model.js'
import { buyItem, canBuyItem, canUseRareCandy, consumeRareCandy } from '../src/core/companion/shop.js'
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

// MARK: - Provider: the real index, synthetic lines

async function loadIndex(): Promise<BaseSpecies[]> {
  try {
    const raw = JSON.parse(await readFile(join(AppPaths.ourData(), 'base-index.json'), 'utf8')) as {
      entries?: BaseSpecies[]
    }
    if (Array.isArray(raw.entries) && raw.entries.length > 100) return raw.entries
  } catch {
    // fall through to the synthetic index
  }
  // 328 lines in the real gen 1–5 index: 175 common, 33 uncommon, 72 rare, 48 legendary.
  const out: BaseSpecies[] = []
  let id = 1
  const push = (n: number, captureRate: number, legendary = false) => {
    for (let i = 0; i < n; i++) out.push({ id: id++, captureRate, isLegendary: legendary })
  }
  push(175, 190)
  push(33, 90)
  push(72, 45)
  push(48, 3, true)
  return out
}

/** Forms per line by rarity: the gen 1–5 average is close to this. */
function formsFor(rarity: Rarity): number {
  return rarity === 'legendary' ? 1 : rarity === 'common' ? 3 : 2
}

function provider(index: BaseSpecies[]): PokeProviding {
  const byID = new Map(index.map((e) => [e.id, e]))
  const rarityOf = (e: BaseSpecies) =>
    rarityFrom(e.captureRate, e.isLegendary ?? false, e.isMythical ?? false)
  const lines = new Map<number, EvoLine>()
  const line = async (baseID: number): Promise<EvoLine> => {
    const cached = lines.get(baseID)
    if (cached !== undefined) return cached
    const base = byID.get(baseID) ?? { id: baseID, captureRate: 190 }
    const rarity = rarityOf(base)
    const forms = formsFor(rarity)
    // Evolved forms get ids outside the index so they never collide with another base.
    const ids = Array.from({ length: forms }, (_, i) => (i === 0 ? baseID : baseID + 1000 * i))
    let node = { speciesID: ids[forms - 1]!, children: [] as { speciesID: number; children: never[] }[] }
    for (let i = forms - 2; i >= 0; i--) node = { speciesID: ids[i]!, children: [node as never] }
    const made = makeEvoLine(baseID, node as never, rarity, {})
    lines.set(baseID, made)
    return made
  }
  return {
    line,
    baseSpeciesIndex: async () => index,
    baseSpecies: async (id) => byID.get(id),
    wildSpecies: async (id): Promise<WildSpecies> => {
      const base = byID.get(id) ?? { id, captureRate: 190 }
      return { id, captureRate: base.captureRate, rarity: rarityOf(base), names: { en: `#${id}` } }
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
    provider: provider(await loadIndex()),
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
            await store.mutate((tx) => tx.commit(buyItem(tx.state, ball, 10)))
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
    'unlkd',
    'caught',
    'wallet',
    'max',
    'spent',
    'fulldex',
  ].join('  '),
)
for (const name of selected) {
  const tokens = PROFILES[name]
  if (tokens === undefined) {
    console.error(`unknown profile ${name}; one of ${Object.keys(PROFILES).join(', ')}`)
    process.exit(2)
  }
  console.log(row(await simulate(name, tokens)))
}
console.log(`full Pokédex = ${compact(fullDexTokens)} of registration (analytic, 328 lines)`)
