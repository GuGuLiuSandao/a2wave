import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  BUCKET_SECONDS,
  MAX_BUCKETS,
  bucketCount,
  bucketForBoundaries,
  bucketStartSeconds,
  localDaySequence,
  localDayStartSeconds,
  presetRangeStart,
  rawBucketExpression,
  zoneOffsetSecondsAt,
} from '../time-buckets.js'

/**
 * The offset convention is the single most error-prone part of this module, so
 * it gets asserted directly rather than only through the route: JS
 * `getTimezoneOffset()` returns *inverted minutes* (UTC+8 → -480), so the
 * caller must pass `-getTimezoneOffset() * 60`. Getting the sign wrong shifts
 * every bucket by twice the timezone, which still produces a plausible-looking
 * chart — the failure is silent without these tests.
 */
const UTC_PLUS_8 = 8 * 3600
const UTC_MINUS_5 = -5 * 3600

/** Seconds since epoch for an ISO instant, matching the `mode:'timestamp'` column. */
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

describe('bucketStartSeconds', () => {
  it('floors an instant to the start of its UTC day when there is no offset', async () => {
    expect(bucketStartSeconds(at('2026-07-01T13:45:12Z'), 'day', 0)).toBe(
      at('2026-07-01T00:00:00Z'),
    )
  })

  it('keeps an instant already on a bucket boundary unchanged', async () => {
    expect(bucketStartSeconds(at('2026-07-01T00:00:00Z'), 'day', 0)).toBe(
      at('2026-07-01T00:00:00Z'),
    )
  })

  it('keeps the last second of a day in that same day', async () => {
    expect(bucketStartSeconds(at('2026-07-01T23:59:59Z'), 'day', 0)).toBe(
      at('2026-07-01T00:00:00Z'),
    )
  })

  it('rolls over to the next bucket at the following midnight', async () => {
    expect(bucketStartSeconds(at('2026-07-02T00:00:00Z'), 'day', 0)).toBe(
      at('2026-07-02T00:00:00Z'),
    )
  })

  it('attributes a late-UTC instant to the NEXT local day for a positive offset', async () => {
    // 16:00Z is 2026-07-02 00:00 local in UTC+8, so it belongs to the Jul 2 bucket.
    // Bucketing in plain UTC would wrongly file it under Jul 1.
    expect(bucketStartSeconds(at('2026-07-01T16:00:00Z'), 'day', UTC_PLUS_8)).toBe(
      at('2026-07-01T16:00:00Z'),
    )
    expect(bucketStartSeconds(at('2026-07-01T15:59:59Z'), 'day', UTC_PLUS_8)).toBe(
      at('2026-06-30T16:00:00Z'),
    )
  })

  it('attributes an early-UTC instant to the PREVIOUS local day for a negative offset', async () => {
    // 03:00Z is 2026-06-30 22:00 local in UTC-5, so it belongs to the Jun 30 bucket.
    expect(bucketStartSeconds(at('2026-07-01T03:00:00Z'), 'day', UTC_MINUS_5)).toBe(
      at('2026-06-30T05:00:00Z'),
    )
  })

  it('buckets by hour independently of the day offset', async () => {
    expect(bucketStartSeconds(at('2026-07-01T13:45:12Z'), 'hour', 0)).toBe(
      at('2026-07-01T13:00:00Z'),
    )
  })

  it('exposes bucket widths in seconds', async () => {
    expect(BUCKET_SECONDS.day).toBe(86_400)
    expect(BUCKET_SECONDS.hour).toBe(3600)
  })
})

/**
 * The SQL and the JS must agree, and only a real database can prove it.
 *
 * SQLite's `/` is *floating-point* division whenever it can be — so an
 * expression that looks like integer flooring silently yields values such as
 * 1783401496.0000002, putting every single row in its own bucket. Nothing then
 * matches the gap-filled sequence and every chart renders empty while the
 * mocked route tests still pass. Hence: assert against actual SQLite.
 */
