import { describe, expect, it } from 'vitest'
import { parseISO8601 } from '../src/core/iso8601.js'

// Ported from `ISO8601ParserTests` in Tests/PokeTokenBarTests/ModelLogicTests.swift
describe('parseISO8601', () => {
  it('parses micro, milli and plain seconds', () => {
    expect(parseISO8601('2026-06-10T11:10:00.034464+00:00')).not.toBeNull() // microseconds
    expect(parseISO8601('2026-06-10T11:10:00.303Z')).not.toBeNull() // milliseconds
    expect(parseISO8601('2026-06-10T11:10:00Z')).not.toBeNull() // no fraction
  })

  it('returns null for garbage', () => {
    expect(parseISO8601('not-a-date')).toBeNull()
    expect(parseISO8601('')).toBeNull()
  })

  it('resolves micro and plain to the same instant', () => {
    expect(parseISO8601('2026-06-10T11:10:00.000000Z')).toBe(parseISO8601('2026-06-10T11:10:00Z'))
  })
})

// Divergences between V8's `new Date()` and Swift's ISO8601DateFormatter, measured
// on Node 20. These are the reason this parser exists at all — if it ever gets
// "simplified" to `new Date(value)`, these fail.
describe('parseISO8601 — V8 divergences', () => {
  it('truncates over-long fractions instead of misreading them', () => {
    // V8's `new Date` yields .344 here. Swift truncates to 3 digits -> .034.
    expect(parseISO8601('2026-06-10T11:10:00.0344645678Z')).toBe(
      parseISO8601('2026-06-10T11:10:00.034Z'),
    )
  })

  it('right-pads short fractions (".3" is 300ms, not 3ms)', () => {
    expect(parseISO8601('2026-06-10T11:10:00.3Z')).toBe(
      parseISO8601('2026-06-10T11:10:00.300Z'),
    )
  })

  it('rejects date-only strings that V8 would accept', () => {
    expect(parseISO8601('2026-06-10')).toBeNull()
  })

  it('rejects offsets without a colon, matching .withColonSeparatorInTimeZone', () => {
    expect(parseISO8601('2026-06-10T11:10:00+0000')).toBeNull()
  })

  it('rejects impossible dates the shape check lets through', () => {
    expect(parseISO8601('2026-13-45T11:10:00Z')).toBeNull()
  })

  it('honours non-UTC offsets', () => {
    expect(parseISO8601('2026-06-10T11:10:00+09:00')).toBe(
      parseISO8601('2026-06-10T02:10:00Z'),
    )
  })
})
