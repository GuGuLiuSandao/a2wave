/**
 * `.get()` / `.all()` / `.run()` are better-sqlite3-only drizzle terminators.
 * The node-postgres builder has none of them, so a leftover call is a plain
 * `TypeError: ....all is not a function` at request time on PostgreSQL.
 *
 * Regression: `getSettingsVersions()` kept a `.all()` through the whole
 * migration. It took down `GET /api/settings`, the PATCH optimistic-concurrency
 * check, and `GET /api/settings/:category` — the entire settings page — on
 * PostgreSQL, and was found by review rather than by any gate.
 *
 * **`tsc` cannot catch this.** `db/client.ts` casts the handle to the *SQLite*
 * builder type so the ~76 pre-existing call sites keep compiling, which means
 * these terminators typecheck perfectly while being absent at runtime. A source
 * scan is the only cheap gate available, which is the reviewer's point and why
 * this exists.
 *
 * Deliberately NOT flagged: the same method names on the raw better-sqlite3
 * handle (`sqliteDatabase.prepare(...).all()`). Those are the driver's own API
 * on SQLite-only maintenance paths (journal repair, timestamp fixups) that are
 * already gated on `isPostgres`, so they are correct exactly as written.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../..')

/** Mock/test helpers deliberately re-expose the legacy terminator shape. */
const ALLOWED = new Set([resolve(SRC, 'test/mock-db.ts'), resolve(SRC, 'test/async-query.ts')])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      yield* walk(full)
      continue
    }
    if (entry.endsWith('.ts')) yield full
  }
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * A terminator reached through the raw better-sqlite3 handle rather than a
 * drizzle builder. `.prepare(...)` is the unambiguous marker: it exists only on
 * better-sqlite3, never on a drizzle query builder.
 */
function isRawSqliteHandleCall(line: string): boolean {
  return /\.prepare\(/.test(line) || /\bsqliteDatabase\b/.test(line)
}

describe('no synchronous drizzle terminators outside SQLite-only paths', () => {
  it('has no .get() / .all() / .run() on a drizzle builder', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (ALLOWED.has(file)) continue
      const lines = code(readFileSync(file, 'utf-8')).split('\n')
      lines.forEach((line, i) => {
        if (!/\.\s*(get|all|run)\(\)/.test(line)) return
        if (isRawSqliteHandleCall(line)) return
        // Multi-line chains: the raw handle may be named a line or two above.
        const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
        if (isRawSqliteHandleCall(context)) return
        offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('scans a meaningful number of files, so a broken walk cannot pass vacuously', () => {
    expect([...walk(SRC)].length).toBeGreaterThan(100)
  })
})
