/**
 * Make self-referential mock chain factories awaitable.
 *
 * Several test files build their `db` mock as a single object whose chain methods
 * all return the object itself:
 *
 *   function makeChain() {
 *     const c = {}
 *     for (const k of ['from', 'where']) c[k] = vi.fn(() => c)
 *     c.get = vi.fn()
 *     c.all = vi.fn()
 *     return c
 *   }
 *
 * That shape survives any chain depth but has no `.limit()` and is not awaitable,
 * so it breaks now that production code spells a single-row lookup `.limit(1)`
 * and awaits it.
 *
 * This rewrites the `return c` to return a thenable built from `c`: the same mock
 * fns stay reachable (so `expect(c.get).toHaveBeenCalled()` is unaffected), the
 * chain methods now resolve to the thenable, and awaiting it yields the row list
 * that `.get()` / `.all()` was configured to produce.
 *
 * Usage: node scripts/codemod-chain-factory.mjs <file>...
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** Chain methods that must exist and return the (wrapped) chain. */
const EXTRA_KEYS = ['limit', 'orderBy', 'offset', 'groupBy', 'having', 'returning']

const THENABLE = `
  // Awaiting the chain yields what \`.get()\`/\`.all()\` was configured to return,
  // as an array — production code destructures \`[row]\` from \`.limit(1)\` now.
  // The original mock fns stay reachable, so existing assertions are unaffected.
  const __chain = Object.assign(
    Promise.resolve().then((): unknown[] => {
      const all = c.all as undefined | (() => unknown)
      if (all) {
        const v = all()
        return Array.isArray(v) ? v : v == null ? [] : [v]
      }
      const get = c.get as undefined | (() => unknown)
      if (get) {
        const row = get()
        return row == null ? [] : [row]
      }
      const run = c.run as undefined | (() => unknown)
      if (run) run()
      return []
    }),
    c,
  )
  for (const k of Object.keys(c)) {
    const fn = c[k] as unknown
    if (typeof fn === 'function' && !['get', 'all', 'run'].includes(k)) {
      ;(__chain as Record<string, unknown>)[k] = fn
    }
  }
  return __chain as unknown as typeof c
`

function convert(file) {
  let s = readFileSync(file, 'utf-8')
  if (s.includes('const __chain = Object.assign(')) return false

  // Find `function makeChain() { ... return c\n}` blocks.
  const re = /function (makeChain|makeDbChain|chain)\(\)\s*\{([\s\S]*?)\n\s*return c\n\}/g
  let changed = false
  s = s.replace(re, (match, name, body) => {
    // Widen the `for (const k of [...])` list so limit/orderBy exist and point at
    // the wrapped chain rather than the bare object.
    const newBody = body.replace(
      /for \(const k of \[([^\]]*)\]\)\s*(?:\{\s*)?c\[k\] = vi\.fn\(\(\) => c\)\s*\}?/,
      (_m, keys) => {
        const existing = keys
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
        const want = [...new Set([...existing.map((k) => k.replace(/'/g, '')), ...EXTRA_KEYS])]
        return `for (const k of [${want.map((k) => `'${k}'`).join(', ')}])\n    c[k] = vi.fn((): unknown => __chain)`
      },
    )
    if (newBody === body) return match // pattern not recognised; leave alone
    changed = true
    return `function ${name}() {${newBody}\n${THENABLE}}`
  })

  if (!changed) return false
  writeFileSync(file, s)
  return true
}

let n = 0
for (const f of process.argv.slice(2)) {
  if (convert(f)) {
    n++
    console.log(f)
  }
}
console.log(`\n${n} chain factories upgraded`)
