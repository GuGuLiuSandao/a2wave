import { createHash } from 'node:crypto'
import { SETTINGS_DEFAULTS } from '@a2wave/shared'
import type { SettingsMap } from '@a2wave/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { settings } from '../db/schema.js'
import {
  type SettingRow,
  getCachedSettingRows,
  isSettingsCachePrimed,
  primeSettingsCache,
} from './settings-cache.js'

/** 解析后的附件设置。上传端点与 TTL sweeper 从此读取上限/TTL/白名单，不硬编码。 */
export interface AttachmentSettings {
  stagingPath: string
  stagingTtlHours: number
  maxFileSizeBytes: number
  maxFilesPerRequest: number
  /** 允许扩展名集合（无点、小写）。 */
  allowedExtensions: Set<string>
}

/**
 * The settings rows backing every read below.
 *
 * Served from the in-memory cache so these reads stay **synchronous** on both
 * backends — see settings-cache.ts for why that matters. On SQLite the DB is
 * queried directly when the cache has not been primed yet, which keeps existing
 * tests (and any boot-order edge) working exactly as before; PostgreSQL cannot
 * do that (its reads are async) and falls back to defaults instead.
 */
function readSettingRows(): SettingRow[] {
  // Cache only — no DB fallback. Every DB read is async on PostgreSQL, and these
  // readers are called from ~22 synchronous modules (URL builders, auth policy,
  // retention windows); reaching for the database here is what would force them
  // all to become async. An unprimed cache returns empty so callers fall back to
  // SETTINGS_DEFAULTS; refreshSettingsCache() runs before `listen`, so no request
  // can observe that state.
  return isSettingsCachePrimed() ? getCachedSettingRows() : []
}

/**
 * Load the settings table into the cache. Called at boot, and again after every
 * write, so a change takes effect without a restart.
 */
export async function refreshSettingsCache(): Promise<void> {
  const rows = (await db.select().from(settings)) as SettingRow[]
  primeSettingsCache(rows)
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * 非管理员可读的设置键**白名单**（按 `category.key` 标识）。settings 读端点（GET / 与
 * GET /:category）对非 admin 调用者**只**返回这里列出的键，其余一律剔除（fail-closed）——
 * 采用 allowlist 而非 denylist，避免新增敏感字段（如 webhook.url 本身即 bearer secret、
 * sso.oidcClientSecretEnc、各类内部存储路径）默认对任意登录用户可见（review [P1]）。
 *
 * 只放**前端非管理员页面确实需要**的键：
 *   - branding.*        品牌名/图标（所有页面顶栏渲染）
 *   - attachments 上限/白名单（测试抽屉 useAttachmentConfig，不含 stagingPath）
 * 需要新增前端可见设置时，显式往这里加键。
 */
const NON_ADMIN_READABLE_KEYS = new Set<string>([
  'branding.subtitle',
  'branding.faviconUrl',
  'attachments.maxFileSizeBytes',
  'attachments.maxFilesPerRequest',
  'attachments.allowedExtensions',
  // Agent 创建模板的 Provider 预填（AgentsPage 对所有登录用户可见）
  'templates.providerBaseUrl',
  'templates.providerModel',
])

/** 对非管理员只保留白名单键；就地不改，返回过滤后的浅拷贝。admin 传 true 时原样返回。 */
export function redactSettingsForViewer(map: SettingsMap, isAdminViewer: boolean): SettingsMap {
  if (isAdminViewer) return map
  const out: SettingsMap = {}
  for (const [cat, entries] of Object.entries(map)) {
    const kept: Record<string, string> = {}
    for (const [key, value] of Object.entries(entries)) {
      if (NON_ADMIN_READABLE_KEYS.has(`${cat}.${key}`)) kept[key] = value
    }
    // 只在有可见键时保留该分类，避免返回一堆空对象。
    if (Object.keys(kept).length > 0) out[cat] = kept
  }
  return out
}

/** 单分类版本：对非管理员只保留该分类下的白名单键。 */
export function redactCategoryForViewer(
  category: string,
  entries: Record<string, string>,
  isAdminViewer: boolean,
): Record<string, string> {
  if (isAdminViewer) return entries
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (NON_ADMIN_READABLE_KEYS.has(`${category}.${key}`)) out[key] = value
  }
  return out
}

/**
 * Read all settings from DB, merge with SETTINGS_DEFAULTS.
 * Returns a SettingsMap grouped by category.
 */
