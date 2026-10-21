/**
 * The game's news, for the panel (plan 08 §7: one way to celebrate). Every event the store
 * announces becomes one item the webview draws with the catch's own card — sprite, headline,
 * detail — when a surface is on screen; the host toasts the same headline only when none is.
 * Pure: the headline is `celebrationText`'s, so the toast and the card never say two things.
 */

import type { AppLanguage } from '../companion/model.js'
import type { PanelNews } from '../../webview/protocol.js'
import { type CelebrationEvent, celebrationText, registeredOnTheWay } from '../i18n/dispatch.js'

/** The events the store and the worker raise, with the species fields some of them carry. */
export type NewsEvent = CelebrationEvent & { speciesID?: number; isShiny?: boolean }

/** Style tokens, by event: what the card is dressed as. */
const NEWS_KIND: Record<NewsEvent['kind'], string> = {
  hatched: 'hatched',
  evolved: 'evolved',
  graduated: 'graduated',
  shinyRegistered: 'shiny',
  companionChosen: 'companion',
  companionSwitched: 'companion',
  dittoRevealed: 'ditto',
  candyGranted: 'candy',
  wildAppeared: 'wild',
  wildCaught: 'wild',
  legendaryEarned: 'legendary',
  wildQueueFull: 'wild',
  medalEarned: 'medal',
  challengeDone: 'challenge',
}

export function newsFor(lang: AppLanguage, event: NewsEvent): PanelNews {
  const item: PanelNews = {
    kind: NEWS_KIND[event.kind] ?? 'info',
    isShiny: event.isShiny === true || event.kind === 'shinyRegistered',
    headline: celebrationText(lang, event),
  }
  if (event.speciesID !== undefined) item.speciesID = event.speciesID
  if (event.kind === 'evolved' && event.registered !== undefined) {
    item.detail = registeredOnTheWay(lang, event.registered)
  }
  return item
}

/** Whether an event also toasts when no surface is on screen: a choice the player just made never does. */
export function newsToasts(event: NewsEvent): boolean {
  return event.kind !== 'companionChosen'
}
