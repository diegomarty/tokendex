/**
 * Daily and weekly challenges: a reason to open the panel today, paid in tokens. Pure.
 *
 *  - **Deterministic by date.** The challenges of a day (and of an ISO week) come from a seed
 *    derived from the date alone, so every machine shows the same ones and a merge compares like
 *    with like. Two daily, of different kinds, and one weekly.
 *  - **Paid once, ever.** A challenge completed adds its reward to `earnedTokens`, is marked
 *    `done`, and its id goes to `challengesPaid`. That ledger is what makes it once: two machines
 *    on different dates move the board back and forth between days, and a regenerated challenge
 *    whose id was paid comes back done. A merge may bring progress past the target with the reward
 *    unpaid (the winner never got there): `ensureChallenges` settles it, once.
 */

import { EconomyBalance } from './economy.js'
import type { CompanionState, PokemonType } from './model.js'

export type ChallengeKind = 'catch' | 'catchType' | 'newSpecies' | 'useTokens'
export type ChallengePeriod = 'day' | 'week'

export interface Challenge {
  id: string
  period: ChallengePeriod
  kind: ChallengeKind
  target: number
  /** For `catchType`: the type asked for. */
  type?: PokemonType
  progress: number
  done: boolean
}

export interface ChallengeBoard {
  /** `yyyy-MM-dd` the daily challenges are for. */
  day: string
  /** ISO week key (`2026-W43`) the weekly challenge is for. */
  week: string
  items: Challenge[]
}

/** Types common enough among gen 1–5 to meet in a day; the rarer ones would make a dud. */
export const CHALLENGE_TYPES: readonly PokemonType[] = [
  'normal',
  'fire',
  'water',
  'grass',
  'bug',
  'flying',
  'poison',
  'electric',
  'ground',
  'psychic',
  'rock',
  'fighting',
]

const KINDS: readonly ChallengeKind[] = ['catch', 'catchType', 'newSpecies', 'useTokens']

/** What each kind asks for, per period. */
const TARGETS: Record<ChallengePeriod, Record<ChallengeKind, number>> = {
  day: { catch: 3, catchType: 1, newSpecies: 1, useTokens: 2_000_000 },
  week: { catch: 15, catchType: 3, newSpecies: 3, useTokens: 20_000_000 },
}

