import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

vi.mock('../../db/client.js', () => {
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    // Hands the callback a transaction handle, as the real driver does — the
    // route issues its statements on `tx`, not on the outer `db`.
    transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(db)),
  }
  return { db }
})

vi.mock('../../db/schema.js', () => ({
  settings: { category: 'category', key: 'key' },
}))

vi.mock('../../lib/settings.js', async (importOriginal) => {
  // 用真实的 redact* helper（它们按固定敏感键集过滤，非 admin 剔除 attachments.stagingPath）；
  // 只 mock DB 读取函数。
  const actual = await importOriginal<typeof import('../../lib/settings.js')>()
  return {
    ...actual,
    getAllSettings: vi.fn().mockReturnValue({
      general: { workspacePath: '/workspace', theme: 'dark' },
    }),
    getCategorySettings: vi.fn().mockReturnValue({ workspacePath: '/workspace' }),
    getSettingsVersions: vi.fn().mockReturnValue({}),
    isNonAdminReadableSetting: vi.fn().mockReturnValue(true),
  }
})

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return { ...actual }
})

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

const mockClearDetectedServerUrl = vi.fn()
vi.mock('../../lib/server-url.js', () => ({
  isLocalhostOrLoopback: (url: string) => {
    try {
      const u = new URL(url)
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    } catch {
      return false
    }
  },
  getServerUrl: () => 'https://a2wave.test',
  getSsoCallbackOrigin: () => 'https://a2wave.test',
  // 合并后的 publicBaseUrl 是否可用：非空 http(s) 视为可用（这些用例不测防锁死）。
  isSsoCallbackOriginUsable: (u: string | null | undefined) => !!u?.trim(),
  clearDetectedServerUrl: mockClearDetectedServerUrl,
  // 这些用例不测按方式覆盖回调 origin：一律视作未填，走 publicBaseUrl 回落。
  normalizeCallbackOriginOverride: () => null,
}))

vi.mock('../../middleware/auth-middleware.js', () => ({
  requireAdmin: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  // 默认按 admin 处理，让既有断言（返回全部键）不变；专门的泄漏用例会覆写为 false。
  isAdmin: vi.fn(() => true),
}))

import { db } from '../../db/client.js'
import { getAllSettings, getCategorySettings, getSettingsVersions } from '../../lib/settings.js'
import { isAdmin } from '../../middleware/auth-middleware.js'

/**
 * Select chain for a PATCH that writes a brand-new key.
 *
 * Two different reads run it. The route's per-key lookup goes
 * `.from().where().limit(1)` and must resolve empty so the write takes the
 * insert branch. The post-write `refreshSettingsCache()` — real, since the
 * settings mock spreads `...actual` — awaits straight after `.from()` and maps
 * the rows, so that node has to be awaitable and resolve to an array too.
 */
function selectChainWithNoExistingRow() {
  return asyncQuery({
    from: vi.fn(() =>
      asyncQuery({
        all: () => [],
        where: vi.fn(() => asyncQuery({ get: vi.fn().mockReturnValue(null) })),
      }),
    ),
  })
}