describe('bucketStartSql against real SQLite', () => {
  const evaluate = (seconds: number, unit: 'day' | 'hour', offsetSeconds: number) => {
    const db = new Database(':memory:')
    try {
      const expr = rawBucketExpression('ts', unit, offsetSeconds)
      const row = db.prepare(`SELECT ${expr} AS bucket`).get({ ts: seconds }) as { bucket: number }
      return row.bucket
    } finally {
      db.close()
    }
  }

  it('produces whole seconds, never a fractional bucket', async () => {
    for (const iso of [
      '2026-07-07T09:13:53Z',
      '2026-07-08T14:16:16Z',
      '2026-08-04T02:18:55Z',
      '2026-07-10T11:03:03Z',
    ]) {
      const bucket = evaluate(at(iso), 'day', UTC_PLUS_8)
      expect(Number.isInteger(bucket)).toBe(true)
    }
  })

  it('collapses several instants on the same local day into one bucket', async () => {
    const offset = UTC_PLUS_8
    const buckets = [
      '2026-07-07T09:13:53Z',
      '2026-07-07T09:17:59Z',
      '2026-07-07T16:02:15Z', // already the next local day in UTC+8
    ].map((iso) => evaluate(at(iso), 'day', offset))

    expect(buckets[0]).toBe(buckets[1])
    expect(buckets[2]).not.toBe(buckets[0])
  })

  it('matches the JS helper exactly, for both offsets and both units', async () => {
    for (const offset of [0, UTC_PLUS_8, UTC_MINUS_5]) {
      for (const unit of ['day', 'hour'] as const) {
        for (const iso of [
          '2026-07-07T09:13:53Z',
          '2026-08-04T02:18:55Z',
          '2026-01-01T00:00:00Z',
        ]) {
          expect(evaluate(at(iso), unit, offset)).toBe(bucketStartSeconds(at(iso), unit, offset))
        }
      }
    }
  })
})

describe('bucketCount', () => {
  it('counts an inclusive single-day range as one bucket', async () => {
    expect(bucketCount(at('2026-07-01T00:00:00Z'), at('2026-07-01T23:59:59Z'), 'day', 0)).toBe(1)
  })

  it('counts a full week as seven buckets', async () => {
    expect(bucketCount(at('2026-07-01T00:00:00Z'), at('2026-07-07T23:59:59Z'), 'day', 0)).toBe(7)
  })

  it('counts a single day at hour granularity as 24 buckets', async () => {
    expect(bucketCount(at('2026-07-01T00:00:00Z'), at('2026-07-01T23:59:59Z'), 'hour', 0)).toBe(24)
  })

  it('exceeds MAX_BUCKETS for 90 days of hourly buckets', async () => {
    // The client only ever asks for hourly over <= 2 days, but the endpoint is
    // reachable directly — this is the case the server-side cap must reject.
    const count = bucketCount(at('2026-01-01T00:00:00Z'), at('2026-03-31T23:59:59Z'), 'hour', 0)
    expect(count).toBeGreaterThan(MAX_BUCKETS)
  })
})

describe('presetRangeStart', () => {
  /**
   * "Last 7 days" inclusive of today spans 7 buckets, so the start is today
   * minus SIX days. Off-by-one here silently renders an 8-column chart.
   */
  it('starts the 7-day preset six days back so the range spans seven buckets', async () => {
    const now = at('2026-07-10T09:30:00Z')
    const start = presetRangeStart(now, 7, 0)
    expect(start).toBe(at('2026-07-04T00:00:00Z'))
    expect(bucketCount(start, now, 'day', 0)).toBe(7)
  })

  it('starts the 30-day preset so the range spans thirty buckets', async () => {
    const now = at('2026-07-10T09:30:00Z')
    expect(bucketCount(presetRangeStart(now, 30, 0), now, 'day', 0)).toBe(30)
  })

  it('spans a single bucket for the today preset', async () => {
    const now = at('2026-07-10T09:30:00Z')
    expect(bucketCount(presetRangeStart(now, 1, 0), now, 'day', 0)).toBe(1)
  })

  it('anchors the preset start to local midnight under an offset', async () => {
    const now = at('2026-07-10T09:30:00Z') // 17:30 local in UTC+8
    // Local midnight of Jul 10 in UTC+8 is 2026-07-09T16:00Z.
    expect(presetRangeStart(now, 1, UTC_PLUS_8)).toBe(at('2026-07-09T16:00:00Z'))
  })
})

