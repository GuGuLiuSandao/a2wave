/**
 * Smoke: API 健康检查 & 核心 CRUD 通路
 *
 * 验证后端服务可达、认证正常、核心 CRUD 接口可用。
 * 不依赖特定数据状态，每个测试自行创建和清理数据。
 */
import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { API_BASE, getE2ePassword } from '../../utils/test-constants'

test.describe('Smoke: API health', () => {
  test('GET /api/health returns ok', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/health`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.version).toBeDefined()
    expect(body.checks.database.ok).toBe(true)
  })

  test('GET /api/auth/status returns needSetup boolean', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/auth/status`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toBeDefined()
    expect(typeof body.data.needSetup).toBe('boolean')
  })
})

test.describe('Smoke: auth flow', () => {
  test('POST /api/auth/login with valid credentials returns token', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
      data: { username: 'admin', password: getE2ePassword() },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data.token).toBeTruthy()
    expect(body.data.user.role).toBe('admin')
  })

  test('POST /api/auth/login with wrong password returns 401', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
      data: { username: 'admin', password: 'wrong-password' },
    })
    expect(res.status()).toBe(401)
  })

  test('GET /api/auth/me without token returns 401', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/auth/me`)
    // Isolated 模式会置 E2E_STRICT_AUTH=1，此时必须严格 401；
    // In-place 模式跑在未启严格 auth 的 dev server 上，dev-bypass 会返回 200 → skip。
    if (process.env.E2E_STRICT_AUTH === '1') {
      expect(res.status()).toBe(401)
      return
    }
    if (res.status() === 200) {
      test.skip(true, 'dev-bypass 模式下自动认证为 admin；isolated 模式才会强制 401')
      return
    }
    expect(res.status()).toBe(401)
  })

  test('GET /api/auth/me with valid token returns user info', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.get(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data.username).toBe('admin')
  })
})

test.describe('Smoke: agent CRUD', () => {
  test('create → list → get → delete agent', async ({ request }) => {
    const token = await getAdminToken()
    const name = `e2e-smoke-agent-${Date.now()}`
    let agentId = ''

    try {
      // Create
      const createRes = await request.post(`${API_BASE}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name },
      })
      expect(createRes.status()).toBe(201)
      const createBody = await createRes.json()
      agentId = createBody.data.id
      expect(agentId).toMatch(/^agt_/)
      expect(createBody.data.name).toBe(name)

      // List
      const listRes = await request.get(`${API_BASE}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(listRes.status()).toBe(200)
      const listBody = await listRes.json()
      const found = listBody.data.find((a: { id: string }) => a.id === agentId)
      expect(found).toBeDefined()

      // Get
      const getRes = await request.get(`${API_BASE}/api/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(getRes.status()).toBe(200)
      const getBody = await getRes.json()
      expect(getBody.data.name).toBe(name)

      // Delete
      const delRes = await request.delete(`${API_BASE}/api/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(delRes.status()).toBe(200)
      agentId = ''

      // Verify deleted
      const verifyRes = await request.get(`${API_BASE}/api/agents/${createBody.data.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(verifyRes.status()).toBe(404)
    } finally {
      // Cleanup on failure
      if (agentId) {
        await request
          .delete(`${API_BASE}/api/agents/${agentId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          .catch(() => {})
      }
    }
  })
})

test.describe('Smoke: provider list', () => {
  test('GET /api/providers returns list', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.get(`${API_BASE}/api/providers`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data)).toBe(true)
  })
})

test.describe('Smoke: settings', () => {
  test('GET /api/settings returns settings object', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.get(`${API_BASE}/api/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toBeDefined()
  })
})