describe('Settings routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../settings.js')
    app = new Hono()
    app.route('/api/settings', mod.default)
  })

  describe('GET /', () => {
    it('returns all settings', async () => {
      const res = await app.request('/api/settings')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data).toEqual({ general: { workspacePath: '/workspace', theme: 'dark' } })
      expect(getAllSettings).toHaveBeenCalled()
    })
  })

  describe('GET /:category', () => {
    it('returns settings for a category', async () => {
      const res = await app.request('/api/settings/general')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data).toEqual({ workspacePath: '/workspace' })
      expect(getCategorySettings).toHaveBeenCalledWith('general')
    })

    it('redacts attachments.stagingPath for non-admin (info-disclosure guard)', async () => {
      ;(isAdmin as Mock).mockReturnValue(false)
      ;(getCategorySettings as Mock).mockReturnValue({
        stagingPath: '/srv/data/attachments',
        maxFileSizeBytes: '10485760',
        maxFilesPerRequest: '10',
        allowedExtensions: 'png,pdf',
      })
      const res = await app.request('/api/settings/attachments')
      const body = (await res.json()) as any
      // 非 admin：stagingPath 被剔除，但客户端上传所需的上限/白名单仍可读。
      expect(body.data.stagingPath).toBeUndefined()
      expect(body.data.maxFileSizeBytes).toBe('10485760')
      expect(body.data.allowedExtensions).toBe('png,pdf')
    })

    it('admin still sees attachments.stagingPath', async () => {
      ;(isAdmin as Mock).mockReturnValue(true)
      ;(getCategorySettings as Mock).mockReturnValue({
        stagingPath: '/srv/data/attachments',
        maxFilesPerRequest: '10',
      })
      const res = await app.request('/api/settings/attachments')
      const body = (await res.json()) as any
      expect(body.data.stagingPath).toBe('/srv/data/attachments')
    })

    it('non-admin gets empty object for a fully-sensitive category (webhook.url is a secret)', async () => {
      ;(isAdmin as Mock).mockReturnValue(false)
      ;(getCategorySettings as Mock).mockReturnValue({
        url: 'https://hooks.example/secret-bearer',
        enabled: 'true',
      })
      const res = await app.request('/api/settings/webhook')
      const body = (await res.json()) as any
      // webhook.url 常本身就是 bearer secret；非 admin 一个键都拿不到（allowlist fail-closed）。
      expect(body.data).toEqual({})
    })
  })

  describe('PATCH /', () => {
    it('updates settings with valid input', async () => {
      ;(db.select as Mock).mockImplementation(() => selectChainWithNoExistingRow())
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
      })

      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ general: { workspacePath: '/new/path' } }),
      })

      expect(res.status).toBe(200)
    })

    it('rejects with 409 when a targeted key moved since the caller read it', async () => {
      // Without this precondition the settings PATCH is last-write-wins: a form
      // holding a page-load snapshot silently reverts a concurrent change.
      ;(getSettingsVersions as Mock).mockReturnValue({ 'general.workspacePath': 'tok-current' })
      ;(db.update as Mock).mockClear()
      ;(db.insert as Mock).mockClear()

      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          general: { workspacePath: '/stale' },
          expectedVersions: { 'general.workspacePath': 'tok-old' },
        }),
      })

      expect(res.status).toBe(409)
      expect((await res.json()) as { conflicts: string[] }).toMatchObject({
        error: 'SETTINGS_CONFLICT',
        conflicts: ['general.workspacePath'],
      })
      // Nothing may be written: a partial apply would leave the caller unable to
      // tell which half landed.
      expect(db.update).not.toHaveBeenCalled()
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('allows the write when the versions still match', async () => {
      ;(getSettingsVersions as Mock).mockReturnValue({ 'general.workspacePath': 'tok-current' })
      ;(db.select as Mock).mockImplementation(() => selectChainWithNoExistingRow())
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
      })

      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          general: { workspacePath: '/fresh' },
          expectedVersions: { 'general.workspacePath': 'tok-current' },
        }),
      })

      expect(res.status).toBe(200)
    })

    it('ignores a key the caller is not writing, even if it moved', async () => {
      // Scoped to the keys in this payload: another admin changing an unrelated
      // setting must not block a save that never touches it.
      ;(getSettingsVersions as Mock).mockReturnValue({
        'general.workspacePath': 'tok-current',
        'general.timeoutMinutes': 'tok-moved',
      })
      ;(db.select as Mock).mockImplementation(() => selectChainWithNoExistingRow())
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
      })

      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          general: { workspacePath: '/fresh' },
          expectedVersions: { 'general.workspacePath': 'tok-current' },
        }),
      })

      expect(res.status).toBe(200)
    })

    it('stays last-write-wins for clients that send no versions header', async () => {
      // Opt-in by design: API/CLI integrations that never read versions keep working.
      ;(getSettingsVersions as Mock).mockReturnValue({ 'general.workspacePath': 'tok-current' })
      ;(db.select as Mock).mockImplementation(() => selectChainWithNoExistingRow())
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
      })

      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ general: { workspacePath: '/no-header' } }),
      })

      expect(res.status).toBe(200)
    })

    it('returns 400 for a malformed expectedVersions instead of throwing', async () => {
      // `null` is the value a degraded client most plausibly serialises for a
      // missing map, and `typeof null === 'object'` — indexing it would throw and
      // surface as a 500, indistinguishable from a real server fault.
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ general: { workspacePath: '/x' }, expectedVersions: null }),
      })

      expect(res.status).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'INVALID_SETTINGS_VERSIONS',
      })
    })

    it('treats a key created after the caller read as a conflict', async () => {
      // create-create race: two admins first-write the same key. Most keys have no
      // row until someone saves (SETTINGS_DEFAULTS covers the rest), so this is the
      // common case, not an exotic one. Simplifying the check to
      // `before !== undefined && before !== after` would silently allow it.
      ;(getSettingsVersions as Mock).mockReturnValue({ 'general.workspacePath': 'tok-created' })
      ;(db.update as Mock).mockClear()
      ;(db.insert as Mock).mockClear()

      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // The caller read before the row existed, so its map has no entry for it.
        body: JSON.stringify({
          general: { workspacePath: '/mine' },
          expectedVersions: {},
        }),
      })

      expect(res.status).toBe(409)
      expect((await res.json()) as { conflicts: string[] }).toMatchObject({
        conflicts: ['general.workspacePath'],
      })
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('rejects a category literally named expectedVersions instead of silently no-op', async () => {
      // The handler strips this key before writing, so without the schema
      // reserving it a write to a same-named category would return 200 having
      // stored nothing — the worst failure shape, since no client can detect it.
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersions: { foo: { bar: 'baz' } } }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid input', async () => {
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('invalid'),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 when artifacts.publicBaseUrl is localhost or 127.0.0.1', async () => {
      const resLocalhost = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifacts: { publicBaseUrl: 'http://localhost:3502' } }),
      })
      expect(resLocalhost.status).toBe(400)
      const bodyLocalhost = (await resLocalhost.json()) as any
      expect(bodyLocalhost.error).toContain('localhost')

      const res127 = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifacts: { publicBaseUrl: 'http://127.0.0.1/' } }),
      })
      expect(res127.status).toBe(400)
    })

    it('calls clearDetectedServerUrl when artifacts.publicBaseUrl is updated', async () => {
      mockClearDetectedServerUrl.mockClear()
      ;(db.select as Mock).mockImplementation(() => selectChainWithNoExistingRow())
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
      })

      await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifacts: { publicBaseUrl: 'http://10.3.101.3:3502' } }),
      })

      expect(mockClearDetectedServerUrl).toHaveBeenCalledTimes(1)
    })
  })
})
