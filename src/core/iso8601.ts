/**
 * ISO 8601 parsing with variable fractional-second precision.
 *
 * Do NOT replace this with a bare `new Date(string)`: V8 gets two of these cases wrong in
 * ways that silently corrupt timestamps.
 *
 *   1. Fractional seconds longer than 9 digits. V8 reads ".0344645678Z" as ".344", where the
 *      correct value is ".034"; this parser truncates to three digits and right-pads.
 *      Measured, not assumed.
 *   2. Date-only strings. V8 accepts "2026-06-10" as UTC midnight; a full internet date-time
 *      requires date + time + timezone, so this parser returns null instead.
 *
 * Getting both exactly right matters because these values (`resets_at`, block start/end)
 * drive limit windows and the 5-hour block boundary.
 */

/**
 * A full internet date-time: dash-separated date, colon-separated time, and either a
 * colon-separated numeric offset or `Z`. The fraction is optional, and the single optional
 * group covers both the fractional and the plain form.
 */
const INTERNET_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/

/** Milliseconds since the epoch, or `null` when the string is not a valid timestamp. */
export function parseISO8601(value: string): number | null {
  const match = INTERNET_DATE_TIME.exec(value)
  if (!match) return null

  const [, date, time, fraction, zone] = match
  // Truncate to milliseconds, then right-pad: ".3" is 300ms, not 3ms.
  const millis = (fraction ?? '').slice(0, 3).padEnd(3, '0')
  const parsed = Date.parse(`${date}T${time}.${millis}${zone === 'z' ? 'Z' : zone}`)

  // Rejects real-looking but impossible values ("2026-13-45T…") that the regex allows.
  return Number.isNaN(parsed) ? null : parsed
}

/** Convenience wrapper for call sites that want a `Date`. */
export function parseISO8601Date(value: string): Date | null {
  const millis = parseISO8601(value)
  return millis === null ? null : new Date(millis)
}
