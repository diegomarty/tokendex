import { describe, expect, it } from 'vitest'
import { REFRESH_PRESETS, buildPanelState, catchBanner } from '../src/core/panel/build.js'
import { buildSnapshot, type CompanionView } from '../src/core/snapshot.js'
import {
  Pokeball,
  PokemonBalance,
  RARITIES,
  ANIMATED_SPECIES_MAX,
  EGG_STOCK_MAX,
  RareCandy,
  FreshEgg,
  freshCompanionState,
  freshSpeciesProgress,
  makeEvoLine,
  packQuantities,
  type SpeciesProgress,
  shopEntryPrice,
  type CompanionState,
  type MonState,
  type WildEncounter,
} from '../src/core/companion/model.js'
import { DEFAULT_TRAINER_ID } from '../src/core/companion/trainers.js'
import { candyFullHint } from '../src/core/i18n/dispatch.js'
import * as D from '../src/core/i18n/dispatch.js'
import { EconomyBalance } from '../src/core/companion/economy.js'
import { compact } from '../src/core/tokenFormatter.js'
import { progressOf } from '../src/core/companion/registry.js'
import { STARTERS } from '../src/core/companion/starters.js'
import { MEDALS } from '../src/core/companion/medals.js'
import { EncounterBalance } from '../src/core/companion/encounters.js'
import { isoWeekKey } from '../src/core/companion/challenges.js'
import {
  StreakBalance,
  attackPermille,
  encounterCatchChance,
  fleePermille,
} from '../src/core/companion/encounters.js'
import { todayKey } from '../src/core/usage/entry.js'

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

/** A game that has begun with an egg on stage: what the shop sells guarantees for. */
const incubating = {
  ...freshCompanionState('en'),
  species: { 1: { ...freshSpeciesProgress(), unlocked: true } },
  eggUsage: 1_000,
} as CompanionState

