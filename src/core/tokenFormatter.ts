/**
 * Rounding was verified on Node 20: `toFixed` and C's `printf("%.Nf")` agree on every value
 * the tests assert, including the awkward ones (88.35 -> "88.3", 12.345 -> "12.3").
 */

/** 987 -> "987", 12_345 -> "12.3K", 190_612_940 -> "190.6M", 1_240_000_000 -> "1.24B" */
export function compact(value: number): string {
  const v = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (v < 1_000) return `${value}` // the signed original value, unscaled
  if (v < 1_000_000) return sign + trim(v / 1_000, 1) + 'K'
  if (v < 1_000_000_000) return sign + trim(v / 1_000_000, 1) + 'M'
  return sign + trim(v / 1_000_000_000, 2) + 'B'
}

/**
 * Thousands separators for the detail view (190,612,940).
 *
 * The separator follows the *system region*, not the app language — en/ko/ja `253,412,890`,
 * es/de `253.412.890`, fr/ru `253 412 890`. The `locale` parameter exists so tests do not
 * depend on the runner's region (PR #160 was reported by a contributor whose machine does
 * not use commas); production behaviour is unchanged when it is omitted.
 */
export function grouped(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(value)
}

export function cost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** Short cost for the status bar: $9.5 / $311 / $1.2K */
export function costCompact(usd: number): string {
  if (usd < 100) return `$${usd.toFixed(1)}`
  if (usd < 10_000) return `$${usd.toFixed(0)}`
  return `$${(usd / 1_000).toFixed(1)}K`
}

export function percent(value: number): string {
  return value === Math.round(value) ? `${value.toFixed(0)}%` : `${value.toFixed(1)}%`
}

function trim(value: number, decimals: number): string {
  let s = value.toFixed(decimals)
  while (s.endsWith('0')) s = s.slice(0, -1)
  if (s.endsWith('.')) s = s.slice(0, -1)
  return s
}
