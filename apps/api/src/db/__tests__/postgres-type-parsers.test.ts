/**
 * node-postgres hands back `int8` (OID 20) and `numeric` (OID 1700) as
 * **strings** by default — the driver will not risk precision, since both types
 * can exceed IEEE-754. SQLite returns JS numbers for the same queries, so
 * without a type parser every dual-backend numeric silently changes type on
 * PostgreSQL, and no type error flags it because our queries declare
 * `sql<number>`:
 *
 *   - `EXTRACT(EPOCH FROM ts)` is `numeric` on PostgreSQL 14+, so time-series
 *     bucket keys arrived as `"1783401600"` while the bucket lookup used a
 *     number. Every lookup missed and the charts rendered as all zeros.
 *   - `SUM(...)` over token counts became a string, so the frontend's
 *     `input + output` concatenated instead of adding.
 *
 * Testing approach — source text, deliberately:
 *
 * `db/client.ts` cannot be imported in a unit test. Importing it opens a real
 * SQLite file or constructs a pg Pool as an import-time side effect, and it
 * calls `process.exit(1)` on failure. That is the same constraint
 * `experimental-warning.test.ts` works around, so this file follows the
 * established pattern here: assert the registration wiring on the source text.
 *
 * The parser's *semantics* are not asserted on text, though — that would only
 * pin the spelling. The `asNumber` body is extracted from the real source and
 * evaluated, so the behavioural cases below run against the actual shipped
 * logic. `registerPostgresTypeParsers` therefore stays module-private: nothing
 * is exported purely to be testable.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../client.ts'), 'utf-8')

/** Source with comments stripped, so prose mentioning an OID cannot satisfy an assertion. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

describe('PostgreSQL type parser registration', () => {
  it('registers a parser for int8 (OID 20) and numeric (OID 1700)', () => {
    // These two OIDs are the whole bug. 20 covers bigint columns and every
    // `SUM()` over an integer; 1700 covers EXTRACT(EPOCH ...) and casts to
    // numeric, which is how the token aggregates are written.
    expect(code).toMatch(/setTypeParser\(\s*20\s*,/)
    expect(code).toMatch(/setTypeParser\(\s*1700\s*,/)
  })

  it('installs the parsers before the pool is constructed', () => {
    // Registration is process-global on the pg module, but it must happen on
    // the PostgreSQL path before any query can run.
    const poolFn = code.match(/function openPostgresPool\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    expect(poolFn).toMatch(/registerPostgresTypeParsers\(\)/)
    expect(poolFn.indexOf('registerPostgresTypeParsers()')).toBeLessThan(
      poolFn.indexOf('new pg.Pool('),
    )
  })

  it('leaves the timestamp OIDs alone, which drizzle maps itself', () => {
    // Hijacking 1114/1184 would fight drizzle's own timestamp mappers.
    expect(code).not.toMatch(/setTypeParser\(\s*111[0-9]\s*,/)
    expect(code).not.toMatch(/setTypeParser\(\s*118[0-9]\s*,/)
  })
})

/**
 * The real `asNumber` body, lifted out of client.ts and compiled.
 *
 * Extracting rather than re-implementing is the point: a copy would keep
 * passing after the shipped guard was changed or dropped.
 */
function loadAsNumber(): (value: string) => number | string {
  const body = source.match(
    /const asNumber = \(value: string\): number \| string => \{([\s\S]*?)\n {2}\}/,
  )?.[1]
  // Reported as a failed assertion, not a thrown collection error: deleting the
  // parser must show up as red tests naming the behaviour that was lost, rather
  // than as a file that quietly collects nothing.
  expect(body, 'asNumber not found in db/client.ts — has the parser been removed?').toBeTruthy()
  return new Function('value', body as string) as (value: string) => number | string
}

describe('asNumber parser semantics', () => {
  /** Loaded per test, so a missing parser fails each case rather than the file. */
  const asNumber = (value: string): number | string => loadAsNumber()(value)

  it('converts a plain bigint string to a number', () => {
    // The SUM() case: token totals must add, not concatenate.
    expect(asNumber('42')).toBe(42)
    expect(typeof asNumber('42')).toBe('number')
  })

  it('converts an epoch-seconds bucket key to a number', () => {
    // The exact value from the failing chart: EXTRACT(EPOCH FROM ts) is numeric
    // on PG 14+, and the bucket map is keyed by number.
    expect(asNumber('1783401600')).toBe(1783401600)
    expect(typeof asNumber('1783401600')).toBe('number')
  })

  it('converts a numeric with decimals to a number', () => {
    // numeric (OID 1700) is not always integral — EXTRACT(EPOCH ...) carries
    // fractional seconds, and a cost aggregate carries cents.
    expect(asNumber('12.5')).toBe(12.5)
    expect(typeof asNumber('12.5')).toBe('number')
    expect(asNumber('0.001')).toBe(0.001)
  })

  it('converts zero and negatives rather than falling through', () => {
    expect(asNumber('0')).toBe(0)
    expect(asNumber('-7')).toBe(-7)
  })

  it('keeps a value beyond 2^53 as a string instead of corrupting it silently', () => {
    // Number.MAX_SAFE_INTEGER + 2. Converting would round to a neighbouring
    // double and the caller would never know, so the guard hands back the
    // original text — a visibly wrong type beats an invisibly wrong value.
    const beyondSafe = '9007199254740993'
    // Precondition, stated against the string: a double cannot round-trip this,
    // which is exactly why the guard has to keep the original text. (Comparing
    // to a numeric literal would be meaningless — the literal rounds too.)
    expect(String(Number(beyondSafe))).not.toBe(beyondSafe)
    expect(asNumber(beyondSafe)).toBe(beyondSafe)
    expect(typeof asNumber(beyondSafe)).toBe('string')
  })

  it('keeps a full int8 maximum as a string', () => {
    const int8Max = '9223372036854775807'
    expect(asNumber(int8Max)).toBe(int8Max)
    expect(typeof asNumber(int8Max)).toBe('string')
  })

  it('keeps a high-precision decimal that a double cannot round-trip', () => {
    // 20 significant digits: Number() would silently truncate the tail.
    const precise = '1.2345678901234567890'
    expect(asNumber(precise)).toBe(precise)
    expect(typeof asNumber(precise)).toBe('string')
  })
})