/**
 * DST. A single scalar UTC offset cannot describe a range that crosses a
 * transition, and the UI routinely offers 30- and 90-day ranges that do. These
 * assertions use America/Los_Angeles, which springs forward on 2026-03-08 and
 * falls back on 2026-11-01.
 */
describe('local day boundaries across DST', () => {
  const LA = 'America/Los_Angeles'
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)

  it('reports the offset in force at each instant, not a single one', async () => {
    expect(zoneOffsetSecondsAt(LA, at('2026-01-15T12:00:00Z'))).toBe(-8 * 3600) // PST
    expect(zoneOffsetSecondsAt(LA, at('2026-07-15T12:00:00Z'))).toBe(-7 * 3600) // PDT
  })

  it('floors to real local midnight on both sides of a transition', async () => {
    // Winter: midnight PST is 08:00Z. Summer: midnight PDT is 07:00Z.
    expect(localDayStartSeconds(at('2026-01-15T20:00:00Z'), LA)).toBe(at('2026-01-15T08:00:00Z'))
    expect(localDayStartSeconds(at('2026-07-15T20:00:00Z'), LA)).toBe(at('2026-07-15T07:00:00Z'))
  })

  it('floors an instant just after spring-forward into the correct day', async () => {
    // 2026-03-08 02:00 PST -> 03:00 PDT. 10:30Z is 03:30 local, still Mar 8.
    // A fixed winter offset would have floored this into Mar 7.
    expect(localDayStartSeconds(at('2026-03-08T10:30:00Z'), LA)).toBe(at('2026-03-08T08:00:00Z'))
  })

  it('emits one entry per local day, with a 23-hour spring-forward day', async () => {
    const days = localDaySequence(at('2026-03-07T09:00:00Z'), at('2026-03-10T09:00:00Z'), LA)
    expect(days).not.toBeNull()
    expect(days).toEqual([
      at('2026-03-07T08:00:00Z'), // Mar 7 00:00 PST
      at('2026-03-08T08:00:00Z'), // Mar 8 00:00 PST — this day is 23h long
      at('2026-03-09T07:00:00Z'), // Mar 9 00:00 PDT
      at('2026-03-10T07:00:00Z'),
    ])
    // The transition day really is 23 hours, which a fixed 86400 cannot express.
    expect((days as number[])[2] - (days as number[])[1]).toBe(23 * 3600)
  })

  it('emits a 25-hour fall-back day', async () => {
    const days = localDaySequence(at('2026-10-31T08:00:00Z'), at('2026-11-02T09:00:00Z'), LA)
    expect(days).not.toBeNull()
    const d = days as number[]
    expect(d[2] - d[1]).toBe(25 * 3600) // Nov 1 is 25 hours
  })

  it('assigns runs on a transition day to that day, not its neighbour', async () => {
    const days = localDaySequence(
      at('2026-03-07T09:00:00Z'),
      at('2026-03-10T09:00:00Z'),
      LA,
    ) as number[]
    // 03:30 local on Mar 8, i.e. after the clocks jumped.
    expect(bucketForBoundaries(at('2026-03-08T11:30:00Z'), days)).toBe(at('2026-03-08T08:00:00Z'))
    // 23:30 local on Mar 8, the last half hour of the short day.
    expect(bucketForBoundaries(at('2026-03-09T06:30:00Z'), days)).toBe(at('2026-03-08T08:00:00Z'))
    // 00:30 local on Mar 9 belongs to the next day.
    expect(bucketForBoundaries(at('2026-03-09T07:30:00Z'), days)).toBe(at('2026-03-09T07:00:00Z'))
  })

  it('falls back rather than throwing on an unusable zone', async () => {
    expect(zoneOffsetSecondsAt('Not/AZone', 0)).toBeNull()
    expect(localDayStartSeconds(0, 'Not/AZone')).toBeNull()
    expect(localDaySequence(0, 86_400, 'Not/AZone')).toBeNull()
  })

  it('treats a zero-offset zone as offset 0, not as unparseable', async () => {
    expect(zoneOffsetSecondsAt('UTC', at('2026-01-15T12:00:00Z'))).toBe(0)
  })
})
