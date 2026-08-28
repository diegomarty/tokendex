import { describe, expect, it } from 'vitest'
import { REFRESH_PRESETS, buildPanelState } from '../src/core/panel/build.js'
import { buildSnapshot, type CompanionView } from '../src/core/snapshot.js'
import {
  Pokeball,
  freshCompanionState,
  type CompanionState,
  type WildEncounter,
} from '../src/core/companion/model.js'
import { DEFAULT_TRAINER_ID } from '../src/core/companion/trainers.js'

// The panel builder was the single largest piece of UI-shaping code outside the suite until it
// moved into the core — and that blind spot shipped a real bug (a celebration flag frozen into
// a reused snapshot). These tests are the reason the move happened.

const NOW = Date.parse('2026-08-28T12:00:00Z')

const usage = (companion?: CompanionView) =>
  buildSnapshot([], {
    now: NOW,
    locale: 'en-US',
    lang: 'en',
    ...(companion === undefined ? {} : { companion }),
  })

const view = (over: Partial<CompanionView> = {}): CompanionView => ({
  state: 'working',
  name: 'Pikachu',
  speciesID: 25,
  isShiny: false,
  progress: 0.5,
  toNextText: '1M to next',
  dexCount: 1,
  spendableTokens: 100,
  wildCount: 0,
  wildTooltip: '',
  ...over,
})

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

const wild = (over: Partial<WildEncounter> = {}): WildEncounter => ({
  id: 'w1',
  speciesID: 147,
  captureRate: 45,
  rarity: 'rare',
  isShiny: false,
  appearedAt: NOW - 60_000,
  throws: 0,
  names: { en: 'Dratini' },
  ...over,
})

const build = (over: Partial<Parameters<typeof buildPanelState>[0]> = {}) =>
  buildPanelState({
    usage: usage(),
    state: state(),
    line: undefined,
    isCelebrating: false,
    now: NOW,
    locale: 'en-US',
    ...over,
  })

describe('celebration flag', () => {
  // [trigger branch] The bug that motivated the extraction: `usage` can be a reused snapshot
  // whose display state froze at `levelUp`. The flag must come from the injected live reading
  // and nowhere else.
  it('comes only from the live input, never from the snapshot', () => {
    const stale = build({ usage: usage(view({ state: 'levelUp' })), isCelebrating: false })
    expect(stale.companion?.celebrating).toBeUndefined()

    const live = build({ usage: usage(view()), isCelebrating: true })
    expect(live.companion?.celebrating).toBe(true)
  })
})

describe('the ball rack', () => {
  it('prices every ball against the encounter on stage, Master at 100%', () => {
    const panel = build({ state: state({ wild: [wild()] }) })
    for (const ball of panel.wild.balls) expect(ball.oddsText).toBeDefined()
    expect(panel.wild.balls.find((b) => b.kind === 'masterBall')?.oddsText).toBe('100%')
    // The difficulty cap: not even a full-rate species reads as certain on a Poké Ball.
    const easy = build({ state: state({ wild: [wild({ captureRate: 255 })] }) })
    expect(easy.wild.balls.find((b) => b.kind === 'pokeBall')?.oddsText).not.toBe('100%')
  })

  it('shows no odds with an empty stage', () => {
    const panel = build()
    for (const ball of panel.wild.balls) expect(ball.oddsText).toBeUndefined()
  })

  it('counts the starter balls a fresh save carries', () => {
    const panel = build()
    expect(panel.wild.balls.find((b) => b.kind === 'pokeBall')?.count).toBe(Pokeball.starterCount)
  })
})

describe('wild rows', () => {
  it('dates an old encounter instead of showing a bare time that reads as today', () => {
    const today = build({ state: state({ wild: [wild()] }) })
    expect(today.wild.encounters[0]!.appearedText).toContain(':')

    const yesterday = build({
      state: state({ wild: [wild({ appearedAt: NOW - 86_400_000 })] }),
    })
    expect(yesterday.wild.encounters[0]!.appearedText).not.toContain(':')
  })

  it('asks before running only from what hurts to lose', () => {
    const panel = build({
      state: state({
        wild: [
          wild({ id: 'r', rarity: 'rare' }),
          wild({ id: 'c', rarity: 'common', names: { en: 'Caterpie' } }),
          wild({ id: 's', rarity: 'common', isShiny: true }),
        ],
      }),
    })
    const byID = new Map(panel.wild.encounters.map((e) => [e.id, e]))
    expect(byID.get('r')?.runConfirmText).toContain('Dratini')
    expect(byID.get('c')?.runConfirmText).toBeUndefined()
    expect(byID.get('s')?.runConfirmText).toBeDefined()
  })

  it('falls back to the dex number when no name is stored', () => {
    const panel = build({ state: state({ wild: [wild({ names: undefined })] }) })
    expect(panel.wild.encounters[0]!.name).toBe('#147')
  })
})

describe('the shop', () => {
  it('offers ten-packs for every ball except the Master, with bundle ids', () => {
    const ids = build().shop.map((item) => item.id)
    expect(ids).toContain(`item:pokeBall:${Pokeball.bundleSize}`)
    expect(ids).toContain(`item:ultraBall:${Pokeball.bundleSize}`)
    expect(ids).not.toContain(`item:masterBall:${Pokeball.bundleSize}`)
  })

  it('sells eggs only while there is a Pokémon to discard', () => {
    expect(build().shop.some((item) => item.group === 'eggs')).toBe(false)
  })

  it('assigns every row to a rendered group', () => {
    for (const item of build().shop) {
      expect(['balls', 'items', 'eggs']).toContain(item.group)
    }
  })
})

describe('settings and chrome', () => {
  it('builds the refresh picker only when the host said what the setting is', () => {
    expect(build().refresh).toBeUndefined()

    const panel = build({ refreshSeconds: 120 })
    expect(panel.refresh?.seconds).toBe(120)
    expect(panel.refresh?.options.map((o) => o.seconds)).toEqual([...REFRESH_PRESETS])
    for (const option of panel.refresh?.options ?? []) expect(option.label).not.toBe('')
  })

  it('falls back to the default trainer for an absent or retired slug', () => {
    expect(build().trainerID).toBe(DEFAULT_TRAINER_ID)
    expect(build({ state: state({ trainerID: 'lyra' }) }).trainerID).toBe('lyra')
  })

  it('marks wild catches in the log', () => {
    const panel = build({
      state: state({
        dex: [
          {
            id: 'wild-1',
            baseID: 147,
            finalID: 147,
            chainOrder: [147],
            rarity: 'rare',
            caughtAt: NOW,
            isShiny: false,
            source: 'wild',
          },
        ],
      }),
    })
    expect(panel.dexLog[0]?.isWild).toBe(true)
  })

  it('attaches the dev tab only when one is handed in', () => {
    expect(build().dev).toBeUndefined()
    const panel = build({ dev: { summary: [], groups: [] } })
    expect(panel.dev).toEqual({ summary: [], groups: [] })
  })
})