/** The ISO 8601 week a day falls in: `2026-W43`. */
export function isoWeekKey(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  // The week's Thursday decides its year; week 1 is the one holding 4 January.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3)
  const year = date.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const days = (date.getTime() - jan4.getTime()) / 86_400_000
  const week = 1 + Math.round((days - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** FNV-1a over the key, then a few xorshift steps: a small deterministic stream per date. */
function stream(key: string): () => number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return () => {
    h ^= h << 13
    h >>>= 0
    h ^= h >>> 17
    h ^= h << 5
    h >>>= 0
    return h
  }
}

function make(period: ChallengePeriod, key: string, kind: ChallengeKind, next: () => number): Challenge {
  const challenge: Challenge = {
    id: `${period}:${key}:${kind}`,
    period,
    kind,
    target: TARGETS[period][kind],
    progress: 0,
    done: false,
  }
  if (kind === 'catchType') challenge.type = CHALLENGE_TYPES[next() % CHALLENGE_TYPES.length]!
  return challenge
}

/** The challenges a day shows: its two dailies (different kinds) and its week's one. */
export function challengesFor(day: string): Challenge[] {
  return boardFor(day, isoWeekKey(day))
}

/** The challenges dealt for a given day and week, fresh. What a saved board is rebuilt from. */
export function boardFor(day: string, week: string): Challenge[] {
  return [...dailies(day), weekly(week)]
}

/** How many paid ids the ledger keeps: comfortably more than the days a board can swing over. */
const PAID_LEDGER_SIZE = 64

function dailies(day: string): Challenge[] {
  const next = stream(`day:${day}`)
  const first = KINDS[next() % KINDS.length]!
  const rest = KINDS.filter((k) => k !== first)
  const second = rest[next() % rest.length]!
  return [make('day', day, first, next), make('day', day, second, next)]
}

function weekly(week: string): Challenge {
  const next = stream(`week:${week}`)
  return make('week', week, KINDS[next() % KINDS.length]!, next)
}

/** What a challenge pays: the table's, by period. The one statement of it. */
export function challengeReward(challenge: Pick<Challenge, 'period'>): number {
  return challenge.period === 'day'
    ? EconomyBalance.challenge.dailyReward
    : EconomyBalance.challenge.weeklyReward
}

/** Pays every challenge whose progress reached its target and is not paid yet. */
function settle(state: CompanionState): { state: CompanionState; done: Challenge[] } {
  const board = state.challenges
  if (board === undefined) return { state, done: [] }
  const done: Challenge[] = []
  const ledger = new Set(state.challengesPaid ?? [])
  let changed = false
  const items = board.items.map((c) => {
    // Paid before (this board was regenerated after moving between days): done, not paid again.
    if (!c.done && ledger.has(c.id)) {
      changed = true
      return { ...c, done: true, progress: c.target }
    }
    if (c.done || c.progress < c.target) return c
    const paid = { ...c, done: true }
    done.push(paid)
    return paid
  })
  if (done.length === 0)
    return { state: changed ? { ...state, challenges: { ...board, items } } : state, done }
  const reward = done.reduce((sum, c) => sum + challengeReward(c), 0)
  const paid = [...ledger, ...done.map((c) => c.id)].slice(-PAID_LEDGER_SIZE)
  return {
    state: {
      ...state,
      earnedTokens: state.earnedTokens + reward,
      challenges: { ...board, items },
      challengesPaid: paid,
    },
    done,
  }
}

/**
 * Brings the board to `day`: a new day replaces the dailies, a new week the weekly — progress on
 * the ones still current is kept. Then pays anything that reached its target unpaid.
 */
export function ensureChallenges(
  state: CompanionState,
  day: string,
): { state: CompanionState; done: Challenge[] } {
  const week = isoWeekKey(day)
  const board = state.challenges
  if (board === undefined || board.day !== day || board.week !== week) {
    const keptDaily = board?.day === day ? board.items.filter((c) => c.period === 'day') : dailies(day)
    const keptWeekly =
      board?.week === week ? board.items.filter((c) => c.period === 'week') : [weekly(week)]
    state = { ...state, challenges: { day, week, items: [...keptDaily, ...keptWeekly] } }
  }
  return settle(state)
}

function advance(
  state: CompanionState,
  by: (c: Challenge) => number,
): { state: CompanionState; done: Challenge[] } {
  const board = state.challenges
  if (board === undefined) return { state, done: [] }
  const items = board.items.map((c) => {
    const step = c.done ? 0 : by(c)
    return step > 0 ? { ...c, progress: Math.min(c.target, c.progress + step) } : c
  })
  return settle({ ...state, challenges: { ...board, items } })
}

/** Tokens used today count toward `useTokens`. */
export function progressTokens(
  state: CompanionState,
  delta: number,
): { state: CompanionState; done: Challenge[] } {
  if (delta <= 0) return { state, done: [] }
  return advance(state, (c) => (c.kind === 'useTokens' ? delta : 0))
}

/** A catch counts toward `catch`, toward `catchType` when it has the type, and toward `newSpecies` when new. */
export function progressCatch(
  state: CompanionState,
  caught: { types: readonly PokemonType[] | undefined; isNew: boolean },
): { state: CompanionState; done: Challenge[] } {
  return advance(state, (c) => {
    switch (c.kind) {
      case 'catch':
        return 1
      case 'catchType':
        return c.type !== undefined && (caught.types ?? []).includes(c.type) ? 1 : 0
      case 'newSpecies':
        return caught.isNew ? 1 : 0
      case 'useTokens':
        return 0
    }
  })
}
