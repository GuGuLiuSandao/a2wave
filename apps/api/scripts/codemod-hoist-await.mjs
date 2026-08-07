/**
 * Hoist `await` from a variable's use-sites back to its declaration.
 *
 * The cascade pass awaits wherever TypeScript reported the error, which for a
 * variable holding a Promise means every *use* gets `(await x).y` while the
 * declaration keeps `const x = f()`. That compiles, but it is wrong twice over:
 *
 *   - `if (!x)` is never true, because a Promise is always truthy. That silently
 *     defeated a permission null-check in agent-access.ts — the guard passed for
 *     a nonexistent agent.
 *   - awaiting the same Promise repeatedly is confusing, and any `.catch`
 *     attached later applies to only one use.
 *
 * So: for each `const x = <expr>` whose uses are all `(await x)`, move the await
 * to the declaration and strip it from the uses. Only single-declaration `const`
 * bindings in a function body are touched, and only when the initializer is a
 * call — anything else is left alone.
 *
 * Usage: node scripts/codemod-hoist-await.mjs <file>...
 */
import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

function hoistFile(file) {
  const source = readFileSync(file, 'utf-8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

  // Collect `const x = call(...)` declarations, and every `await x` reference.
  const decls = new Map() // name -> { decl, initializer }
  const awaitedRefs = new Map() // name -> AwaitExpression[]
  const promiseConsumed = new Set() // name -> passed somewhere that wants a Promise

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.declarations.length === 1 &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      decls.set(node.name.text, { decl: node, initializer: node.initializer })
    }

    if (ts.isAwaitExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (!awaitedRefs.has(name)) awaitedRefs.set(name, [])
      awaitedRefs.get(name).push(node)
    } else if (ts.isIdentifier(node) && node.parent) {
      // Promise.all([p]), p.then(...), p.catch(...), return p — these want the
      // Promise itself, so the declaration must keep it un-awaited.
      const p = node.parent
      const wantsPromise =
        (ts.isPropertyAccessExpression(p) &&
          p.expression === node &&
          ['then', 'catch', 'finally'].includes(p.name.text)) ||
        (ts.isArrayLiteralExpression(p) &&
          p.parent &&
          ts.isCallExpression(p.parent) &&
          /Promise\.(all|allSettled|race|any)/.test(p.parent.expression.getText(sf)))
      if (wantsPromise) promiseConsumed.add(node.text)
    }

    ts.forEachChild(node, visit)
  }
  visit(sf)

  const edits = []
  for (const [name, refs] of awaitedRefs) {
    const d = decls.get(name)
    if (!d) continue
    // A plain (non-awaited) reference alongside awaited ones is almost always a
    // log/debug line that happens to interpolate the variable — hoisting is still
    // correct there, and leaving the Promise un-awaited at the declaration is
    // what causes the always-truthy bug. Only skip when the variable is handed to
    // something that genuinely wants the Promise.
    if (promiseConsumed.has(name)) continue
    const initText = source.slice(d.initializer.getStart(sf), d.initializer.getEnd())
    if (/^await\b/.test(initText.trim())) continue

    edits.push({
      start: d.initializer.getStart(sf),
      end: d.initializer.getEnd(),
      text: `await ${initText}`,
    })
    for (const ref of refs) {
      // `await x` -> `x`; the surrounding parens, if any, are harmless.
      edits.push({ start: ref.getStart(sf), end: ref.getEnd(), text: name })
    }
  }

  if (edits.length === 0) return 0
  edits.sort((a, b) => b.start - a.start)
  let out = source
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  writeFileSync(file, out)
  return edits.length
}

const files = process.argv.slice(2)
let total = 0
for (const f of files) {
  const n = hoistFile(f)
  if (n) {
    console.log(`${f}: ${n} edits`)
    total += n
  }
}
console.log(`total: ${total}`)