/** Any Pokémon on stage. */
const activeMon: MonState = {
  baseID: 25,
  pathIDs: [25],
  plannedPathIDs: [25, 26],
  stageIndex: 0,
  usedAtStage: 0,
  rarity: 'common',
  totalForms: 2,
  isShiny: false,
  dittoRevealed: false,
}

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

  // [trigger branch] The odds shown are the odds rolled — an angry Pokémon's mood is in the number.
  it('prices the balls with the mood the encounter is in, exactly as the throw rolls', () => {
    const angry = wild({ captureRate: 45, mood: { anger: 90, nervousness: 30, trust: 0 } })
    const panel = build({ state: state({ wild: [angry] }) })
    const poke = panel.wild.balls.find((b) => b.kind === 'pokeBall')!
    const expected = encounterCatchChance(angry, 'pokeBall') * 100
    expect(poke.oddsText).toBe(
      `${expected >= 10 ? Math.round(expected) : Math.round(expected * 10) / 10}%`,
    )
    const calm = build({ state: state({ wild: [wild({ captureRate: 45 })] }) })
    expect(calm.wild.balls.find((b) => b.kind === 'pokeBall')!.oddsText).not.toBe(poke.oddsText)
  })

  it('states the reaction risk from the same permille the roll is held to', () => {
    const e = wild({ captureRate: 45, mood: { anger: 40, nervousness: 50, trust: 0 } })
    const row = build({ state: state({ wild: [e] }) }).wild.encounters[0]!
    expect(row.riskText).toContain(`${Math.round(fleePermille(e) / 10)}%`)
    expect(row.riskText).toContain(`${Math.round(attackPermille(e) / 10)}%`)
    expect(row.meters.map((m) => m.percent)).toEqual([40, 50, 0])
  })

  // The same two figures as riskText, one part each, so the dialog can lead each with its glyph
  // without splitting a localised sentence.
  it('splits the reaction risk into a heading and one part per reaction, in order', () => {
    const e = wild({ captureRate: 45, mood: { anger: 40, nervousness: 50, trust: 0 } })
    const row = build({ state: state({ wild: [e], language: 'es' }) }).wild.encounters[0]!
    const flee = `${Math.round(fleePermille(e) / 10)}%`
    const attack = `${Math.round(attackPermille(e) / 10)}%`
    expect(row.risk.heading).toBe('Si se libera')
    expect(row.risk.items).toEqual([
      { key: 'flee', text: `huida ${flee}` },
      { key: 'attack', text: `ataque ${attack}` },
    ])
    expect(row.riskText).toBe(`Si se libera: huida ${flee} · ataque ${attack}`)
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

describe('wild statuses', () => {
  // A primed berry and stolen tokens are statuses on the plate; the dialog keeps to the question.
  it('turns a primed berry and stolen tokens into plate chips, with the sentence behind each', () => {
    const row = build({ state: state({ wild: [wild({ primed: true, stolen: 4_000_000 })] }) }).wild
      .encounters[0]!
    expect(row.statuses.map((s) => s.key)).toEqual(['primed', 'stolen'])
    expect(row.statuses[1]!.text).toContain('4M')
    expect(row.statuses[1]!.title).toBe(row.stolenText)
    expect(build({ state: state({ wild: [wild()] }) }).wild.encounters[0]!.statuses).toEqual([])
  })

  it('counts who waits behind the one on stage, and says nothing when it is alone', () => {
    expect(
      build({ state: state({ wild: [wild({ id: 'a' }), wild({ id: 'b' }), wild({ id: 'c' })] }) }).wild
        .moreText,
    ).toContain('2')
    expect(build({ state: state({ wild: [wild()] }) }).wild.moreText).toBeUndefined()
  })

  // Plan 9.4: Home's Wild drawer lists the next few in rows, then one row for the rest. The one
  // on stage is in the scene above, so the drawer starts behind it.
  it('lists the next few behind the one on stage, and counts the rest in one line', () => {
    const queue = (n: number) =>
      build({ state: state({ wild: Array.from({ length: n }, (_, i) => wild({ id: `w${i}` })) }) }).wild
    const shown = queue(1).queueShown
    expect(shown).toBe(3)
    // Stage + exactly `shown` behind it: every one has its row, nothing left to count.
    expect(queue(1 + shown).queueMoreText).toBeUndefined()
    // [trigger branch] One more than fits: the row says one, in the drawer's words.
    expect(queue(2 + shown).queueMoreText).toBe(D.moreWaitingText('en', 1))
    expect(queue(30).queueMoreText).toBe(D.moreWaitingText('en', 30 - 1 - shown))
  })
})

describe('the terrain', () => {
  // The scenery follows the primary type; an encounter whose type never arrived (an old save, a
  // failed `/pokemon` request) keeps the rarity scenery it always had.
  it('meets a Pokémon on the terrain of its primary type', () => {
    const row = (over: Partial<WildEncounter>) =>
      build({ state: state({ wild: [wild(over)] }) }).wild.encounters[0]!
    expect(row({ types: ['bug', 'flying'] }).terrain).toBe('bug')
    expect(row({ types: undefined, rarity: 'rare' }).terrain).toBe('rare')
  })
})

describe('the wallet', () => {
  const rich = state({ usedSinceInstall: 50_000_000, spentTokens: 0 })

  it('signs and formats a change in the balance', () => {
    expect(build({ state: rich, walletChange: { previous: 40_000_000, id: 7 } }).walletChange).toEqual({
      id: 7,
      text: '+10M',
      kind: 'gain',
    })
    expect(build({ state: rich, walletChange: { previous: 54_000_000, id: 8 } }).walletChange).toEqual({
      id: 8,
      text: '\u22124M',
      kind: 'loss',
    })
  })

  // [trigger branch] A change that nets to zero is no change: nothing to animate.
  it('says nothing when the balance did not move', () => {
    expect(
      build({ state: rich, walletChange: { previous: 50_000_000, id: 9 } }).walletChange,
    ).toBeUndefined()
    expect(build({ state: rich }).walletChange).toBeUndefined()
  })
})

describe('the bag', () => {
  // The pocket is decided in the core from the item kind, so the webview only draws tabs.
  it('files every owned item into the pocket its kind belongs to', () => {
    const panel = build({
      state: state({ inventory: { pokeBall: 2, masterBall: 1, razzBerry: 3, rareCandy: 1, mint: 1 } }),
    })
    const pocketOf = (id: string) => panel.bag.find((item) => item.id === id)?.pocket
    expect(pocketOf('item:pokeBall')).toBe('balls')
    expect(pocketOf('item:masterBall')).toBe('balls')
    expect(pocketOf('item:razzBerry')).toBe('berries')
    expect(pocketOf('item:rareCandy')).toBe('items')
    expect(pocketOf('item:mint')).toBe('items')
  })

  // [trigger branch] Candies in hand, the line loaded, and still unusable: the species on stage
  // has had its share. Without the hint the greyed-out Use button reads as a bug.
  it('explains a candy the species on stage can no longer take', () => {
    const candy = (candiesUsed: number) =>
      build({
        state: state({
          active: activeMon,
          inventory: { rareCandy: 1 },
          species: { 25: { ...progressOf(state(), 25), unlocked: true, candiesUsed } },
        }),
        line: makeEvoLine(
          25,
          { speciesID: 25, children: [{ speciesID: 26, children: [] }] },
          'common',
          {},
        ),
      }).bag.find((item) => item.id === 'item:rareCandy')!
    const full = candy(RareCandy.maxPerSpecies)
    expect(full.usable).toBe(false)
    expect(full.hint).toBe(candyFullHint('en'))
    const room = candy(RareCandy.maxPerSpecies - 1)
    expect(room.usable).toBe(true)
    expect(room.hint).toBeUndefined()
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
  const rowFor = (id: string, over: Partial<Parameters<typeof buildPanelState>[0]> = {}) =>
    build(over).shop.find((item) => item.id === id)

  it('offers ten-packs for every ball except the Master, with the ids the host accepts', () => {
    // `parseEntryID` takes `item:<kind>` and `item:<kind>:<bundleSize>` and rejects everything
    // else, so grouping the two prices onto one row must not have moved either id.
    const ids = build().shop.flatMap((item) => item.actions.map((a) => a.id))
    expect(ids).toContain(`item:pokeBall:${Pokeball.bundleSize}`)
    expect(ids).toContain(`item:ultraBall:${Pokeball.bundleSize}`)
    expect(ids).not.toContain(`item:masterBall:${Pokeball.bundleSize}`)
    expect(ids).toContain('item:masterBall')
  })

  // [trigger branch] A ball and its ten-pack were two cards, and the ten-pack's card had nothing
  // of its own to say: its description was the same generated sentence on all three of them.
  it('sells each ball from one row carrying both quantities', () => {
    const balls = build().shop.filter((item) => item.group === 'balls')
    expect(balls).toHaveLength(4)
    const poke = balls.find((item) => item.id === 'item:pokeBall')!
    expect(poke.actions.map((a) => a.id)).toEqual([
      'item:pokeBall',
      `item:pokeBall:${Pokeball.bundleSize}`,
    ])
    // The Master Ball is sold singly on purpose, so its row stays a one-price row.
    expect(rowFor('item:masterBall')!.actions).toHaveLength(1)
  })

  // Plan 9.1: the ten-pack steps ×10, ×20 … ×100, so a big restock is not ten confirmations.
  // Every step is priced and labelled here; the webview only walks the list.
  it('steps the ten-pack from ×10 to ×100, each step priced by the till', () => {
    const pack = rowFor('item:pokeBall')!.actions[1]!
    const quantities = packQuantities()
    expect(quantities).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(pack.packs!.map((p) => p.id)).toEqual(quantities.map((q) => `item:pokeBall:${q}`))
    for (const [i, step] of pack.packs!.entries()) {
      const quantity = quantities[i]!
      const price = shopEntryPrice({ kind: 'item', item: 'pokeBall', quantity })
      expect(step.price).toBe(price)
      expect(step.priceText).toBe(compact(price))
      expect(step.text).toBe(`×${quantity}`)
      expect(step.confirmTitle).toContain(`×${quantity}`)
      expect(step.label).toContain(step.priceText)
      expect(step.saveText).toBe(pack.saveText)
    }
    // The first step is the ten-pack the row already shows.
    expect(pack.packs![0]!.id).toBe(pack.id)
    expect(pack.packs![0]!.priceText).toBe(pack.priceText)
    expect(new Set(pack.packs!.map((p) => p.label)).size).toBe(quantities.length)
    // The single and the Master Ball are not packs.
    expect(rowFor('item:pokeBall')!.actions[0]!.packs).toBeUndefined()
    expect(rowFor('item:masterBall')!.actions[0]!.packs).toBeUndefined()
  })

  // [trigger branch] Each step is checked against the wallet on its own: enough for ×10 is not
  // enough for ×20.
  it('enables each step by what the wallet covers', () => {
    const ten = shopEntryPrice({ kind: 'item', item: 'pokeBall', quantity: 10 })
    const steps = build({ state: state({ usedSinceInstall: ten }) }).shop.find(
      (item) => item.id === 'item:pokeBall',
    )!.actions[1]!.packs!
    expect(steps[0]!.enabled).toBe(true)
    expect(steps[1]!.enabled).toBe(false)
  })

  // Grouping is only an improvement while the ten-pack is still visibly the cheaper ball: fold
  // the two prices together and drop the saving, and the reader has to divide to find it.
  it('marks the bundle saving, derived from what the till actually charges', () => {
    const [single, bundle] = rowFor('item:pokeBall')!.actions
    const discount = Math.round(100 * (1 - Pokeball.bundleMultiplier / Pokeball.bundleSize))
    expect(bundle!.saveText).toBe(`−${discount}%`)
    expect(bundle!.label).toContain(String(discount))
    // Not a literal: the badge has to follow the constants the price is computed from.
    expect(shopEntryPrice({ kind: 'item', item: 'pokeBall', quantity: Pokeball.bundleSize })).toBe(
      Math.round((5_000_000 * Pokeball.bundleSize * Pokeball.bundleMultiplier) / Pokeball.bundleSize),
    )
    expect(single!.saveText).toBeUndefined()
  })

  // Two buttons on one row are announced by their own names, never by the card around them.
  it('gives every action on a row a distinguishable accessible name', () => {
    for (const item of build({ state: state({ active: activeMon }) }).shop) {
      const labels = item.actions.map((a) => a.label)
      expect(new Set(labels).size).toBe(labels.length)
      for (const action of item.actions) {
        expect(action.label).toContain(action.priceText)
        expect(action.label.trim()).not.toBe('')
        // The confirmation the host raises names the quantity being bought, not the row.
        expect(action.confirmTitle.trim()).not.toBe('')
      }
    }
    const [single, bundle] = rowFor('item:greatBall')!.actions
    expect(bundle!.confirmTitle).toContain(`×${Pokeball.bundleSize}`)
    expect(single!.confirmTitle).not.toContain('×')
  })

  // [trigger branch] "The standard ball for throwing at a wild Pokémon", under a POKÉ BALLS
  // heading, beside a Poké Ball sprite, in a shop. The catch multiplier is the only thing a ball
  // row can say that changes a decision, and it is a figure.
  it('states a ball as a stat and keeps prose only where it is not a number', () => {
    expect(rowFor('item:pokeBall')!.stat).toBe('1×')
    expect(rowFor('item:greatBall')!.stat).toBe('1.5×')
    expect(rowFor('item:ultraBall')!.stat).toBe('2×')
    for (const id of ['item:pokeBall', 'item:greatBall', 'item:ultraBall']) {
      expect(rowFor(id)!.description).toBeUndefined()
      // A bare "1.5×" says a number, not a fact, to a screen reader.
      expect(rowFor(id)!.statLabel?.trim()).toBeTruthy()
    }
    // The Master Ball's behaviour is not a multiplier, so it keeps the sentence — and it is the
    // only ball sentence that gives advice.
    expect(rowFor('item:masterBall')!.stat).toBeUndefined()
    expect(rowFor('item:masterBall')!.description).toContain('legendary')
    // Items were never the problem: their descriptions are the whole reason to buy them.
    expect(rowFor('item:rareCandy')!.description).toContain(`${Math.round(RareCandy.stageShare * 100)}%`)
    expect(rowFor('item:mint')!.description?.trim()).toBeTruthy()
  })

  // [trigger branch] All three eggs opened with "Send off your current Pokémon…" — the price
  // they share, said three times, while the guarantee that separates them trailed at the end.
  it('leaves each egg only its guarantee, with the shared clause on the heading', () => {
    const panel = build({ state: incubating })
    const eggs = panel.shop.filter((item) => item.group === 'eggs')
    expect(eggs).toHaveLength(FreshEgg.shopTiers.length + 1) // the egg itself, then its guarantees
    const lines = eggs.map((e) => e.description!)
    expect(new Set(lines).size).toBe(eggs.length)
    // The shared clause lives once, on the group note.
    expect(panel.strings.shopEggsNote).toContain('incubating')
    for (const line of lines) {
      expect(panel.strings.shopEggsNote).not.toContain(line)
      // Short enough to sit on the one line a card now gets.
      expect(line.length).toBeLessThanOrEqual(24)
    }
    expect(lines.some((l) => l.includes('Uncommon or better'))).toBe(true)
  })

  // The eggs were the one row drawn as an emoji beside a shelf of sprites. The emoji stays as
  // the fallback for a sprite that fails to load.
  it('gives every egg row the egg sprite, with the emoji behind it', () => {
    const eggs = build({ state: incubating }).shop.filter((item) => item.group === 'eggs')
    expect(eggs).toHaveLength(FreshEgg.shopTiers.length + 1)
    for (const egg of eggs) {
      expect(egg.sprite).toBe('egg-icon') // the menu egg, at the item sprites' scale
      expect(egg.emoji).toBe('🥚')
    }
  })

  // [trigger branch] The eggs are always on the shelf once the game has begun (Diego): the egg to
  // the stock, and the guarantees greyed out until an egg is incubating — they are for that egg.
  // Nothing before the starter.
  it('lists the egg and its guarantees, the guarantees live only while one incubates', () => {
    const rich = { ...incubating, usedSinceInstall: 10_000_000_000 }
    const withCompanion = { ...rich, active: activeMon, eggUsage: 0 }
    const enabled = (s: CompanionState) =>
      build({ state: s })
        .shop.filter((item) => item.group === 'eggs')
        .map((item) => [item.id, item.actions[0]!.enabled])
    expect(enabled(rich)).toEqual([
      ['egg:any', true],
      ['egg:uncommon', true],
      ['egg:rare', true],
    ])
    expect(enabled(withCompanion)).toEqual([
      ['egg:any', true],
      ['egg:uncommon', false],
      ['egg:rare', false],
    ])
    expect(build().shop.some((item) => item.group === 'eggs')).toBe(false)
  })

  it('assigns every row to a rendered group and prices every action', () => {
    for (const item of build().shop) {
      expect(['balls', 'berries', 'items', 'eggs']).toContain(item.group)
      expect(item.actions.length).toBeGreaterThan(0)
      for (const action of item.actions) expect(action.priceText).not.toBe('')
    }
  })

  it('says a passive is owned on the action itself, not only by greying it', () => {
    const owned = build({ state: state({ inventory: { shinyCharm: 1 } }) })
    const charm = owned.shop.find((item) => item.id === 'item:shinyCharm')!
    expect(charm.owned).toBe(true)
    expect(charm.actions[0]!.enabled).toBe(false)
    expect(charm.actions[0]!.text).toBe(owned.strings.owned)
    expect(charm.actions[0]!.label).toContain(charm.title)
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

// The catch log is ordered by time because it is a record, so rarity stopped being its sort
// key — and the narrowing that was supposed to replace it was never built: `dexCount` sat
// unused in dexView.ts behind a comment claiming the filter existed. These chips are it.
describe('catch-log rarity chips', () => {
  const caught = (id: number, rarity: 'common' | 'rare' | 'legendary') => ({
    id: `e${id}`,
    baseID: id,
    finalID: id,
    chainOrder: [id],
    rarity,
    caughtAt: NOW - id * 1000,
    isShiny: false,
  })

  it('counts each tier the log actually holds, newest chip order aside', () => {
    const panel = build({
      state: state({ dex: [caught(1, 'common'), caught(2, 'common'), caught(3, 'legendary')] }),
    })
    expect(panel.dexLogFilters.map((f) => [f.id, f.count])).toEqual([
      ['all', 3],
      ['common', 2],
      ['legendary', 1],
    ])
  })

  // A chip that filters to nothing is a control that does nothing.
  it('leaves out a tier with no entries', () => {
    const panel = build({ state: state({ dex: [caught(1, 'common')] }) })
    expect(panel.dexLogFilters.map((f) => f.id)).toEqual(['all', 'common'])
  })

  it('offers only the all chip for an empty log', () => {
    expect(build().dexLogFilters).toEqual([{ id: 'all', label: 'All', count: 0 }])
  })

  // The webview narrows on this token; `rarityText` is the localised label and must never be
  // what a filter compares against.
  it('gives every log row a rarity token beside its label', () => {
    const panel = build({ state: state({ dex: [caught(1, 'legendary')] }) })
    expect(panel.dexLog[0]).toMatchObject({ rarity: 'legendary', rarityText: 'Legendary' })
  })

  // The active Pokémon is synthesised into the log, so it has to be counted like the rest.
  it('counts the Pokémon being raised', () => {
    const raising = state({
      active: {
        baseID: 25,
        pathIDs: [25],
        plannedPathIDs: [25],
        stageIndex: 0,
        usedAtStage: 0,
        rarity: 'uncommon',
        totalForms: 1,
        isShiny: false,
        dittoRevealed: false,
      },
    })
    const panel = build({ state: raising })
    expect(panel.dexLogFilters).toContainEqual({ id: 'uncommon', label: 'Uncommon', count: 1 })
  })
})

// The streak row: seven dots and one short line, beside the "to the next encounter" bar. The
// webview draws what is here and nothing else — every day count, date comparison and sentence
// is decided in the core, so all four states have to be reachable from this side.
describe('the streak row', () => {
  /** `n` days before the panel's own clock, as the local day key the ledger speaks. */
  const daysAgo = (n: number) => todayKey(NOW - n * 86_400_000)
  const streak = (over: Partial<CompanionState>) => build({ state: state(over) }).wild.streak

  it('draws one dot per day of the window, all empty on a fresh install', () => {
    const row = streak({})
    expect(row.days).toHaveLength(StreakBalance.windowDays)
    expect(new Set(row.days)).toEqual(new Set(['off']))
    expect(row.text).toBe('0 / 3 days')
    expect(row.value).toBe(0)
    expect(row.max).toBe(StreakBalance.days)
    expect(row.earned).toBe(false)
  })

  // Oldest first, ending today: the row reads left to right like a week, so today is the last
  // dot and a day that has fallen out of the window is simply not drawn.
  it('fills the days that accrued, in calendar order, ending today', () => {
    const row = streak({ accrualDays: [daysAgo(3), daysAgo(0)] })
    expect(row.days).toEqual(['off', 'off', 'off', 'on', 'off', 'off', 'on'])
    expect(row.text).toBe('2 / 3 days')
    expect(row.value).toBe(2)
    expect(row.earned).toBe(false)
  })

  it('does not draw or count a day that has left the window', () => {
    const row = streak({ accrualDays: [daysAgo(StreakBalance.windowDays), daysAgo(0)] })
    expect(row.days.filter((d) => d !== 'off')).toHaveLength(1)
    expect(row.text).toBe('1 / 3 days')
  })

  // The payout is marked on the day it actually happened, not on "the third filled dot" —
  // those coincide the day it fires and diverge every day after.
  it('marks the day the legendary was earned and stops counting', () => {
    const row = streak({
      accrualDays: [daysAgo(2), daysAgo(1), daysAgo(0)],
      lastStreakAwardDate: daysAgo(0),
    })
    expect(row.days).toEqual(['off', 'off', 'off', 'off', 'on', 'on', 'award'])
    expect(row.text).toBe('Legendary earned!')
    expect(row.earned).toBe(true)
  })

  // Work carries on after the week has paid out. The row greys rather than resetting, and the
  // count must not read "5 of 3".
  it('keeps the earned state while the window runs on, clamping the value', () => {
    const row = streak({
      accrualDays: [daysAgo(4), daysAgo(3), daysAgo(2), daysAgo(1), daysAgo(0)],
      lastStreakAwardDate: daysAgo(2),
    })
    expect(row.days).toEqual(['off', 'off', 'on', 'on', 'award', 'on', 'on'])
    expect(row.earned).toBe(true)
    expect(row.value).toBe(StreakBalance.days)
    expect(row.value).toBeLessThanOrEqual(row.max)
  })

  it('clears once the award has left the window', () => {
    const row = streak({
      accrualDays: [daysAgo(0)],
      lastStreakAwardDate: daysAgo(StreakBalance.windowDays),
    })
    expect(row.earned).toBe(false)
    expect(row.text).toBe('1 / 3 days')
  })

  it('has an accessible name and follows the panel language', () => {
    expect(streak({}).label).toBe("This week's streak")
    expect(build({ state: state({ language: 'es' }) }).wild.streak.text).toBe('0 / 3 días')
  })
})

// Phase 2: the registry on the panel — every Pokédex cell's state and bar, who can be chosen,
// the first-run starter screen and the egg stock.
describe('companion choice', () => {
  const progress = (over: Partial<SpeciesProgress> = {}): SpeciesProgress => ({
    ...progressOf(state(), 0),
    ...over,
  })

  it('gives every Pokédex cell its state, its bar and whether it can be chosen', () => {
    const panel = build({
      state: state({
        active: activeMon,
        species: {
          4: progress({ seen: true }),
          7: progress({ unlocked: true, xp: 4_000_000, threshold: 8_000_000 }),
          25: progress({ unlocked: true }),
          26: progress({ unlocked: true, registered: true }),
        },
      }),
    })
    const cell = (id: number) => panel.dexSpecies.find((sp) => sp.id === id)!
    expect(cell(4)).toMatchObject({ status: 'seen', canChoose: false, isCompanion: false, percent: 0 })
    expect(cell(7)).toMatchObject({
      status: 'unlocked',
      canChoose: true,
      percent: 50,
      percentText: '50% registered',
    })
    // [trigger branch] Unlocked, but already on stage: choosing it again would do nothing.
    expect(cell(25)).toMatchObject({ canChoose: false, isCompanion: true })
    expect(cell(26)).toMatchObject({
      status: 'registered',
      percent: 100,
      percentText: 'Registered',
      canChoose: true,
    })
  })

  it('offers the starters on a brand-new save only', () => {
    const fresh = build({ state: state() })
    expect(fresh.starters?.map((s) => s.id)).toEqual([...STARTERS])
    expect(fresh.starters?.[1]?.types).toEqual(['fire'])
    expect(fresh.starters?.[1]?.name).toBe('Charmander')
    // [trigger branch] Each condition alone closes the screen.
    expect(build({ state: state({ active: activeMon }) }).starters).toBeUndefined()
    expect(build({ state: state({ eggUsage: 1 }) }).starters).toBeUndefined()
    expect(build({ state: state({ pendingHatchID: 4 }) }).starters).toBeUndefined()
    expect(build({ state: state({ eggTier: 'rare' }) }).starters).toBeUndefined()
    expect(
      build({ state: state({ species: { 1: progress({ unlocked: true }) } }) }).starters,
    ).toBeUndefined()
    // Seen in the wild is not obtained: encounters spawn on a new game too.
    expect(build({ state: state({ species: { 16: progress({ seen: true }) } }) }).starters).toBeDefined()
  })

  it('shows the egg stock and offers to incubate only with a companion on stage', () => {
    const none = build({ state: state({ active: activeMon }) }).eggs
    expect(none).toMatchObject({ count: 0, max: EGG_STOCK_MAX, paused: false })
    expect(none.incubateText).toBeUndefined()

    const stocked = build({ state: state({ active: activeMon, eggStock: { count: 2 } }) }).eggs
    expect(stocked).toMatchObject({
      count: 2,
      stockText: '2 eggs in stock',
      incubateText: 'Incubate an egg',
    })
    // Incubating already, there is nothing to offer: the egg is on stage.
    expect(
      build({ state: state({ eggStock: { count: 2 }, eggUsage: 1 }) }).eggs.incubateText,
    ).toBeUndefined()
  })

  // [trigger branch] A companion chosen mid-incubation leaves the egg waiting, with no stock.
  it('offers to resume a paused egg even with an empty stock', () => {
    const paused = build({ state: state({ active: activeMon, eggUsage: 2_000_000 }) }).eggs
    expect(paused).toMatchObject({ paused: true, incubateText: 'Resume the egg' })
    const hatching = build({ state: state({ active: activeMon, pendingHatchID: 4 }) }).eggs
    expect(hatching).toMatchObject({ paused: true, incubateText: 'Resume the egg' })
    // A paid guarantee alone is progress: with no Resume, the tokens spent on it would be lost.
    const guaranteed = build({ state: state({ active: activeMon, eggTier: 'rare' }) }).eggs
    expect(guaranteed).toMatchObject({ paused: true, incubateText: 'Resume the egg' })
  })

  it('puts the companion species registration on the player plate', () => {
    const panel = build({
      state: state({
        active: activeMon,
        species: { 25: progress({ unlocked: true, xp: 2_000_000, threshold: 8_000_000 }) },
      }),
      usage: usage(view()),
    })
    expect(panel.companion?.registrationPercent).toBe(25)
  })
})

/** A registry entry with only what a test names. */
const speciesEntry = (over: Partial<SpeciesProgress> = {}): SpeciesProgress => ({
  ...progressOf(state(), 0),
  ...over,
})

describe('the EXP bar', () => {
  const T = PokemonBalance.phaseThreshold('common', 2, 0)
  const quarter = Math.round(T / 4)

  // What it has and what is left, formatted here: the webview paints them in the bar's colour
  // and derives nothing.
  it('says what the companion has and what is left to its next stage', () => {
    const panel = build({
      state: state({ active: { ...activeMon, usedAtStage: quarter } }),
      usage: usage(view()),
    })
    expect(panel.companion).toMatchObject({
      expPercent: 25,
      expText: `${compact(quarter)} / ${compact(T)}`,
      expLeftText: D.expLeftText('en', compact(T - quarter)),
    })
  })

  it('counts an egg toward its hatch', () => {
    const egg = state({
      species: { 1: speciesEntry({ unlocked: true }) },
      eggUsage: PokemonBalance.eggHatchThreshold / 2,
    })
    const panel = build({ state: egg, usage: usage(view({ speciesID: undefined, name: undefined })) })
    expect(panel.companion).toMatchObject({
      expPercent: 50,
      expText: `${compact(PokemonBalance.eggHatchThreshold / 2)} / ${compact(PokemonBalance.eggHatchThreshold)}`,
    })
  })

  // [trigger branch] Nothing left to earn: a registered form with its meter full reads as
  // registered, not "0 left".
  it('reads a full, registered form as registered', () => {
    const panel = build({
      state: state({
        active: { ...activeMon, usedAtStage: T },
        species: { 25: speciesEntry({ unlocked: true, registered: true, xp: T, threshold: T }) },
      }),
      usage: usage(view()),
    })
    expect(panel.companion?.expPercent).toBe(100)
    expect(panel.companion?.expLeftText).toBe(D.registrationText('en', 100, true))
  })
})

describe('the wild plate’s Poké Ball', () => {
  // [trigger branch] Owned, not registered: a species caught once (5%) already shows the ball,
  // as the games mark what you have caught.
  it('marks a species already obtained, and only that', () => {
    const owned = build({
      state: state({ wild: [wild()], species: { 147: speciesEntry({ unlocked: true, xp: 1 }) } }),
    }).wild.encounters[0]!
    expect(owned.ownedText).toBe(D.ownedText('en'))
    const seen = build({
      state: state({ wild: [wild()], species: { 147: speciesEntry({ seen: true }) } }),
    }).wild.encounters[0]!
    expect(seen.ownedText).toBeUndefined()
  })
})

describe('the Pokédex summary', () => {
  // [trigger branch] A seen species is in the list but owned by nobody: counting the list would
  // put it in the collection.
  it('sends the counts already formatted, seen species left out of the collection', () => {
    const panel = build({
      state: state({
        species: {
          1: { ...progressOf(state(), 1), seen: true },
          2: { ...progressOf(state(), 2), unlocked: true },
          3: { ...progressOf(state(), 3), unlocked: true, registered: true },
        },
      }),
    })
    expect(panel.dexSummary).toMatchObject({
      owned: 2,
      registered: 1,
      total: ANIMATED_SPECIES_MAX,
      percent: 0,
      progressText: `1 / ${ANIMATED_SPECIES_MAX}`,
      speciesSegmentText: `${panel.strings.segmentSpecies} (2)`,
      logSegmentText: `${panel.strings.segmentLog} (0)`,
    })
  })

  // Four of 649 is 0.62%: rounded, the bar shows a sliver; floored, it would read empty.
  it('rounds the completion bar rather than flooring it', () => {
    const species = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [
        i + 1,
        { ...progressOf(state(), i + 1), unlocked: true, registered: true },
      ]),
    )
    expect(build({ state: state({ species }) }).dexSummary.percent).toBe(1)
  })
})

describe('the catch banner', () => {
  // [trigger branch] A first catch carries its bar before and after, for the reveal; a duplicate
  // has no bar to fill.
  it('gives a first catch its species and its bar before and after', () => {
    const before = state({ species: { 147: speciesEntry({ seen: true }) } })
    const banner = catchBanner('en', before, 147, { kind: 'caught', refunded: 0, registeredPercent: 5 })
    expect(banner).toMatchObject({
      isNew: true,
      registration: { speciesID: 147, fromPercent: 0, toPercent: 5 },
    })
    // [trigger branch] The detail says what this catch added, not where the bar now stands.
    const partway = state({ species: { 147: speciesEntry({ seen: true, xp: 400, threshold: 1_000 }) } })
    const gained = catchBanner('en', partway, 147, { kind: 'caught', refunded: 0, registeredPercent: 45 })
    expect(gained.registration).toMatchObject({ fromPercent: 40, toPercent: 45 })
    expect(gained.detail).toBe(D.catchShareText('en', 5))
    const dup = catchBanner('en', before, 147, { kind: 'caught', refunded: 0, reward: 2_000_000 })
    expect(dup.isNew).toBe(false)
    expect(dup.registration).toBeUndefined()
  })
})

describe('the finished-companion setting', () => {
  // Absent in the save means the default — move on — and the panel says so.
  it('reads the setting off the save, moving on by default', () => {
    expect(build().keepCompletedCompanion).toBe(false)
    expect(build({ state: state({ keepCompletedCompanion: true }) }).keepCompletedCompanion).toBe(true)
  })
})

describe('the shiny bar in the Pokédex', () => {
  const target = 8 * PokemonBalance.graduationTotal('common')
  const registered = (over: Partial<SpeciesProgress> = {}) =>
    speciesEntry({
      unlocked: true,
      registered: true,
      xp: 1_000,
      threshold: 1_000,
      lineRarity: 'common',
      ...over,
    })
  const cell = (s: CompanionState, id = 7) => build({ state: s }).dexSpecies.find((c) => c.id === id)!

  // [trigger branch] No bar before the species is registered: there is nothing to fill yet.
  it('has no shiny bar for a species not registered', () => {
    expect(
      cell(state({ species: { 7: speciesEntry({ unlocked: true, xp: 10 }) } })).shinyBar,
    ).toBeUndefined()
  })

  it('shows how far the bar is, and offers a tenth and the most that can be bought', () => {
    const s = state({
      usedSinceInstall: 10_000_000_000,
      species: { 7: registered({ shinyXP: target * 0.3 }) },
    })
    const bar = cell(s).shinyBar!
    expect(bar.percent).toBe(30)
    expect(bar.text).toBe(D.shinyBarText('en', 30, compact(target * 0.3), compact(target)))
    expect(bar.boosts.map((b) => b.amount)).toEqual([target / 10, target / 2])
    expect(bar.boosts[0]).toMatchObject({
      text: `+${compact(target / 10)}`,
      priceText: compact(target / 10),
    })
    expect(bar.boostHint).toBeUndefined()
  })

  // [trigger branch] Nothing to buy says why: the wallet is empty, or half the bar was bought.
  it('says why nothing can be bought', () => {
    expect(cell(state({ species: { 7: registered() } })).shinyBar?.boostHint).toBe(
      D.shinyBoostNoFundsText('en'),
    )
    const capped = state({
      usedSinceInstall: 10_000_000_000,
      species: { 7: registered({ shinyXP: target / 2, shinyBoosted: target / 2 }) },
    })
    expect(cell(capped).shinyBar?.boostHint).toBe(D.shinyBoostCappedText('en', 50))
  })

  // [trigger branch] A shiny caught before the species is registered: its Shinydex entry is
  // complete, and the cell must say so rather than draw an empty bar.
  it('gives a registered shiny its full bar even before the species is registered', () => {
    const shinyFirst = state({
      species: { 7: speciesEntry({ unlocked: true, shinyUnlocked: true, shinyRegistered: true }) },
    })
    expect(cell(shinyFirst).shinyBar).toMatchObject({ percent: 100, text: D.shinyRegisteredText('en') })
  })

  it('reads a registered shiny as done, with nothing to sell', () => {
    const bar = cell(
      state({ species: { 7: registered({ shinyRegistered: true, shinyXP: target }) } }),
    ).shinyBar!
    expect(bar).toMatchObject({ percent: 100, text: D.shinyRegisteredText('en'), boosts: [] })
    expect(bar.boostHint).toBeUndefined()
  })

  it('counts the Shinydex in the summary', () => {
    const s = state({
      species: {
        7: registered({ shinyRegistered: true }),
        8: registered(),
        9: speciesEntry({ unlocked: true, shinyUnlocked: true }),
      },
    })
    const summary = build({ state: s }).dexSummary
    expect(summary).toMatchObject({
      shinyRegistered: 1,
      shinyPercent: Math.min(100, Math.round(100 / ANIMATED_SPECIES_MAX)),
      shinyProgressText: D.dexProgressText(1, ANIMATED_SPECIES_MAX),
    })
    expect(summary.shinySegmentText).toContain('(1)')
  })
})

describe('the lure in the panel', () => {
  const seen = (over: Partial<SpeciesProgress> = {}) =>
    speciesEntry({ seen: true, baseID: 4, stageIndex: 1, totalForms: 3, lineRarity: 'rare', ...over })
  const cell = (s: CompanionState, id = 5) => build({ state: s }).dexSpecies.find((c) => c.id === id)!
  const price = compact(EconomyBalance.lure.price.rare!)

  it('offers a lure on a seen species, priced, and greyed when the wallet is short', () => {
    const rich = cell(state({ usedSinceInstall: 10_000_000_000, species: { 5: seen() } })).lure!
    expect(rich).toMatchObject({ priceText: price, enabled: true, text: D.lureButtonText('en', 24) })
    expect(cell(state({ species: { 5: seen() } })).lure?.enabled).toBe(false)
    expect(cell(state({ species: { 5: seen({ unlocked: true }) } })).lure).toBeUndefined()
  })

  // [trigger branch] Buying one while another runs replaces it: the confirmation says so.
  it('says a new lure replaces the one running', () => {
    const lure = { speciesID: 7, baseID: 7, stageIndex: 0, until: NOW + 3_600_000 }
    const s = state({ usedSinceInstall: 10_000_000_000, species: { 5: seen() }, lure })
    expect(cell(s).lure?.confirmTitle).toBe(D.lureConfirmTitle('en', '#5', true))
  })

  // [trigger branch] A lure whose day is over, not yet cleared by a refresh, replaces nothing.
  it('does not warn of replacing a lure whose day is over', () => {
    const over = { speciesID: 7, baseID: 7, stageIndex: 0, until: NOW }
    const s = state({ usedSinceInstall: 10_000_000_000, species: { 5: seen() }, lure: over })
    expect(cell(s).lure?.confirmTitle).toBe(D.lureConfirmTitle('en', '#5', false))
  })

  // A seen species is shown as "?????" in the Pokédex: the lure names it by number, never by the
  // name the card keeps hidden.
  it('names a lured species by its number, as the card hides its name', () => {
    const s = state({ usedSinceInstall: 10_000_000_000, species: { 5: seen() } })
    expect(cell(s).lure?.label).toBe(
      D.lureLabel('en', '#5', 24, compact(EconomyBalance.lure.price.rare!)),
    )
  })

  it('shows the lure running on Home with the hours left, and nothing once it is over', () => {
    const lure = { speciesID: 5, baseID: 4, stageIndex: 1, until: NOW + 5 * 3_600_000 - 1 }
    const panel = build({ state: state({ species: { 5: seen() }, lure }) })
    expect(panel.lure).toEqual({
      speciesID: 5,
      text: D.lureActiveText('en', cell(state({ species: { 5: seen() } })).name, 5),
    })
    expect(
      build({ state: state({ species: { 5: seen() }, lure: { ...lure, until: NOW } }) }).lure,
    ).toBeUndefined()
  })
})

describe('medals and regions in the panel', () => {
  it('lists every medal with its progress, formatted, and the count', () => {
    const s = state({
      medals: ['registered-1'],
      medalsSeeded: true,
      species: { 1: speciesEntry({ unlocked: true, registered: true }) },
    })
    const medals = build({ state: s }).medals
    expect(medals.total).toBe(MEDALS.length)
    expect(medals.earned).toBe(1)
    expect(medals.headingText).toBe(D.medalsHeading('en', 1, MEDALS.length))
    expect(medals.items.find((m) => m.id === 'registered-1')).toMatchObject({
      earned: true,
      progressText: '1 / 1',
      percent: 100,
      name: D.medalName('en', 'registered-1'),
    })
    expect(medals.items.find((m) => m.id === 'registered-10')).toMatchObject({
      earned: false,
      progressText: '1 / 10',
      percent: 10,
    })
  })

  // [trigger branch] Earned is what was celebrated, read from the save — not re-derived, so a
  // medal never flickers back to unearned when a merge or a migration moves a count.
  it('reads earned from the medals celebrated', () => {
    const medals = build({ state: state({ medals: ['caught-10'], medalsSeeded: true }) }).medals
    expect(medals.items.find((m) => m.id === 'caught-10')?.earned).toBe(true)
  })

  it('counts each region in the Pokédex summary', () => {
    const s = state({ species: { 1: speciesEntry({ unlocked: true, registered: true }) } })
    const kanto = build({ state: s }).dexSummary.regions[0]!
    expect(kanto).toMatchObject({
      id: 'kanto',
      registered: 1,
      total: 151,
      from: 1,
      to: 151,
      progressText: '1 / 151',
    })
    expect(kanto.name).toBe(D.regionName('en', 'kanto'))
  })
})

describe('the challenges in the panel', () => {
  it('lists the challenges formatted, with their progress and reward', () => {
    const board = {
      day: todayKey(NOW),
      week: isoWeekKey(todayKey(NOW)),
      items: [
        {
          id: 'day:2026-10-21:catch',
          period: 'day' as const,
          kind: 'catch' as const,
          target: 3,
          progress: 1,
          done: false,
        },
        {
          id: 'week:2026-W43:catchType',
          period: 'week' as const,
          kind: 'catchType' as const,
          target: 3,
          type: 'fire' as const,
          progress: 3,
          done: true,
        },
      ],
    }
    const panel = build({ state: state({ challenges: board }) }).challenges!
    expect(panel.heading).toBe(D.challengesHeading('en'))
    expect(panel.items[0]).toEqual({
      id: 'day:2026-10-21:catch',
      period: 'day',
      periodText: D.challengePeriodText('en', 'day'),
      text: D.challengeText('en', board.items[0]!),
      progressText: '1 / 3',
      percent: 33,
      done: false,
      rewardText: `+${compact(EconomyBalance.challenge.dailyReward)}`,
    })
    expect(panel.items[1]).toMatchObject({ done: true, percent: 100, text: 'Catch 3 Fire-type Pokémon' })
  })

  // [trigger branch] A tokens challenge counts in tokens, compact like every figure the panel shows.
  it('formats a tokens challenge’s progress compactly', () => {
    const board = {
      day: todayKey(NOW),
      week: isoWeekKey(todayKey(NOW)),
      items: [
        {
          id: 'x',
          period: 'day' as const,
          kind: 'useTokens' as const,
          target: 2_000_000,
          progress: 500_000,
          done: false,
        },
      ],
    }
    expect(build({ state: state({ challenges: board }) }).challenges?.items[0]?.progressText).toBe(
      '500K / 2M',
    )
  })

  it('has no board before the first fold of a day', () => {
    expect(build().challenges).toBeUndefined()
  })

  // [trigger branch] Yesterday's board, before today's fold, is not shown as today's.
  it('shows no board dealt for another day', () => {
    const stale = { day: '2020-01-01', week: '2020-W01', items: [] }
    expect(build({ state: state({ challenges: stale }) }).challenges).toBeUndefined()
  })
})

describe('Home’s drawers', () => {
  const drawer = (s: CompanionState, id: string, over = {}) =>
    build({ state: s, ...over }).drawers.find((d) => d.id === id)

  it('orders the drawers and gives each a title and a summary line', () => {
    const s = state({ active: activeMon, eggStock: { count: 2 } })
    const ids = build({ state: s }).drawers.map((d) => d.id)
    expect(ids).toEqual(['incubator', 'wild', 'streak'])
    for (const d of build({ state: s }).drawers) {
      expect(d.title.trim()).not.toBe('')
      expect(d.summary.trim()).not.toBe('')
    }
  })

  // [trigger branch] The incubator says what the egg is doing: incubating, paused, or only stock.
  it('sums up the incubator from the egg and the stock', () => {
    const incubating = {
      ...state({ eggStock: { count: 1 } }),
      species: { 1: speciesEntry({ unlocked: true }) },
      eggUsage: PokemonBalance.eggHatchThreshold * 0.4,
    }
    expect(drawer(incubating, 'incubator')?.summary).toBe(
      D.incubatorSummary('en', { percent: 40, stock: 1 }),
    )
    const paused = state({ active: activeMon, eggUsage: 1_000, eggStock: { count: 0 } })
    expect(drawer(paused, 'incubator')).toMatchObject({
      summary: D.incubatorSummary('en', { paused: true, stock: 0 }),
      attention: true,
    })
    const stocked = state({ active: activeMon, eggStock: { count: 2 } })
    expect(drawer(stocked, 'incubator')).toMatchObject({
      summary: D.incubatorSummary('en', { stock: 2 }),
      attention: true,
    })
    expect(drawer(state({ active: activeMon }), 'incubator')?.attention).toBe(false)
  })

  it('has no incubator before the starter', () => {
    expect(drawer(state(), 'incubator')).toBeUndefined()
  })

  it('sums up today’s challenges, and flags them while some are left', () => {
    const board = {
      day: todayKey(NOW),
      week: isoWeekKey(todayKey(NOW)),
      items: [
        { id: 'a', period: 'day' as const, kind: 'catch' as const, target: 3, progress: 3, done: true },
        { id: 'b', period: 'day' as const, kind: 'catch' as const, target: 3, progress: 0, done: false },
      ],
    }
    expect(drawer(state({ challenges: board }), 'challenges')).toMatchObject({
      summary: D.challengesSummary('en', 1, 2),
      attention: true,
    })
  })

  // [trigger branch] A trail is the one thing that runs out: flagged, and named by what it tracks.
  it('names the legendary trail running, and has none without one', () => {
    const trail = [
      {
        id: 't',
        speciesID: 150,
        captureRate: 3,
        isShiny: false,
        names: { en: 'Mewtwo' },
        trackedCount: 0,
        lostAt: NOW,
      },
    ]
    const d = drawer(state({ legendaryTrail: trail }), 'trail')
    expect(d?.attention).toBe(true)
    expect(d?.summary).toContain('Mewtwo')
    expect(drawer(state(), 'trail')).toBeUndefined()
  })

  // [trigger branch] Finds wait to be picked up: their own drawer, flagged; none without any.
  it('gives the finds a drawer of their own while some wait', () => {
    const find = {
      id: 'f1',
      item: 'oranBerry' as const,
      count: 1,
      rarity: 'common' as const,
      appearedAt: NOW,
    }
    expect(drawer(state({ finds: [find] }), 'finds')).toMatchObject({
      summary: D.findsText('en', 1),
      attention: true,
    })
    expect(drawer(state(), 'finds')).toBeUndefined()
  })

  it('sums up the wild queue with the lure running, and the usage totals', () => {
    const lure = { speciesID: 5, baseID: 4, stageIndex: 1, until: NOW + 3_600_000 }
    const wildDrawer = drawer(state({ wild: [wild()], lure }), 'wild')!
    expect(wildDrawer.summary).toContain(D.lureActiveText('en', '#5', 1))
    expect(wildDrawer.attention).toBe(true)
    expect(drawer(state(), 'usage')).toBeUndefined() // usage lives in the lid now
    expect(drawer(state(), 'wild')?.summary).toBe(
      D.nextEncounterShort('en', compact(EncounterBalance.firstThreshold)),
    )
  })
})

describe('the lid', () => {
  // Usage folded into the lid (Diego): the full line, and a short one for a narrow sidebar.
  it('carries the usage totals, full and short', () => {
    const lid = build().lid
    expect(lid.usageText).toBe(D.usageSummary('en', '0', '0'))
    expect(lid.usageShortText).toBe(D.usageShortText('en', '0'))
  })

  // [trigger branch] The three lights read the official limits: ok, warn at their warn
  // severity, crit at 100%; a light with no limit behind it is off.
  // The expanded lid opens the line it shows folded: today and this month, with their costs.
  it('opens into today and this month, tokens and cost', () => {
    const lid = build().lid
    expect(lid.columns.map((c) => c.label)).toEqual([
      D.usageColumnLabel('en', 'today'),
      D.usageColumnLabel('en', 'month'),
    ])
    expect(lid.columns[0]).toMatchObject({
      tokensText: build().totals.todayText,
      costText: build().totals.todayCostText,
    })
    expect(lid.toggleLabel).toBe(D.lidToggleLabel('en'))
  })

  it('lights one LED per official limit, by its severity', () => {
    const limits = [
      { label: '5h', value: '42%', percent: 42, severity: 'normal' as const },
      { label: 'Weekly', value: '85%', percent: 85, severity: 'warn' as const },
    ]
    const lid = build({ usage: { ...usage(), limits } as never }).lid
    expect(lid.lights).toEqual(['ok', 'warn', 'off'])
    expect(build().lid.lights).toEqual(['off', 'off', 'off'])
  })
})

describe('the PC box', () => {
  // The quick switch from the battle plate: every obtained species but the one on stage, the
  // ones still to register first (most advanced first), then the registered — formatted here.
  it('lists the obtained species to switch to, unfinished first', () => {
    const s = state({
      active: activeMon, // #25
      species: {
        25: speciesEntry({ unlocked: true, xp: 1, threshold: 10 }),
        4: speciesEntry({ unlocked: true, xp: 2, threshold: 10 }),
        7: speciesEntry({ unlocked: true, xp: 8, threshold: 10 }),
        1: speciesEntry({ unlocked: true, registered: true }),
        16: speciesEntry({ seen: true }),
      },
    })
    const box = build({ state: s }).pcBox
    expect(box.title).toBe(D.pcBoxTitle('en'))
    expect(box.items.map((i) => i.id)).toEqual([7, 4, 1])
    expect(box.items[0]).toMatchObject({
      percent: 80,
      percentText: D.registrationText('en', 80, false),
      registered: false,
    })
    expect(box.items[2]).toMatchObject({ registered: true })
    expect(box.emptyText).toBe(D.pcBoxEmptyText('en'))
  })

  // The box's own search and sorts (Diego): the labels from the core, and a rarity rank so the
  // webview orders by it without deciding which rarity outranks which.
  it('offers a name search and three sorts, with a rank to sort rarity by', () => {
    const s = state({
      active: activeMon,
      species: { 4: speciesEntry({ unlocked: true }), 150: speciesEntry({ unlocked: true }) },
    })
    const box = build({ state: s }).pcBox
    expect(box.searchPlaceholder).toBe(D.dexSearchPlaceholder('en'))
    expect(box.sorts.map((o) => o.id)).toEqual(['progress', 'number', 'rarity'])
    expect(box.sorts.map((o) => o.label)).toEqual([
      D.pcSortLabel('en', 'progress'),
      D.pcSortLabel('en', 'number'),
      D.pcSortLabel('en', 'rarity'),
    ])
    for (const item of box.items) expect(item.rarityRank).toBe(RARITIES.indexOf(item.rarity as never))
  })
})

describe('the PC box filters (plan 9.8)', () => {
  // Registered, still to register, and shiny: each chip labelled and counted here, and each item
  // carrying what the chip filters on, so the webview never decides which is which.
  it('offers status chips with their counts, and a direction for every sort', () => {
    const s = state({
      active: activeMon,
      species: {
        4: speciesEntry({ unlocked: true, xp: 2, threshold: 10 }),
        7: speciesEntry({ unlocked: true }),
        1: speciesEntry({ unlocked: true, registered: true }),
        150: speciesEntry({ unlocked: true, registered: true, shinyRegistered: true }),
      },
    })
    const panel = build({ state: s })
    const box = panel.pcBox
    expect(box.filters.map((f) => [f.id, f.count])).toEqual([
      ['unregistered', 2],
      ['registered', 2],
      ['shiny', 1],
    ])
    expect(box.filters.map((f) => f.label)).toEqual([
      D.pcFilterLabel('en', 'unregistered'),
      D.pcFilterLabel('en', 'registered'),
      D.pcFilterLabel('en', 'shiny'),
    ])
    expect(box.items.find((i) => i.id === 150)).toMatchObject({ registered: true, shinyRegistered: true })
    expect(box.items.find((i) => i.id === 1)).toMatchObject({ shinyRegistered: false })
    expect(panel.strings.sortAscending).toBe(D.sortDirectionLabel('en', 'ascending'))
    expect(panel.strings.sortDescending).toBe(D.sortDirectionLabel('en', 'descending'))
  })
})

describe('the Pokédex sorts', () => {
  // The Pokédex reads in number order by default, then progress and rarity — the same options
  // as the PC box, its own default first; each cell carries its rarity rank to sort by.
  it('offers number first, then progress and rarity, with a rank on every cell', () => {
    const s = state({
      species: { 4: speciesEntry({ unlocked: true }), 150: speciesEntry({ unlocked: true }) },
    })
    const panel = build({ state: s })
    expect(panel.dexSummary.sorts.map((o) => o.id)).toEqual(['number', 'progress', 'rarity'])
    expect(panel.dexSummary.sorts[0]?.label).toBe(D.pcSortLabel('en', 'number'))
    for (const cell of panel.dexSpecies)
      expect(cell.rarityRank).toBe(RARITIES.indexOf(cell.rarity as never))
  })
})

describe('the empty incubator', () => {
  // [trigger branch] With no eggs in stock the drawer still has something to say (Diego): how the
  // next one arrives, and where to buy one.
  it('says how eggs arrive when the stock is empty, and nothing when it is not', () => {
    const empty = build({ state: state({ active: activeMon, eggStock: { count: 0 } }) }).eggs
    expect(empty.emptyText).toBe(D.eggsEmptyText('en'))
    expect(
      build({ state: state({ active: activeMon, eggStock: { count: 1 } }) }).eggs.emptyText,
    ).toBeUndefined()
  })
})

describe('the shop’s drawers', () => {
  // The shop folds into drawers like Home (Diego): each group a title and one summary line — how
  // many things, and the cheapest — formatted here, in the shop's own group order.
  it('sums up each shop group in one line, cheapest first', () => {
    const groups = build({ state: state({ active: activeMon }) }).shopGroups
    expect(groups.map((g) => g.id)).toEqual(['balls', 'berries', 'items', 'eggs'])
    const balls = groups[0]!
    expect(balls.title).toBe(build().strings.shopBalls)
    expect(balls.summary).toBe(D.shopGroupSummary('en', 4, compact(Pokeball.price.pokeBall)))
  })

  it('leaves out a group with nothing in it', () => {
    expect(build().shopGroups.map((g) => g.id)).not.toContain('eggs') // before the starter
  })
})
