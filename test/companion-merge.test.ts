import { describe, expect, it } from 'vitest'
import { mergeSaves, withRevision } from '../src/core/companion/merge.js'
import { type CompanionState, type DexEntry, freshCompanionState } from '../src/core/companion/model.js'
import { MilestoneBalance } from '../src/core/companion/encounters.js'
import { sanitized } from '../src/core/companion/saveTransfer.js'
import { spendableBalance } from '../src/core/companion/ledger.js'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

function dex(id: string): DexEntry {
  return { id, baseID: 1, finalID: 3, chainOrder: [1, 2, 3], rarity: 'common', isShiny: false }
}

function save(over: Partial<CompanionState> = {}): CompanionState {
  return sanitized({
    ...freshCompanionState('en'),
    installBaselineSet: true,
    lastDate: '2026-10-20',
    claimedTodayTokensByProvider: {},
    ...over,
  })
}

/** Two machines that agreed at `{A:2, B:3}` and then each moved on its own. */
function fork(local: Partial<CompanionState>, remote: Partial<CompanionState>) {
  return {
    local: save({ revision: { [A]: 5, [B]: 3 }, ...local }),
    remote: save({ revision: { [A]: 2, [B]: 4 }, ...remote }),
  }
}

describe('mergeSaves', () => {
  describe('history', () => {
    it('adopts a save that already contains this one', () => {
      const local = save({ revision: { [A]: 2 }, eggUsage: 10 })
      const remote = save({ revision: { [A]: 2, [B]: 7 }, eggUsage: 900, spentTokens: 40 })
      const result = mergeSaves(local, remote)
      expect(result.outcome).toBe('adoptedRemote')
      expect(result.state.eggUsage).toBe(900)
      expect(result.state.spentTokens).toBe(40)
    })

    it('keeps this save when the other is behind it', () => {
      const local = save({ revision: { [A]: 4, [B]: 7 }, eggUsage: 10 })
      const remote = save({ revision: { [A]: 2, [B]: 7 }, eggUsage: 900 })
      const result = mergeSaves(local, remote)
      expect(result.outcome).toBe('keptLocal')
      expect(result.state.eggUsage).toBe(10)
    })

    // [trigger branch] Both machines must continue the *same* history, or they diverge again on
    // every sync. Each side merges with the other as "remote" — the winner must not depend on it.
    it('picks the same fork winner from either side', () => {
      const { local, remote } = fork({ eggUsage: 111 }, { eggUsage: 222 })
      const here = mergeSaves(local, remote)
      const there = mergeSaves(remote, local)
      expect(here.outcome).toBe('forked')
      expect(here.state.eggUsage).toBe(there.state.eggUsage)
    })

    // A has 3 changes since the fork, B has 1: A has more to lose, so A's history continues.
    it('lets the side that did more since the fork win', () => {
      const { local, remote } = fork({ eggUsage: 111 }, { eggUsage: 222 })
      expect(mergeSaves(local, remote).narrative).toBe('local')
      expect(mergeSaves(remote, local).narrative).toBe('remote')
    })

    // Two saves from before sync have empty counters, which "contain" each other vacuously. They
    // are two separate games, so this must be resolved as a fork, never as "nothing to do".
    it('treats two untracked saves as a fork', () => {
      const local = save({ dex: [dex('mine')] })
      const remote = save({ dex: [dex('theirs')], usedSinceInstall: 50 })
      const result = mergeSaves(local, remote)
      expect(result.outcome).toBe('forked')
      expect(result.state.dex.map((d) => d.id).sort()).toEqual(['mine', 'theirs'])
    })
  })

  describe('growth', () => {
    // [trigger branch] The losing side's tokens since the fork are credited to the winner, so a
    // second machine open at the same time never loses its usage — only its RNG outcomes.
    it('credits the tokens the winning history has not seen', () => {
      const { local, remote } = fork(
        { usedByDevice: { [A]: 1000, [B]: 300 }, usedSinceInstall: 1300, eggUsage: 1300 },
        { usedByDevice: { [A]: 200, [B]: 700 }, usedSinceInstall: 900, eggUsage: 900 },
      )
      const result = mergeSaves(local, remote)
      expect(result.narrative).toBe('local')
      expect(result.creditedTokens).toBe(400) // B: 700 seen remotely, 300 locally
      expect(result.state.usedSinceInstall).toBe(1700)
      expect(result.state.eggUsage).toBe(1700)
      expect(result.state.usedByDevice).toEqual({ [A]: 1000, [B]: 700 })
    })

    it('credits growth to the active companion rather than the egg', () => {
      const active = {
        baseID: 1,
        pathIDs: [1],
        plannedPathIDs: [1],
        stageIndex: 0,
        usedAtStage: 5,
        rarity: 'common' as const,
        totalForms: 3,
        isShiny: false,
        dittoRevealed: false,
      }
      const { local, remote } = fork(
        { active, usedByDevice: { [A]: 10 } },
        { usedByDevice: { [A]: 0, [B]: 50 } },
      )
      expect(mergeSaves(local, remote).state.active?.usedAtStage).toBe(55)
    })

    // A retried or repeated sync must not pay the same tokens again.
    it('credits nothing the second time the same save is merged', () => {
      const { local, remote } = fork({ usedByDevice: { [A]: 10 } }, { usedByDevice: { [B]: 50 } })
      const once = mergeSaves(local, remote).state
      const twice = mergeSaves(once, remote)
      expect(twice.creditedTokens).toBe(0)
      expect(twice.state.usedSinceInstall).toBe(once.usedSinceInstall)
    })

    it('is idempotent', () => {
      const state = save({ revision: { [A]: 3 }, dex: [dex('x')], usedByDevice: { [A]: 9 } })
      expect(mergeSaves(state, state).state).toEqual(state)
    })
  })

  describe('collections', () => {
    it('unions the Pokédex whichever history wins', () => {
      const { local, remote } = fork(
        { dex: [dex('shared'), dex('mine')] },
        { dex: [dex('shared'), dex('theirs')] },
      )
      for (const [x, y] of [
        [local, remote],
        [remote, local],
      ] as const) {
        expect(
          mergeSaves(x, y)
            .state.dex.map((d) => d.id)
            .sort(),
        ).toEqual(['mine', 'shared', 'theirs'])
      }
    })

    // Laptop Monday plus desktop Tuesday is two days of work (`docs/sync.md` §2.1).
    it('unions the streak days and keeps the latest award', () => {
      const { local, remote } = fork(
        { accrualDays: ['2026-10-19'], lastStreakAwardDate: '2026-10-01' },
        { accrualDays: ['2026-10-20'], lastStreakAwardDate: '2026-10-08' },
      )
      const state = mergeSaves(local, remote).state
      expect(state.accrualDays).toEqual(['2026-10-19', '2026-10-20'])
      expect(state.lastStreakAwardDate).toBe('2026-10-08')
    })

    it('keeps the higher candy tier and encounter count from either side', () => {
      const { local, remote } = fork(
        { candyGrantTier: { w1: 1 }, encountersSeen: 4 },
        { candyGrantTier: { w1: 2, w2: 1 }, encountersSeen: 9, candyFeatureSeeded: true },
      )
      const state = mergeSaves(local, remote).state
      expect(state.candyGrantTier).toEqual({ w1: 2, w2: 1 })
      expect(state.encountersSeen).toBe(9)
      expect(state.candyFeatureSeeded).toBe(true)
    })
  })

  describe('rewards', () => {
    // [trigger branch] Each milestone was crossed by work observed somewhere, so a merge that
    // lifts the total across several pays each one — not the single award a first scan gets.
    it('pays every milestone the merged total crosses', () => {
      const { local, remote } = fork(
        {
          usedSinceInstall: MilestoneBalance.tokens - 1,
          usedByDevice: { [A]: MilestoneBalance.tokens - 1 },
          milestonesAwarded: 0,
        },
        { usedByDevice: { [B]: 3 * MilestoneBalance.tokens } },
      )
      const state = mergeSaves(local, remote).state
      expect(state.milestonesAwarded).toBe(3)
      expect(state.owedLegendaryEncounters).toBe(3)
      expect(mergeSaves(state, remote).state.owedLegendaryEncounters).toBe(3)
    })

    it('owes again a legendary dropped with the losing queue', () => {
      const legendary = {
        id: 'leg-1',
        speciesID: 150,
        captureRate: 3,
        rarity: 'legendary' as const,
        isShiny: false,
        appearedAt: 0,
        throws: 0,
      }
      const { local, remote } = fork({}, { wild: [legendary] })
      expect(mergeSaves(local, remote).state.owedLegendaryEncounters).toBe(1)
    })

    // Why `spentTokens` is narrative and not a per-device counter (`docs/sync.md` §3.2): both
    // machines spent the whole balance offline. Summing the spends would leave −1000 hidden
    // behind a clamped zero; taking one history keeps one purchase and the one ball it bought.
    it('never reconciles two purchases into a debt', () => {
      const { local, remote } = fork(
        { usedSinceInstall: 1000, spentTokens: 1000, inventory: { masterBall: 1 } },
        { usedSinceInstall: 1000, spentTokens: 1000, inventory: { masterBall: 1 } },
      )
      const state = mergeSaves(local, remote).state
      expect(state.spentTokens).toBe(1000)
      expect(state.inventory['masterBall']).toBe(1)
      expect(state.usedSinceInstall - state.spentTokens).toBeGreaterThanOrEqual(0)
      expect(spendableBalance(state)).toBe(0)
    })
  })

  describe('what stays on this machine', () => {
    // Importing the other machine's daily claims makes them a threshold here, and this
    // machine's usage then silently fails to register until midnight (`docs/sync.md` §1.1).
    it('keeps the local ledger and preferences when the other history wins', () => {
      const local = save({
        revision: { [A]: 1 },
        claimedTodayTokensByProvider: { codex: 5 },
        lastDate: '2026-10-20',
        language: 'es',
        trainerID: 'red',
      })
      const remote = save({
        revision: { [A]: 1, [B]: 9 },
        claimedTodayTokensByProvider: { claude_code: 999_999 },
        lastDate: '2026-10-21',
        language: 'ja',
      })
      const result = mergeSaves(local, remote)
      expect(result.outcome).toBe('adoptedRemote')
      expect(result.state.claimedTodayTokensByProvider).toEqual({ codex: 5 })
      expect(result.state.lastDate).toBe('2026-10-20')
      expect(result.state.language).toBe('es')
      expect(result.state.trainerID).toBe('red')
    })
  })

  it('counts one revision per change', () => {
    expect(withRevision(save({ revision: { [A]: 2 } }), A).revision).toEqual({ [A]: 3 })
    expect(withRevision(save(), B).revision).toEqual({ [B]: 1 })
  })
})