export function getAllSettings(): SettingsMap {
  const rows = readSettingRows()

  // Start with deep-cloned defaults
  const result: SettingsMap = {}
  for (const [cat, entries] of Object.entries(SETTINGS_DEFAULTS)) {
    result[cat] = { ...entries }
  }

  // Override with DB values
  for (const row of rows) {
    if (!result[row.category]) {
      result[row.category] = {}
    }
    result[row.category][row.key] = row.value
  }

  return result
}

/**
 * Per-key write versions, as `{ "<category>.<key>": "<token>" }`.
 *
 * The settings PATCH is a key-level upsert with no precondition, so a client
 * holding a stale snapshot silently overwrites a concurrent change. Clients echo
 * these tokens back on write; the route rejects with 409 when a key moved.
 *
 * Derived from the stored **value**, not `updated_at`: that column is declared
 * `mode: 'timestamp'`, which drizzle floors to whole seconds, so two writes to one
 * key inside the same second would be indistinguishable — exactly the
 * double-click / retry case this exists to catch.
 */
export async function getSettingsVersions(
  executor: Pick<typeof db, 'select'> = db,
): Promise<Record<string, string>> {
  // Reads the DATABASE, not the settings cache — and takes an executor so the
  // PATCH conflict check can read through its own `tx`.
  //
  // This is deliberately NOT one of the ~22 synchronous readers the cache exists
  // to serve (those go through getSetting / getCategorySettings). Serving this
  // one from the cache re-opened the race it exists to close: the cache is only
  // refreshed AFTER the transaction commits, so two concurrent PATCHes holding
  // the same stale `expectedVersions` both passed the check and the second
  // silently clobbered the first — no 409. On multi-replica PostgreSQL it was
  // worse: a replica that never handles a write never refreshes, so its
  // comparison snapshot is permanently stale.
  //
  // Reading inside the transaction restores the guarantee the pre-migration
  // synchronous `.all()` had for free. (`.all()` itself was the bug — it does
  // not exist on the node-postgres builder.)
  const rows = (await executor.select().from(settings)) as SettingRow[]
  const versions: Record<string, string> = {}
  for (const row of rows) {
    versions[`${row.category}.${row.key}`] = settingsVersionToken(row.value)
  }
  return versions
}

/** Short content hash identifying one stored value; see getSettingsVersions. */
export function settingsVersionToken(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * Whether a `"<category>.<key>"` path is readable by a non-admin. Shared by the
 * value redaction and the version map so the two cannot drift apart.
 */
export function isNonAdminReadableSetting(path: string): boolean {
  return NON_ADMIN_READABLE_KEYS.has(path)
}

/**
 * Read settings for a specific category, merged with defaults.
 */
export function getCategorySettings(category: string): Record<string, string> {
  const rows = readSettingRows().filter((r) => r.category === category)

  const defaults = SETTINGS_DEFAULTS[category] || {}
  const result: Record<string, string> = { ...defaults }

  for (const row of rows) {
    result[row.key] = row.value
  }

  return result
}

/**
 * Read a single setting value.
 * Falls back to SETTINGS_DEFAULTS if not found in DB.
 */
export function getSetting(category: string, key: string): string | undefined {
  const row = readSettingRows().find((r) => r.category === category && r.key === key)

  if (row) return row.value
  return SETTINGS_DEFAULTS[category]?.[key]
}

/**
 * 读取并解析附件设置（合并默认值 + 数值/CSV 解析，坏值回退默认）。
 * 上传端点、materializer、sweeper 统一走此函数，避免各处硬编码上限。
 */
export function getAttachmentSettings(): AttachmentSettings {
  const s = getCategorySettings('attachments')
  const defaults = SETTINGS_DEFAULTS.attachments
  const parseExts = (raw: string): string[] =>
    raw
      .split(',')
      .map((e) => e.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
  // 坏值回退默认：管理员误存 ' ' / ',,' 等非空但解析后为空的值时，`??` 不触发（非 null），
  // 若直接用会得到空白名单 → fail-closed 拒绝一切上传/materialize，全平台附件静默瘫痪
  // （review [P1]）。所以解析后为空时回退到默认扩展名集合。
  let allowed = parseExts(s.allowedExtensions ?? defaults.allowedExtensions)
  if (allowed.length === 0) allowed = parseExts(defaults.allowedExtensions)
  return {
    stagingPath: s.stagingPath || defaults.stagingPath,
    stagingTtlHours: parsePositiveInt(s.stagingTtlHours, Number(defaults.stagingTtlHours)),
    maxFileSizeBytes: parsePositiveInt(s.maxFileSizeBytes, Number(defaults.maxFileSizeBytes)),
    maxFilesPerRequest: parsePositiveInt(s.maxFilesPerRequest, Number(defaults.maxFilesPerRequest)),
    allowedExtensions: new Set(allowed),
  }
}
