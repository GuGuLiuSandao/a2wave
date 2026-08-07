/**
 * Second phase of the sync→async conversion: insert the `await`s that the newly
 * async functions require, and mark their callers async in turn.
 *
 * Compiler-driven rather than heuristic. Each pass reads `tsc` diagnostics and
 * acts only on positions TypeScript itself flagged:
 *
 *   "Property 'x' does not exist on type 'Promise<T>'"  → await the expression
 *   "Type 'Promise<T>' is not assignable to type 'T'"   → await the expression
 *   "This expression is not callable ... Promise<...>"  → await the expression
 *   TS1308 ('await' outside async)                      → async the enclosing fn
 *   TS2801 (conditional on a Promise)                   → await the expression
 *
 * The insertion point is found by parsing the file and locating the smallest
 * expression node that starts at the reported position, then awaiting *that*
 * node — which is why this cannot be done with text patterns: `foo.bar()` needs
 * `(await foo).bar()` or `await foo.bar()` depending on which part is the
 * Promise, and only the AST plus the diagnostic together identify it.
 *
 * Iterates until the error count stops falling. Whatever remains is genuinely
 * not mechanical and is left for a human.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

function diagnostics() {
  try {
    execFileSync('npx', ['tsc', '--noEmit'], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 })
    return []
  } catch (err) {
    return String(err.stdout ?? '')
      .split('\n')
      .map((l) => /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ file: m[1], line: +m[2], col: +m[3], code: m[4], msg: m[5] }))
  }
}

/** Does this diagnostic mean "you forgot to await"? */
function isMissingAwait(d) {
  if (d.code === 'TS2801') return true
  if (d.code === 'TS2339' && /does not exist on type 'Promise</.test(d.msg)) return true
  // An un-awaited drizzle query builder: `.all()` was removed by phase 1 but the
  // expression was never awaited, so array methods are missing on the builder.
  if (d.code === 'TS2339' && /does not exist on type '(Omit<)?(SQLite|Pg)SelectBase/.test(d.msg)) {
    return true
  }
  if (
    d.code === 'TS2339' &&
    /does not exist on type '(SQLite|Pg)(Insert|Update|Delete)Base/.test(d.msg)
  ) {
    return true
  }
  if (d.code === 'TS2322' && /^Type 'Promise</.test(d.msg)) return true
  if (d.code === 'TS2345' && /^Argument of type 'Promise</.test(d.msg)) return true
  if (d.code === 'TS2349' && /Promise</.test(d.msg)) return true
  if (d.code === 'TS2488' && /Promise</.test(d.msg)) return true
  if (d.code === 'TS2740' && /Promise</.test(d.msg)) return true
  if (d.code === 'TS2367' && /Promise</.test(d.msg)) return true
  if (d.code === 'TS18048' && /Promise</.test(d.msg)) return true
  return false
}

function offsetOf(sf, line, col) {
  return ts.getPositionOfLineAndCharacter(sf, line - 1, col - 1)
}

/**
 * The expression to await for a diagnostic at `pos`.
 *
 * For "Property 'x' does not exist on Promise<T>" the reported position is the
 * property name, so the Promise is the object of that access — award `(await
 * obj).x`. For the assignment/argument cases the position is the whole
 * expression, so it is awaited directly.
 */
function targetFor(sf, pos, code) {
  let best
  const visit = (node) => {
    if (node.getStart(sf) <= pos && pos < node.getEnd()) {
      if (
        code === 'TS2339' &&
        ts.isPropertyAccessExpression(node) &&
        node.name.getStart(sf) === pos
      ) {
        best = { node: node.expression, parenthesize: true }
      } else if (
        (ts.isCallExpression(node) ||
          ts.isIdentifier(node) ||
          ts.isPropertyAccessExpression(node)) &&
        node.getStart(sf) === pos &&
        !best
      ) {
        best = { node, parenthesize: false }
      }
      ts.forEachChild(node, visit)
    }
  }
  ts.forEachChild(sf, visit)
  return best
}

function enclosingFunction(node) {
  let p = node.parent
  while (p) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isConstructorDeclaration(p)
    ) {
      return p
    }
    p = p.parent
  }
  return undefined
}

function applyAwaits(diags) {
  const byFile = new Map()
  for (const d of diags.filter(isMissingAwait)) {
    if (!byFile.has(d.file)) byFile.set(d.file, [])
    byFile.get(d.file).push(d)
  }

  let applied = 0
  for (const [file, items] of byFile) {
    const source = readFileSync(file, 'utf-8')
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const edits = []
    const needAsync = new Set()
    const seen = new Set()

    for (const d of items) {
      let pos
      try {
        pos = offsetOf(sf, d.line, d.col)
      } catch {
        continue
      }
      const t = targetFor(sf, pos, d.code)
      if (!t) continue
      const start = t.node.getStart(sf)
      const end = t.node.getEnd()
      const key = `${start}:${end}`
      if (seen.has(key)) continue
      const text = source.slice(start, end)
      if (/^\(?await\b/.test(text.trim())) continue // already awaited
      seen.add(key)

      const fn = enclosingFunction(t.node)
      if (fn && (ts.isConstructorDeclaration(fn) || fn.asteriskToken)) continue

      // Two positions where a bare `await X` is a syntax error, because the
      // identifier is not in an expression slot:
      //
      //   { X }          shorthand property — must become `X: await X`
      //   X = ...        assignment target — the Promise is on the right
      //
      // Both were produced by an earlier revision of this script and caught by
      // the syntax-error guard below; handling them here keeps the pass safe.
      const parent = t.node.parent
      if (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === t.node) {
        edits.push({ start, end, text: `${text}: await ${text}` })
        if (fn) needAsync.add(fn)
        applied++
        continue
      }
      // Inside a destructuring pattern (`const { a, b } = promise`) the reported
      // node is a binding name, not an expression. The fix belongs on the
      // initializer, which a later pass reaches on its own diagnostic; awaiting a
      // binding name here would be a syntax error.
      let inBinding = t.node.parent
      let isBinding = false
      while (inBinding) {
        if (
          ts.isBindingElement(inBinding) ||
          ts.isObjectBindingPattern(inBinding) ||
          ts.isArrayBindingPattern(inBinding)
        ) {
          isBinding = true
          break
        }
        if (ts.isStatement(inBinding) || ts.isSourceFile(inBinding)) break
        inBinding = inBinding.parent
      }
      if (isBinding) continue

      // `{ key: value }` where the reported node is the KEY. Awaiting a property
      // name is a syntax error; the Promise is the value.
      if (parent && ts.isPropertyAssignment(parent) && parent.name === t.node) {
        const vStart = parent.initializer.getStart(sf)
        const vEnd = parent.initializer.getEnd()
        const vText = source.slice(vStart, vEnd)
        if (!/^\(?await\b/.test(vText.trim()) && !seen.has(`${vStart}:${vEnd}`)) {
          seen.add(`${vStart}:${vEnd}`)
          edits.push({ start: vStart, end: vEnd, text: `await ${vText}` })
          if (fn) needAsync.add(fn)
          applied++
        }
        continue
      }

      if (
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === t.node
      ) {
        // Awaiting the assignment *target* is meaningless; skip and let a human
        // look at the right-hand side.
        continue
      }

      if (fn) needAsync.add(fn)
      edits.push({
        start,
        end,
        text: t.parenthesize ? `(await ${text})` : `await ${text}`,
      })
      applied++
    }

    for (const fn of needAsync) {
      const isAsync = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      if (!isAsync) {
        let anchor
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) anchor = fn.getStart(sf)
        else {
          const last = fn.modifiers?.[fn.modifiers.length - 1]
          anchor = last ? last.getEnd() + 1 : fn.getStart(sf)
        }
        edits.push({ start: anchor, end: anchor, text: 'async ' })
      }
      if (fn.type) {
        const t = source.slice(fn.type.getStart(sf), fn.type.getEnd())
        if (!/^Promise\s*</.test(t.trim())) {
          edits.push({ start: fn.type.getStart(sf), end: fn.type.getEnd(), text: `Promise<${t}>` })
        }
      }
    }

    if (edits.length === 0) continue
    edits.sort((a, b) => b.start - a.start || b.end - b.start - (a.end - a.start))
    let out = source
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
    writeFileSync(file, out)
  }
  return applied
}

/** TS1308: `await` used in a function that is not async yet. */
function applyAsyncScope(diags) {
  const byFile = new Map()
  for (const d of diags.filter((x) => x.code === 'TS1308')) {
    if (!byFile.has(d.file)) byFile.set(d.file, [])
    byFile.get(d.file).push(d)
  }
  let applied = 0
  for (const [file, items] of byFile) {
    const source = readFileSync(file, 'utf-8')
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const edits = []
    const done = new Set()

    for (const d of items) {
      let pos
      try {
        pos = offsetOf(sf, d.line, d.col)
      } catch {
        continue
      }
      let target
      const visit = (node) => {
        if (node.getStart(sf) <= pos && pos < node.getEnd()) {
          if (ts.isAwaitExpression(node)) target = node
          ts.forEachChild(node, visit)
        }
      }
      ts.forEachChild(sf, visit)
      if (!target) continue
      const fn = enclosingFunction(target)
      if (!fn || done.has(fn) || ts.isConstructorDeclaration(fn) || fn.asteriskToken) continue
      done.add(fn)

      let anchor
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) anchor = fn.getStart(sf)
      else {
        const last = fn.modifiers?.[fn.modifiers.length - 1]
        anchor = last ? last.getEnd() + 1 : fn.getStart(sf)
      }
      edits.push({ start: anchor, end: anchor, text: 'async ' })
      if (fn.type) {
        const t = source.slice(fn.type.getStart(sf), fn.type.getEnd())
        if (!/^Promise\s*</.test(t.trim())) {
          edits.push({ start: fn.type.getStart(sf), end: fn.type.getEnd(), text: `Promise<${t}>` })
        }
      }
      applied++
    }

    if (edits.length === 0) continue
    edits.sort((a, b) => b.start - a.start)
    let out = source
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
    writeFileSync(file, out)
  }
  return applied
}

let previous = Number.POSITIVE_INFINITY
for (let pass = 1; pass <= 20; pass++) {
  const diags = diagnostics()
  if (diags.length === 0) {
    console.log(`pass ${pass}: clean`)
    break
  }
  const syntax = diags.filter((d) => /TS100[0-9]|TS11[0-9][0-9]|TS143[0-9]/.test(d.code))
  if (syntax.length > 0) {
    console.log(`pass ${pass}: ABORT — ${syntax.length} syntax errors introduced`)
    for (const s of syntax.slice(0, 5)) console.log(`  ${s.file}(${s.line}) ${s.code} ${s.msg}`)
    break
  }

  const applied = applyAwaits(diags) + applyAsyncScope(diags)
  console.log(`pass ${pass}: ${diags.length} errors — applied ${applied}`)
  if (applied === 0 || diags.length >= previous) {
    console.log('no further mechanical progress')
    break
  }
  previous = diags.length
}
