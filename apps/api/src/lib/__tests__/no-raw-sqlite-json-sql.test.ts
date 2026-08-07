/**
 * `json_each` / `json_extract` are SQLite-only. PostgreSQL has neither, so a
 * query carrying them does not degrade — it raises `function ... does not exist`
 * and the endpoint 500s.
 *
 * Regression: three sites survived the dialect migration untouched
 * (`providers.ts` dependency lookup, and the stats / chatId queries in
 * `agents.ts`). Each was a live 500 on PostgreSQL — verified by reverting the
 * fix against a real server and watching `GET /providers/:id/dependents` return
 * 500 instead of 200. The dialect-neutral helpers in `lib/json-sql.ts` already
 * existed; they just were not used.
 *
 * A source scan rather than a runtime test, because catching this at runtime
 * needs a live PostgreSQL server AND a request that reaches the specific query —
 * which is exactly why these three slipped through in the first place.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../..')

/** The helpers themselves legitimately emit this SQL inside their SQLite branch. */
const ALLOWED = new Set([resolve(SRC, 'lib/json-sql.ts')])

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

/** Strip comments so prose naming the functions cannot trip the scan. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('no raw SQLite-only JSON SQL outside the dialect helpers', () => {
  it('uses lib/json-sql.ts instead of inline json_each / json_extract', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (ALLOWED.has(file)) continue
      const body = code(readFileSync(file, 'utf-8'))
      // Widened past the two that shipped (review): json_set / json_type /
      // json_patch / json_remove are equally SQLite-only, and json_type is what
      // the `jsonPathIsAbsent` SQLite branch uses — so a copy-paste of that
      // branch into a route would fail on PostgreSQL the same way.
      if (/\bjson_(each|extract|set|type|patch|remove|array_length)\s*\(/.test(body)) {
        offenders.push(file.slice(SRC.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })

  it('scans a meaningful number of files, so a broken walk cannot pass vacuously', () => {
    expect([...walk(SRC)].length).toBeGreaterThan(100)
  })
})
