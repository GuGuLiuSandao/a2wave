/**
 * PostgreSQL is shipped as EXPERIMENTAL, and the operator has to be told so at
 * runtime rather than only in the docs — choosing the backend is a deliberate
 * opt-in with a real consequence (no production soak time, and no
 * SQLite -> PostgreSQL data migration path).
 *
 * `db/client.ts` cannot be imported in a unit test: it opens a real SQLite file
 * or a pg Pool as a side effect of import. So this asserts on the source text,
 * the same approach `startup-readiness-order.test.ts` and
 * `dockerfile-mcp-build.test.ts` take for wiring that is unreachable at runtime.
 *
 * The point of pinning it: a warning that quietly disappears in a refactor would
 * leave operators believing the backend is supported.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../client.ts'), 'utf-8')

/** Source with comments stripped, so prose mentioning the wording cannot satisfy an assertion. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

describe('PostgreSQL experimental warning', () => {
  it('warns at import time when PostgreSQL is selected', () => {
    expect(code).toMatch(/if\s*\(isPostgres\)\s*\{[\s\S]*?console\.warn\(/)
  })

  it('says EXPERIMENTAL, so the wording cannot be softened without failing here', () => {
    const warning = code.match(/if\s*\(isPostgres\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(warning).toMatch(/EXPERIMENTAL/)
    expect(warning).toMatch(/docs\/agent\/postgresql\.md/)
  })

  it('is gated on the dialect, so a SQLite deployment stays silent', () => {
    // A bare console.warn outside the isPostgres branch would fire for the
    // default backend, training operators to ignore startup warnings.
    const warnCalls = code.match(/console\.warn\(/g) ?? []
    expect(warnCalls).toHaveLength(1)
    const beforeWarn = code.slice(0, code.indexOf('console.warn('))
    expect(beforeWarn).toMatch(/if\s*\(isPostgres\)\s*\{\s*$/)
  })
})