describe('mergeSaves and the wild area', () => {
  const trail = (id: string) => ({
    id,
    speciesID: 150,
    captureRate: 3,
    isShiny: false,
    trackedCount: 0,
    lostAt: 1,
  })

  // [trigger branch] The trail is narrative, like the queue it came from. A union would bring back
  // a legendary this machine already tracked and caught.
  it('takes the legendary trail and the finds whole from the winning history', () => {
    const { local, remote } = fork(
      { legendaryTrail: [], finds: [] },
      {
        legendaryTrail: [trail('mew')],
        finds: [{ id: 'f1', item: 'pokeBall', count: 1, rarity: 'common', appearedAt: 1 }],
      },
    )
    const merged = mergeSaves(local, remote)
    expect(merged.narrative).toBe('local')
    expect(merged.state.legendaryTrail).toEqual([])
    expect(merged.state.finds).toEqual([])
  })

  it('keeps whether this machine already announced a full queue', () => {
    const { local, remote } = fork({ queueFullArmed: false }, { queueFullArmed: true })
    expect(mergeSaves(remote, local).state.queueFullArmed).toBe(true)
    expect(mergeSaves(local, remote).state.queueFullArmed).toBe(false)
  })
})

describe('mergeSaves with a save from before sync', () => {
  // [trigger branch] A save exported by 0.4.0 has no counters. "Every counter covers nothing" is
  // vacuously true, so a tracked local save used to swallow it whole: the imported companion,
  // bag and usage were dropped, which is not what "the save that has progressed more" promises.
  it('treats an untracked save as a fork and keeps the one that has progressed more', () => {
    const local = save({ revision: { [A]: 3 }, usedSinceInstall: 100, eggUsage: 100 })
    const old = save({ revision: {}, usedSinceInstall: 9_000, eggUsage: 9_000, dex: [dex('old')] })
    const result = mergeSaves(local, old)
    expect(result.outcome).toBe('forked')
    expect(result.narrative).toBe('remote')
    expect(result.state.eggUsage).toBe(9_000)
    // And from the other side, the same history wins.
    expect(mergeSaves(old, local).narrative).toBe('local')
  })
})

