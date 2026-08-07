/**
 * Upgrade hand-rolled test `db` mocks to the async drizzle shape.
 *
 * ~100 test files build their own mock instead of using `src/test/mock-db.ts`,
 * and terminate chains with the better-sqlite3 synchronous methods:
 *
 *   where: () => ({ get: fn })     // single row
 *   where: () => ({ all: fn })     // row list
 *   where: () => ({ run: fn })     // write
 *
 * Production code now awaits instead — `.limit(1)` then destructure `[row]`, or
 * `await` the builder directly. Rather than rewrite each file's assertions, this
 * wraps such terminator objects in a call to `asyncQuery()` (injected once per
 * file), which returns a thenable that ALSO answers the builder methods. The
 * original `get`/`all`/`run` mocks stay reachable, so existing
 * `expect(dbGet).toHaveBeenCalled()` assertions keep working unchanged.
 *
 * AST-based, not textual: a `{ get: … }` literal only gets wrapped when it is
 * actually the return value of a mock chain method (`from`/`where`/`orderBy`/…),
 * so unrelated object literals with a `get` property are left alone. The earlier
 * regex attempt could not make that distinction and had to be reverted.
 *
 * Usage: node scripts/codemod-mock-async.mjs <file>...
 */
import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

/** Chain methods whose return value is a query-builder node. */
const CHAIN_METHODS = new Set([
  'from',
  'where',
  'orderBy',
  'groupBy',
  'having',
  'limit',
  'offset',
  'values',
  'set',
  'returning',
  'innerJoin',
  'leftJoin',
  'onConflictDoNothing',
  'onConflictDoUpdate',
])

const TERMINATORS = new Set(['get', 'all', 'run'])

const HELPER = `
/**
 * Wrap a legacy sync mock terminator so it works with awaited queries.
 *
 * Production code awaits every query now, so a mock exposing only
 * \`get\`/\`all\`/\`run\` breaks at \`.limit(1)\` or at \`await\`. The returned value is
 * a real thenable (resolving to the row list) that also answers the builder
 * methods, while keeping the original mock fns reachable for assertions.
 */
function asyncQuery(term: Record<string, unknown>): Record<string, unknown> {
  const rows = (): unknown[] => {
    const all = term.all as (() => unknown[]) | undefined
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    const get = term.get as (() => unknown) | undefined
    if (get) {
      const row = get()
      return row == null ? [] : [row]
    }
    const run = term.run as (() => unknown) | undefined
    if (run) run()
    return []
  }
  const make = (): Record<string, unknown> => {
    const node = Object.assign(Promise.resolve().then(rows), term, {
      limit: () => make(),
      orderBy: () => make(),
      offset: () => make(),
      groupBy: () => make(),
      having: () => make(),
      where: () => make(),
      returning: () => make(),
      onConflictDoNothing: () => make(),
      onConflictDoUpdate: () => make(),
      for: () => make(),
    })
    return node as unknown as Record<string, unknown>
  }
  return make()
}
`

function convert(file) {
  const source = readFileSync(file, 'utf-8')
  // Re-runnable: skip objects already wrapped, but still process the rest.
  const alreadyHasHelper = source.includes('function asyncQuery(')

  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const edits = []

  /** Is this object literal the body of a mock chain method returning a builder? */
  const isChainTerminator = (obj) => {
    // Must contain at least one of get/all/run and nothing that looks like a
    // deeper chain (those are handled by their own visit).
    const names = obj.properties
      .filter((p) => p.name && ts.isIdentifier(p.name))
      .map((p) => p.name.text)
    const hasTerminator = names.some((n) => TERMINATORS.has(n))
    const hasChain = names.some((n) => CHAIN_METHODS.has(n))
    // Wrap terminator nodes AND pure chain nodes: production awaits at depths the
    // hand-built mocks never had to answer, so a node with only `where`/`from`
    // still needs `.limit()` and thenable behaviour.
    if (!hasTerminator && !hasChain) return false
    // A node may carry BOTH a terminator and further chain methods — e.g.
    // `{ get, all, orderBy }`. Those still need wrapping (the terminator is what
    // production code no longer calls), and asyncQuery preserves the sibling
    // methods via Object.assign, so nested chains keep working.

    // Its parent must be an arrow/function body or a mockReturnValue argument
    // belonging to a chain method.
    let p = obj.parent
    if (ts.isParenthesizedExpression(p)) p = p.parent
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const q = p.parent
      if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name)) {
        return CHAIN_METHODS.has(q.name.text)
      }
      // `vi.fn(() => ({ get }))` / `.mockReturnValue(() => ...)`
      if (ts.isCallExpression(q)) return true
      return false
    }
    if (ts.isCallExpression(p)) {
      const callee = p.expression
      if (
        ts.isPropertyAccessExpression(callee) &&
        /^mock(Return|Resolved)Value(Once)?$/.test(callee.name.text)
      ) {
        return true
      }
    }
    return false
  }

  const isAlreadyWrapped = (node) => {
    const p = node.parent
    return (
      p &&
      ts.isCallExpression(p) &&
      ts.isIdentifier(p.expression) &&
      p.expression.text === 'asyncQuery'
    )
  }

  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node) && !isAlreadyWrapped(node) && isChainTerminator(node)) {
      const text = source.slice(node.getStart(sf), node.getEnd())
      edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `asyncQuery(${text})` })
      // Keep descending: an inner `{ run: fn }` returned by a nested mock still
      // needs its own wrapper, and the edits are applied back-to-front so an
      // inner replacement composes correctly inside the outer one.
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (edits.length === 0) return { changed: false, count: 0 }

  edits.sort((a, b) => b.start - a.start)
  let out = source
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)

  if (alreadyHasHelper) {
    writeFileSync(file, out)
    return { changed: true, count: edits.length }
  }

  // Inject the helper after the last import DECLARATION, located via the AST.
  // A regex on /^import .*$/ matched the first line of a multi-line
  // `import {\n  a,\n} from '...'` and spliced the helper into the middle of the
  // statement — a syntax error in 14 files. The parser knows the real end.
  const reparsed = ts.createSourceFile(file, out, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  let insertAt = 0
  for (const stmt of reparsed.statements) {
    if (ts.isImportDeclaration(stmt)) insertAt = stmt.getEnd()
  }
  out = `${out.slice(0, insertAt)}\n${HELPER}${out.slice(insertAt)}`

  writeFileSync(file, out)
  return { changed: true, count: edits.length }
}

const files = process.argv.slice(2)
let total = 0
let touched = 0
for (const f of files) {
  const r = convert(f)
  if (r.changed) {
    touched++
    total += r.count
    console.log(`${f}: ${r.count}`)
  }
}
console.log(`\n${touched} files, ${total} chains wrapped`)
