/**
 * AST-based sync→async conversion for the drizzle call sites.
 *
 * Replaces the earlier regex attempt, which could not tell a class-method
 * declaration (`execute(ctx) {`) from a call (`logAudit(c, {`) and so produced
 * `await execute(...)` in a class body. Text patterns cannot make that
 * distinction; the parser can, so this walks the real syntax tree.
 *
 * Two transforms, applied together per file:
 *
 *  1. Call sites: `X.get()` → `(await X.limit(1))[0]`, `X.all()` / `X.run()`
 *     → `await X`. Only for chains rooted at `db` or `tx`, so unrelated `.get()`
 *     methods (Hono's `c.get`, `Map#get`, `FormData#get`) are untouched.
 *  2. Enclosing functions: any function/method/arrow that now contains a
 *     top-level `await` gets `async`, and its explicit return type is wrapped in
 *     `Promise<...>` when it is not already.
 *
 * Emitting: edits are collected as (start, end, text) replacements and applied
 * back-to-front on the original source, so formatting outside the touched ranges
 * is preserved exactly. Run biome afterwards.
 *
 * Usage: node scripts/codemod-async-db.mjs <file>...
 */
import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

/** Is this call chain rooted at the `db` or `tx` identifier? */
function rootsAtDb(node) {
  let current = node
  for (;;) {
    if (ts.isIdentifier(current)) return current.text === 'db' || current.text === 'tx'
    if (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
      current = ts.isCallExpression(current) ? current.expression : current.expression
      continue
    }
    if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression
      continue
    }
    return false
  }
}

/** The nearest enclosing function-like node, or undefined at module scope. */
function enclosingFunction(node) {
  let p = node.parent
  while (p) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isConstructorDeclaration(p)
    ) {
      return p
    }
    p = p.parent
  }
  return undefined
}

function convertFile(file) {
  const source = readFileSync(file, 'utf-8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

  const edits = []
  const needAsync = new Set()
  const skipped = []

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text
      if (
        (method === 'get' || method === 'all' || method === 'run') &&
        rootsAtDb(node.expression)
      ) {
        const chain = node.expression.expression // the builder, without .get()/.all()/.run()
        const chainText = source.slice(chain.getStart(sf), chain.getEnd())
        const fn = enclosingFunction(node)

        // A generator or constructor cannot be async; leave it for a human.
        if (fn && (ts.isConstructorDeclaration(fn) || fn.asteriskToken)) {
          skipped.push(`${file}: .${method}() inside a constructor/generator`)
        } else {
          if (fn) needAsync.add(fn)
          if (method === 'get') {
            const alreadyLimited = /\.limit\(\s*1\s*\)\s*$/.test(chainText)
            const body = alreadyLimited ? chainText : `${chainText}.limit(1)`
            edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `(await ${body})[0]` })
          } else {
            edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `await ${chainText}` })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // Mark enclosing functions async (and widen their return type).
  for (const fn of needAsync) {
    const isAsync = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    if (!isAsync) {
      // Insert `async` at the right anchor for each function form.
      let anchor
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        anchor = fn.getStart(sf)
      } else if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) {
        // After any modifiers (export/static/public), before `function`/name.
        const last = fn.modifiers?.[fn.modifiers.length - 1]
        anchor = last ? last.getEnd() + 1 : fn.getStart(sf)
      }
      if (anchor !== undefined) edits.push({ start: anchor, end: anchor, text: 'async ' })
    }
    // Wrap an explicit non-Promise return type.
    if (fn.type) {
      const t = source.slice(fn.type.getStart(sf), fn.type.getEnd())
      if (!/^Promise\s*</.test(t.trim())) {
        edits.push({
          start: fn.type.getStart(sf),
          end: fn.type.getEnd(),
          text: `Promise<${t}>`,
        })
      }
    }
  }

  if (edits.length === 0) return { changed: false, converted: 0, skipped }

  // Apply back-to-front; a zero-width insert must land after a replacement at
  // the same offset, so sort inserts last within equal starts.
  edits.sort((a, b) => b.start - a.start || b.end - b.start - (a.end - a.start))
  let out = source
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)

  writeFileSync(file, out)
  return { changed: true, converted: edits.length, skipped }
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/codemod-async-db.mjs <file>...')
  process.exit(1)
}

let total = 0
const allSkipped = []
for (const file of files) {
  const r = convertFile(file)
  total += r.converted
  allSkipped.push(...r.skipped)
  if (r.changed) console.log(`${file}: ${r.converted} edits`)
}
console.log(`\ntotal edits: ${total}`)
if (allSkipped.length) {
  console.log('\nneeds manual handling:')
  for (const s of allSkipped) console.log(`  ${s}`)
}