describe('mergeSaves and owed legendaries', () => {
  // [trigger branch] One entitlement owed before the fork: the loser delivered it (owes 0, has
  // the legendary waiting), the winner still owes it. Re-owing the dropped legendary on top of
  // the winner's debt paid the same entitlement twice.
  it('does not pay an entitlement twice when the loser already delivered it', () => {
    const legendary = {
      id: 'leg',
      speciesID: 150,
      captureRate: 3,
      rarity: 'legendary' as const,
      isShiny: false,
      appearedAt: 1,
      throws: 0,
    }
    const { local, remote } = fork(
      { owedLegendaryEncounters: 1 },
      { owedLegendaryEncounters: 0, wild: [legendary] },
    )
    const merged = mergeSaves(local, remote)
    expect(merged.narrative).toBe('local')
    expect(merged.state.owedLegendaryEncounters).toBe(1)
  })
})

describe('the registry', () => {
  const progress = (over: Partial<CompanionState['species'][number]> = {}) => ({
    xp: 0,
    unlocked: true,
    seen: false,
    registered: false,
    caught: 0,
    candiesUsed: 0,
    ...over,
  })

  // [trigger branch] A species the losing side registered must stay registered: the states are
  // flags, and "Collections are never lost" is the merge's first promise.
  it('never un-registers a species the losing side registered', () => {
    const { local, remote } = fork(
      { species: { 4: progress({ xp: 5, threshold: 100 }) } },
      { species: { 4: progress({ xp: 100, threshold: 100, registered: true }) } },
    )
    const here = mergeSaves(local, remote)
    expect(here.narrative).toBeDefined()
    expect(here.state.species[4]?.registered).toBe(true)
    expect(mergeSaves(remote, local).state.species[4]?.registered).toBe(true)
  })

  it('takes the experience from the winner and the counters by maximum', () => {
    const local = save({
      revision: { [A]: 4, [B]: 7 },
      species: { 4: progress({ xp: 5, caught: 1, candiesUsed: 2 }) },
    })
    const remote = save({
      revision: { [A]: 2, [B]: 7 },
      species: { 4: progress({ xp: 50, caught: 3, candiesUsed: 1 }) },
    })
    const result = mergeSaves(local, remote)
    expect(result.outcome).toBe('keptLocal')
    expect(result.state.species[4]).toMatchObject({ xp: 5, caught: 3, candiesUsed: 2 })
  })

  it('unlocks at zero a species only the losing side had, and keeps a threshold either side knew', () => {
    const { local, remote } = fork(
      { species: { 4: progress({ xp: 5 }) } },
      { species: { 4: progress({ threshold: 100 }), 7: progress({ xp: 999, seen: true }) } },
    )
    const result = mergeSaves(local, remote)
    const winner = result.narrative === 'local' ? local : remote
    expect(result.state.species[4]?.threshold).toBe(100)
    const seven = result.state.species[7]!
    expect(seven.unlocked).toBe(true)
    expect(seven.seen).toBe(true)
    expect(seven.xp).toBe(winner.species[7]?.xp ?? 0)
  })

  // A nature only one side recorded survives the merge: it was set by a switch (or a Mint) on
  // that side, and dropping it would roll a new one next time the species is chosen.
  // [trigger branch] One side already turned the share into experience (threshold fixed, share
  // gone); the other still owes it. Carrying the owed share over would apply the catch twice.
  it('drops a share the side with the threshold already settled', () => {
    const { local, remote } = fork(
      { species: { 4: progress({ xp: 50, threshold: 1_000 }) } },
      { species: { 4: progress({ pendingShare: 0.05 }) } },
    )
    expect(mergeSaves(local, remote).state.species[4]?.pendingShare).toBeUndefined()
    expect(mergeSaves(remote, local).state.species[4]?.pendingShare).toBeUndefined()
  })

  // [trigger branch] Shiny progress is a counter like the catches: the side that played more of
  // the bar, or bought more of it, keeps it — the losing side's never wipes it.
  it('keeps the furthest shiny bar and boost of either side', () => {
    const { local, remote } = fork(
      { species: { 4: progress({ shinyXP: 100, shinyBoosted: 10 }) } },
      { species: { 4: progress({ shinyXP: 50, shinyBoosted: 40 }) } },
    )
    for (const merged of [mergeSaves(local, remote), mergeSaves(remote, local)]) {
      expect(merged.state.species[4]).toMatchObject({ shinyXP: 100, shinyBoosted: 40 })
    }
  })

  it('keeps a recorded nature either side knew', () => {
    const { local, remote } = fork(
      { species: { 4: progress() } },
      { species: { 4: progress({ nature: 'bold' }) } },
    )
    expect(mergeSaves(local, remote).state.species[4]?.nature).toBe('bold')
    expect(mergeSaves(remote, local).state.species[4]?.nature).toBe('bold')
  })

  // The lure is bought with the winner's wallet, so it travels with the winner's spend.
  // Medals only grow: a medal celebrated on either side stays celebrated, so it is never
  // announced twice after a sync.
  it('keeps every medal either side celebrated', () => {
    const { local, remote } = fork(
      { medals: ['registered-1'], medalsSeeded: true },
      { medals: ['shiny-1'], medalsSeeded: true },
    )
    const merged = mergeSaves(local, remote).state
    expect(new Set(merged.medals)).toEqual(new Set(['registered-1', 'shiny-1']))
    expect(merged.medalsSeeded).toBe(true)
  })

  it('keeps the winner’s lure', () => {
    const lure = { speciesID: 5, baseID: 4, stageIndex: 1, until: 1_700_000_000_000 }
    const local = save({ revision: { [A]: 4, [B]: 7 }, lure })
    const remote = save({ revision: { [A]: 2, [B]: 7 } })
    expect(mergeSaves(local, remote).state.lure).toEqual(lure)
    expect(mergeSaves(remote, local).state.lure).toEqual(lure)
  })

  it('keeps the winner’s payouts, as it keeps its spend', () => {
    const local = save({ revision: { [A]: 4, [B]: 7 }, earnedTokens: 30 })
    const remote = save({ revision: { [A]: 2, [B]: 7 }, earnedTokens: 999 })
    expect(mergeSaves(local, remote).state.earnedTokens).toBe(30)
  })
})

