/**
 * Smoke: 可观测/运维接口
 *
 * 覆盖 dashboard 与运维场景常用的只读接口（runs/stats、changelog、OpenAPI、
 * feishu-connections），保证它们的响应 shape 不被无意中改坏。
 */
import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { API_BASE } from '../../utils/test-constants'

test.describe('Smoke: runs stats', () => {
  test('GET /api/runs/stats returns aggregated counts', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.get(`${API_BASE}/api/runs/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(typeof body.total).toBe('number')
    expect(typeof body.todayRuns).toBe('number')
    expect(typeof body.successRate).toBe('number')
    expect(typeof body.avgDuration).toBe('number')
    expect(body.byStatus && typeof body.byStatus === 'object').toBe(true)
    expect(body.todayByStatus && typeof body.todayByStatus === 'object').toBe(true)
    // byStatus 的 key 集合可能随状态机演进；只断言「存在的值都是数字」，
    // 而不是固定枚举键，避免新增状态时 e2e 假阳性。
    for (const value of Object.values(body.byStatus as Record<string, unknown>)) {
      expect(typeof value).toBe('number')
    }
    for (const value of Object.values(body.todayByStatus as Record<string, unknown>)) {
      expect(typeof value).toBe('number')
    }
  })

  test('GET /api/runs/stats without auth returns 401', async ({ request }) => {
    if (process.env.E2E_STRICT_AUTH !== '1') {
      test.skip(true, 'dev-bypass 模式自动认证为 admin；isolated 模式才会强制 401')
      return
    }
    const res = await request.get(`${API_BASE}/api/runs/stats`)
    expect(res.status()).toBe(401)
  })
})

test.describe('Smoke: changelog endpoint', () => {
  test('GET /api/changelog returns content from CHANGELOG.md', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/changelog`)
    expect(res.status()).toBe(200)
    expect(res.headers()['cache-control']).toBe('no-store')
    const body = await res.json()
    expect(typeof body.content).toBe('string')
  })
})

test.describe('Smoke: OpenAPI spec', () => {
  test('GET /api/docs/spec returns OpenAPI 3.x document', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/docs/spec`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(typeof body.openapi).toBe('string')
    expect(body.openapi.startsWith('3.')).toBe(true)
    expect(body.info).toBeDefined()
    expect(body.paths).toBeDefined()
    // 当前 spec 仅覆盖 Gateway API；至少 invoke 路径必须存在
    expect(Object.keys(body.paths).some((p) => p.includes('invoke'))).toBe(true)
  })

  test('GET /api/docs serves Swagger UI HTML', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/docs`)
    expect(res.status()).toBe(200)
    const text = await res.text()
    expect(text).toContain('swagger')
  })
})

test.describe('Smoke: feishu connections status', () => {
  test('GET /api/agents/feishu-connections returns shape with meta', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.get(`${API_BASE}/api/agents/feishu-connections`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data)).toBe(true)
    // meta.scope 标明多实例语义；endpoint 应稳定输出
    expect(body.meta).toBeDefined()
    expect(typeof body.meta.scope).toBe('string')
  })
})
