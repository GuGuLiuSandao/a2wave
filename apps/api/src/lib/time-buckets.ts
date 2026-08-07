/**
 * Fixed-width time bucketing for per-agent run time series.
 *
 * Two properties drive every decision here:
 *
 * 1. `runs.createdAt` / `runSteps.createdAt` are drizzle `mode:'timestamp'`
 *    columns, i.e. Unix **seconds**. All arithmetic below is in seconds.
 *
 * 2. A "day" must mean the *viewer's* day. `strftime(..., 'unixepoch')` yields
 *    UTC days, and the `'localtime'` modifier yields the *server process*
 *    timezone — neither is the viewer's. Both would make the last point of a
 *    chart disagree with the "runs today" KPI rendered directly above it. So
 *    the caller supplies its UTC offset and we fold it into the arithmetic,
 *    which is deterministic and testable without touching `process.env.TZ`.
 *
 * The offset convention is `-getTimezoneOffset() * 60` (UTC+8 → +28800),
 * because `getTimezoneOffset()` returns inverted minutes.
 */

import { sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { isPostgresRuntime } from '../db/dialect-runtime.js'

export const BUCKET_SECONDS = { hour: 3600, day: 86_400 } as const

/**
 * Embed an integer directly in the SQL text instead of binding it.
 *
 * Needed only so a bucket expression renders **identically** in SELECT and
 * GROUP BY: drizzle numbers placeholders per occurrence, so a bound value
 * becomes `$1` in one clause and `$7` in the other, and PostgreSQL — which
 * matches grouping expressions syntactically — then rejects the query as
 * selecting an ungrouped column.
 *
 * Safe because every caller passes a server-computed integer (a bucket width,
 * a validated UTC offset, or a boundary this module generated). The guard
 * enforces that rather than trusting it: a non-integer here would be string
 * interpolation into SQL.
 */
function literalInt(value: number) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Refusing to inline a non-integer into SQL: ${value}`)
  }
  return sql.raw(String(value))
}

/**
 * The viewer's UTC offset **at a given instant**, in seconds (UTC+8 → 28800).
 *
 * A single scalar offset cannot describe a range that crosses a DST
 * transition: every boundary after the switch lands an hour off, and the
 * 23- or 25-hour local day cannot be expressed by a fixed 86400 width at all.
 * Since the UI offers 30- and 90-day ranges, that is routine, not an edge case.
 *
 * SQLite cannot help here — its date functions accept only `'localtime'`
 * (the *server* zone) and return NULL for an IANA name — so the boundaries are
 * computed here and handed to SQL as explicit values.
 *
 * Returns null for an unusable zone name so callers can fall back rather than
 * throw on input that reached them from a client.
 */
export function zoneOffsetSecondsAt(timeZone: string, atSeconds: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(atSeconds * 1000))
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    // 'GMT' exactly (no suffix) is a valid rendering of a zero offset.
    if (name === 'GMT') return 0
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
    if (!m) return null
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60)
  } catch {
    return null
  }
}

/**
 * Start of the local day containing `seconds`, as an absolute instant.
 *
 * Resolves the offset twice: once at the input instant to guess the local
 * date, then again at that guess, because the correct offset for a midnight is
 * the one in force *at that midnight*, not at the sample. Without the second
 * pass a sample taken after a spring-forward would floor using the winter
 * offset and land an hour into the previous day.
 */
export function localDayStartSeconds(seconds: number, timeZone: string): number | null {
  const guessOffset = zoneOffsetSecondsAt(timeZone, seconds)
  if (guessOffset === null) return null
  const naiveStart = Math.floor((seconds + guessOffset) / 86_400) * 86_400 - guessOffset
  const trueOffset = zoneOffsetSecondsAt(timeZone, naiveStart)
  if (trueOffset === null) return null
  if (trueOffset === guessOffset) return naiveStart
  return Math.floor((seconds + trueOffset) / 86_400) * 86_400 - trueOffset
}

/**
 * Local-day boundaries covering `[fromSeconds, toSeconds]`, each entry the
 * absolute instant that day begins. Consecutive entries may be 23, 24 or 25
 * hours apart across a DST transition — which is the point.
 */
export function localDaySequence(
  fromSeconds: number,
  toSeconds: number,
  timeZone: string,
): number[] | null {
  let cursor = localDayStartSeconds(fromSeconds, timeZone)
  const last = localDayStartSeconds(toSeconds, timeZone)
  if (cursor === null || last === null) return null

  const out: number[] = []
  // Step a day at a time, re-flooring so the cursor tracks real local midnights
  // rather than drifting by the accumulated DST error.
  while (cursor <= last && out.length <= MAX_BUCKETS) {
    out.push(cursor)
    const next = localDayStartSeconds(cursor + 86_400 + 7200, timeZone)
    if (next === null || next <= cursor) break
    cursor = next
  }
  return out
}

/**
 * SQL form of {@link bucketForBoundaries}, for `GROUP BY`.
 *
 * Emits a CASE ladder over the explicit boundaries rather than fixed-width
 * arithmetic, so a 23- or 25-hour local day groups correctly. The ladder is
 * bounded by MAX_BUCKETS, which the route enforces before calling.
 *
 * Descending order matters: the first matching arm wins, so the latest
 * boundary at or before the row's timestamp is the one selected.
 */
export function boundaryBucketSql(col: SQLiteColumn, boundaries: number[]) {
  if (boundaries.length === 0) return sql<number>`NULL`
  const arms = [...boundaries]
    .sort((a, b) => b - a)
    // Boundaries are inlined for the same GROUP BY-matching reason as above.
    .map((b) => sql`WHEN ${epochSeconds(col)} >= ${literalInt(b)} THEN ${literalInt(b)}`)
  return sql<number>`(CASE ${sql.join(arms, sql` `)} ELSE NULL END)`
}

/**
 * Assign `seconds` to its bucket given explicit ascending boundaries.
 * Returns null when the instant precedes the first boundary.
 */
export function bucketForBoundaries(seconds: number, boundaries: number[]): number | null {
  let lo = 0
  let hi = boundaries.length - 1
  let found: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (boundaries[mid] <= seconds) {
      found = boundaries[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

export type BucketUnit = keyof typeof BUCKET_SECONDS

/**
 * Upper bound on buckets per response. Guards the endpoint against a
 * hand-rolled request like `bucket=hour&from=2020-01-01`, which would otherwise
 * allocate tens of thousands of points. The UI never produces such a range, but
 * the route is reachable directly.
 */
export const MAX_BUCKETS = 400

/** Largest real-world UTC offset is +14:00; anything beyond is bad input. */
export const MAX_TZ_OFFSET_SECONDS = 14 * 3600

/**
 * Floor `seconds` to the start of its bucket, with boundaries aligned to the
 * viewer's local midnight. The returned value is still an absolute instant, so
 * callers never have to re-interpret it against a timezone.
 */
export function bucketStartSeconds(
  seconds: number,
  unit: BucketUnit,
  offsetSeconds: number,
): number {
  const width = BUCKET_SECONDS[unit]
  return Math.floor((seconds + offsetSeconds) / width) * width - offsetSeconds
}

/**
 * SQL form of {@link bucketStartSeconds}, for `GROUP BY`.
 *
 * The outer `CAST(... AS INTEGER)` around the division is load-bearing, not
 * defensive. SQLite's `/` yields a REAL as soon as either operand is one, and a
 * `mode:'timestamp'` column can hold a float — so without the cast the quotient
 * comes back as e.g. 20641.9 and the whole expression as 1783401496.0000002.
 * Every row then lands in its own unique bucket, nothing matches the gap-filled
 * sequence, and every chart silently renders empty. Mocked route tests cannot
 * catch this; the real-SQLite test in `__tests__/time-buckets.test.ts` does.
 *
 * Note the cast truncates toward zero rather than flooring, which diverges from
 * the JS helper only for pre-1970 timestamps — impossible for run records.
 */
/**
 * The column's value as **epoch seconds**, whatever the backend stores.
 *
 * SQLite keeps these timestamps as an integer epoch already, so `CAST(... AS
 * INTEGER)` is a no-op that only strips the drizzle type. PostgreSQL stores
 * `timestamptz`, where that cast is not merely unnecessary but invalid — the
 * arithmetic below needs a number, so the instant has to be extracted first.
 */
function epochSeconds(col: SQLiteColumn) {
  if (isPostgresRuntime()) {
    return sql`EXTRACT(EPOCH FROM ${col})`
  }
  return sql`CAST(${col} AS INTEGER)`
}

export function bucketStartSql(col: SQLiteColumn, unit: BucketUnit, offsetSeconds: number) {
  const width = BUCKET_SECONDS[unit]
  // FLOOR, not CAST-to-INTEGER: PostgreSQL's `/` on numerics keeps the
  // fractional part (and its integer cast rounds), so bucketing without an
  // explicit floor would assign instants to the wrong bucket near a boundary.
  if (isPostgresRuntime()) {
    // The width/offset are embedded as literals rather than bound parameters.
    // PostgreSQL matches a GROUP BY expression to its SELECT counterpart
    // *syntactically*, and drizzle numbers placeholders per occurrence — so the
    // same helper renders `$1,$2` in the SELECT and `$6,$7` in the GROUP BY,
    // and the server rejects it as an ungrouped column. Both are server-computed
    // integers (a bucket width and a validated UTC offset), never user text.
    return sql<number>`(FLOOR((${epochSeconds(col)} + ${literalInt(offsetSeconds)}) / ${literalInt(width)}) * ${literalInt(width)} - ${literalInt(offsetSeconds)})`
  }
  return sql<number>`(CAST((${epochSeconds(col)} + ${offsetSeconds}) / ${width} AS INTEGER) * ${width} - ${offsetSeconds})`
}

/**
 * The same expression as plain SQL text over a named parameter, so it can be
 * exercised against a real SQLite connection in tests. Kept beside
 * {@link bucketStartSql} precisely so the two cannot drift.
 */
export function rawBucketExpression(param: string, unit: BucketUnit, offsetSeconds: number) {
  const width = BUCKET_SECONDS[unit]
  return `(CAST((CAST(:${param} AS INTEGER) + ${offsetSeconds}) / ${width} AS INTEGER) * ${width} - ${offsetSeconds})`
}

/** Number of buckets an inclusive [from, to] range spans. */
export function bucketCount(
  fromSeconds: number,
  toSeconds: number,
  unit: BucketUnit,
  offsetSeconds: number,
): number {
  const width = BUCKET_SECONDS[unit]
  const first = bucketStartSeconds(fromSeconds, unit, offsetSeconds)
  const last = bucketStartSeconds(toSeconds, unit, offsetSeconds)
  return Math.floor((last - first) / width) + 1
}

/**
 * Start instant for a "last N days" preset, inclusive of today.
 *
 * `days = 7` means today plus the six days before it — seven buckets total.
 * Using `days` directly would produce eight columns.
 */
export function presetRangeStart(nowSeconds: number, days: number, offsetSeconds: number): number {
  const todayStart = bucketStartSeconds(nowSeconds, 'day', offsetSeconds)
  return todayStart - (days - 1) * BUCKET_SECONDS.day
}

/** Every bucket start in an inclusive range, ascending. */
export function bucketSequence(
  fromSeconds: number,
  toSeconds: number,
  unit: BucketUnit,
  offsetSeconds: number,
): number[] {
  const width = BUCKET_SECONDS[unit]
  const first = bucketStartSeconds(fromSeconds, unit, offsetSeconds)
  const last = bucketStartSeconds(toSeconds, unit, offsetSeconds)
  const out: number[] = []
  for (let s = first; s <= last; s += width) out.push(s)
  return out
}