describe('the registry and the merge credit', () => {
  // [trigger branch] The credit for unseen tokens moves the companion's bar; building the merged
  // registry from the pre-credit map threw that away and the meter and the bar diverged.
  it('keeps the experience the merge just credited', () => {
    const active = {
      baseID: 4,
      pathIDs: [4],
      plannedPathIDs: [4, 5],
      stageIndex: 0,
      usedAtStage: 10,
      rarity: 'common' as const,
      totalForms: 2,
      isShiny: false,
      dittoRevealed: false,
    }
    const local = save({
      revision: { [A]: 4, [B]: 7 },
      usedByDevice: { [A]: 100 },
      active,
      species: {
        4: { xp: 10, unlocked: true, seen: false, registered: false, caught: 0, candiesUsed: 0 },
      },
    })
    const remote = save({ revision: { [A]: 2, [B]: 7 }, usedByDevice: { [B]: 50 } })
    const result = mergeSaves(local, remote)
    expect(result.creditedTokens).toBe(50)
    expect(result.state.active?.usedAtStage).toBe(60)
    expect(result.state.species[4]?.xp).toBe(60)
  })
})

describe('the egg stock', () => {
  // [trigger branch] A maximum would resurrect eggs one side already incubated; the winner's
  // count is fail-closed. The grant day is the most recent, so today's egg is never granted twice.
  it('takes the winner’s eggs and the latest grant day', () => {
    const local = save({
      revision: { [A]: 4, [B]: 7 },
      eggStock: { count: 1, lastGrantDay: '2026-10-19' },
    })
    const remote = save({
      revision: { [A]: 2, [B]: 7 },
      eggStock: { count: 3, lastGrantDay: '2026-10-20' },
    })
    expect(mergeSaves(local, remote).state.eggStock).toEqual({ count: 1, lastGrantDay: '2026-10-20' })
  })
})
