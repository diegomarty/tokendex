import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRAINER_ID,
  TRAINER_IDS,
  isTrainerID,
  trainerIDOrDefault,
} from '../src/core/companion/trainers.js'
import { TRAINER_SPRITE_BASE, trainerURL } from '../src/webview/sprite.js'

describe('the trainer roster', () => {
  // The slug goes straight into a URL path. A slug with an uppercase letter, a space or a slash
  // would either 404 on Showdown's case-sensitive host or escape the sprites directory, and the
  // failure would look like "the avatar is broken" rather than like a bad constant.
  it('holds only slugs that are safe in a URL path', () => {
    for (const id of TRAINER_IDS) {
      expect(id, `${id} is not a bare lowercase slug`).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('has no duplicates', () => {
    expect(new Set(TRAINER_IDS).size).toBe(TRAINER_IDS.length)
  })

  it('includes its own default', () => {
    expect(isTrainerID(DEFAULT_TRAINER_ID)).toBe(true)
  })

  it('rejects anything outside the roster', () => {
    expect(isTrainerID('not-a-trainer')).toBe(false)
    expect(isTrainerID('')).toBe(false)
  })

  // A slug removed from the roster in a later version must not leave an existing save drawing a
  // 404 for ever.
  it('falls back to the default for an absent or retired slug', () => {
    expect(trainerIDOrDefault(undefined)).toBe(DEFAULT_TRAINER_ID)
    expect(trainerIDOrDefault('retired-slug')).toBe(DEFAULT_TRAINER_ID)
    expect(trainerIDOrDefault('lyra')).toBe('lyra')
  })
})

describe('trainerURL', () => {
  it('builds a Showdown sprite URL', () => {
    expect(trainerURL('red')).toBe(`${TRAINER_SPRITE_BASE}/red.png`)
  })

  // The webview builds the URL and the core owns the roster, so the two cannot import each
  // other. This is the seam where a rename in one would otherwise go unnoticed.
  it('resolves every roster slug to a URL under the sprites directory', () => {
    for (const id of TRAINER_IDS) {
      expect(trainerURL(id).startsWith(`${TRAINER_SPRITE_BASE}/`)).toBe(true)
    }
  })
})
