/**
 * Shared mock adapter that makes legacy synchronous query mocks awaitable.
 *
 * The PostgreSQL migration made every production query `await`ed, which broke
 * the ~340 existing mock sites that returned bare `{ get }` / `{ all }` /
 * `{ run }` terminators. Rather than rewriting each one, this wraps a legacy
 * terminator into a value that is simultaneously a thenable (resolving to the
 * row list drizzle would return) and a chainable builder.
 *
 * It lives here rather than being copy-pasted into each `__tests__` file
 * because it encodes several non-obvious invariants — `get` precedence, lazy
 * settling, `{ changes: n }` -> n placeholder rows — that must stay identical
 * everywhere.
 */
// biome-ignore lint/suspicious/noExplicitAny: stands in for drizzle's builder across ~340 mock sites with differing terminator shapes.
export function asyncQuery(term: Record<string, unknown>): any {
  const rows = (): unknown[] => {
    // `get` is consulted BEFORE `all`. Many mocks define both — a configured
    // `get` alongside a placeholder `all: () => []` — and preferring `all` made
    // every single-row lookup resolve empty, so callers saw `undefined`.
    const get = term.get as (() => unknown) | undefined
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = term.all as (() => unknown[]) | undefined
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = term.run as (() => unknown) | undefined
    if (run) {
      // A write mock returns better-sqlite3's `{ changes: n }`. Production now
      // counts `.returning()` rows instead, so surface n placeholder rows —
      // otherwise a successful claim looks like "0 rows affected" and every
      // compare-and-set guard reports that it lost the race.
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const make = (): any => {
    // Compose rather than choose: the test's own chain methods run first (so a
    // nested `where`/`orderBy` it defined still drives the data), and whatever
    // they return is itself wrapped — so `.limit(1)` and `await` work at every
    // depth. Picking one side or the other broke the opposite set of files.
    const wrap = (v: unknown): unknown =>
      v && typeof v === 'object' && !(v as { then?: unknown }).then
        ? asyncQuery(v as Record<string, unknown>)
        : v
    const chained: Record<string, unknown> = {}
    for (const key of [
      'limit',
      'orderBy',
      'offset',
      'groupBy',
      'having',
      'where',
      'returning',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'for',
    ]) {
      const own = term[key] as ((...a: unknown[]) => unknown) | undefined
      chained[key] = own ? (...a: unknown[]) => wrap(own(...a)) : () => make()
    }
    // Lazy: the row-resolving function must run only when the node is actually
    // awaited. `Promise.resolve().then(rows)` fires eagerly at construction, so
    // building a chain consumed a queued `get` per intermediate node and every
    // sequence-driven mock desynchronised.
    let settled: Promise<unknown[]> | undefined
    const node = Object.assign(
      {
        // biome-ignore lint/suspicious/noThenProperty: this IS the drizzle-builder stand-in — being awaitable is the whole point.
        then: (
          onFulfilled?: (v: unknown[]) => unknown,
          onRejected?: (e: unknown) => unknown,
        ): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.then(onFulfilled, onRejected)
        },
        catch: (onRejected?: (e: unknown) => unknown): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.catch(onRejected)
        },
        finally: (onFinally?: () => void): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.finally(onFinally)
        },
      },
      term,
      chained,
    )
    return node
  }
  return make()
}
