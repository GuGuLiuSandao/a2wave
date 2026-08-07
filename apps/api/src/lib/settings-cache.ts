/**
 * In-memory mirror of the `settings` table.
 *
 * Exists to keep settings reads **synchronous** across both backends. Around 22
 * modules read settings — URL builders, auth policy, retention windows,
 * attachment limits — and almost all of them are otherwise pure functions. On
 * PostgreSQL a direct read returns a Promise, so without this every one of them,
 * and transitively every one of *their* callers, would have to become async.
 *
 * The trade is cheap: the table holds a few dozen short rows, is written through
 * exactly two paths (bootstrap seeding and PATCH /settings), and was already
 * being read on essentially every request. Correctness reduces to one rule —
 * **every write must invalidate** — which is why the write paths call
 * `invalidateSettingsCache()` rather than trying to patch individual entries.
 */

export interface SettingRow {
  category: string
  key: string
  value: string
}

/** null = not yet loaded (distinct from "loaded and empty"). */
let cache: SettingRow[] | null = null

/**
 * Replace the cache wholesale.
 *
 * Replacement, never merge: a merge would make settings effectively append-only,
 * so a key removed from the table would keep being served from memory forever.
 */
export function primeSettingsCache(rows: SettingRow[]): void {
  cache = rows.map((r) => ({ category: r.category, key: r.key, value: r.value }))
}

/**
 * The cached rows, or an empty list when the cache has not been primed.
 *
 * Empty rather than throwing: module-graph import order is not fully
 * controllable, and a read that happens to land before priming should fall back
 * to the built-in defaults instead of taking down the process.
 *
 * Returns a copy so a caller mutating the result cannot corrupt the cache.
 */
export function getCachedSettingRows(): SettingRow[] {
  return cache ? cache.map((r) => ({ ...r })) : []
}

/** True once the cache holds a loaded snapshot. */
export function isSettingsCachePrimed(): boolean {
  return cache !== null
}

/** Drop the snapshot; the next prime becomes authoritative. */
export function invalidateSettingsCache(): void {
  cache = null
}
