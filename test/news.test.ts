import { describe, expect, it } from 'vitest'
import { newsFor, newsToasts } from '../src/core/panel/news.js'
import { celebrationText, registeredOnTheWay } from '../src/core/i18n/dispatch.js'

describe('the game’s news', () => {
  // The card and the toast say one thing: the headline is the toast's sentence.
  it('heads every item with the toast’s own sentence', () => {
    const event = { kind: 'hatched' as const, name: 'Pichu', isShiny: true, speciesID: 172 }
    expect(newsFor('en', event)).toEqual({
      kind: 'hatched',
      speciesID: 172,
      isShiny: true,
      headline: celebrationText('en', event),
    })
  })

  // [trigger branch] An evolution names the form it registered on the way: there is no separate
  // "registered" event, a non-final form registers exactly as it evolves.
  it('says which form an evolution registered', () => {
    const item = newsFor('es', {
      kind: 'evolved',
      name: 'Charmeleon',
      registered: 'Charmander',
      speciesID: 5,
    })
    expect(item).toMatchObject({
      kind: 'evolved',
      speciesID: 5,
      detail: registeredOnTheWay('es', 'Charmander'),
    })
  })

  it('dresses a shiny registration as shiny', () => {
    expect(newsFor('en', { kind: 'shinyRegistered', name: 'Arbok', speciesID: 24 })).toMatchObject({
      kind: 'shiny',
      isShiny: true,
    })
  })

  // [trigger branch] A companion chosen by hand is news for the panel, never a toast: the player
  // just clicked. Everything else still toasts when no surface is on screen.
  it('toasts everything but a choice the player just made', () => {
    expect(newsToasts({ kind: 'companionChosen', name: 'Pikachu' })).toBe(false)
    expect(newsToasts({ kind: 'evolved', name: 'Raichu' })).toBe(true)
  })
})
