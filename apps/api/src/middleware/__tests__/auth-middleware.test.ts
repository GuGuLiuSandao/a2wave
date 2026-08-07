import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

const mockVerifyToken = vi.fn()
const mockDbUser = vi.fn()

vi.mock('../../env.js', () => ({
  env: {
    NODE_ENV: 'production',
    E2E_STRICT_AUTH: true,
    AUTH_SECRET: 'test-secret-that-is-long-enough-for-prod',
  },
}))

vi.mock('../../lib/auth.js', () => ({
  AUTH_COOKIE_NAME: '__Host-a2wave_session',
  LEGACY_AUTH_COOKIE_NAME: 'a2wave_session',
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'id',
    role: 'role',
    tokenVersion: 'token_version',
    isActive: 'is_active',
  },
}))

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          asyncQuery({
            get: () => mockDbUser(),
          }),
      }),
    }),
  },
}))

const mockValidateAgentToken = vi.fn()

vi.mock('../../lib/agent-memory-token.js', () => ({
  validateAgentToken: (...args: unknown[]) => mockValidateAgentToken(...args),
}))

vi.mock('../../lib/auth-cookie.js', () => ({
  isCookieSecure: () => true,
}))

const { authMiddleware, memoryAuthMiddleware } = await import('../auth-middleware.js')

describe('memoryAuthMiddleware', () => {
  function makeLocalhostEnv(remoteAddress: string) {
    return { incoming: { socket: { remoteAddress } } }
  }

  function createMemoryApp(nodeEnv?: unknown) {
    const app = new Hono()
    app.use('*', async (c, next) => {
      if (nodeEnv !== undefined) {
        ;(c as unknown as { env: unknown }).env = nodeEnv
      }
      await next()
    })
    app.use('*', memoryAuthMiddleware)
    app.get('/test', (c) =>
      c.json({
        agentTokenId: c.get('agentTokenId' as never) ?? null,
        userId: c.get('userId' as never) ?? null,
      }),
    )
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyToken.mockResolvedValue({ sub: 'usr_1', tv: 0 })
    mockDbUser.mockReturnValue({ id: 'usr_1', role: 'user', tokenVersion: 0, isActive: true })
  })

  it('localhost + valid Bearer token → sets agentTokenId, skips cookie auth', async () => {
    mockValidateAgentToken.mockReturnValue('agt_test')
    const app = createMemoryApp(makeLocalhostEnv('127.0.0.1'))
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agentTokenId: string | null }
    expect(body.agentTokenId).toBe('agt_test')
    expect(mockVerifyToken).not.toHaveBeenCalled()
  })

  it('localhost + Bearer that is not an agent token → falls back to JWT auth (CLI session token)', async () => {
    // The CLI always forwards the user's session JWT as a Bearer, even against a
    // localhost / same-host API. That is not an agent token, so it must fall through
    // to JWT verification instead of hard-401'ing.
    mockValidateAgentToken.mockReturnValue(null)
    const app = createMemoryApp(makeLocalhostEnv('127.0.0.1'))
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer user-session-jwt' },
    })
    expect(res.status).toBe(200)
    expect(mockVerifyToken).toHaveBeenCalledWith('user-session-jwt')
    const body = (await res.json()) as { userId: string | null; agentTokenId: string | null }
    expect(body.userId).toBe('usr_1')
    expect(body.agentTokenId).toBeNull()
  })

  it('localhost + Bearer that fails both agent-token and JWT checks → 401', async () => {
    mockValidateAgentToken.mockReturnValue(null)
    mockVerifyToken.mockRejectedValue(new Error('bad jwt'))
    const app = createMemoryApp(makeLocalhostEnv('127.0.0.1'))
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer garbage' },
    })
    expect(res.status).toBe(401)
  })

  it('localhost + no Bearer token → falls through to cookie auth', async () => {
    const app = createMemoryApp(makeLocalhostEnv('127.0.0.1'))
    const res = await app.request('/test', {
      headers: { Cookie: '__Host-a2wave_session=browser-token' },
    })
    expect(res.status).toBe(200)
    expect(mockVerifyToken).toHaveBeenCalledWith('browser-token')
    expect(mockValidateAgentToken).not.toHaveBeenCalled()
  })

  it('non-localhost + valid JWT cookie → falls through to cookie auth', async () => {
    const app = createMemoryApp(makeLocalhostEnv('203.0.113.5'))
    const res = await app.request('/test', {
      headers: { Cookie: '__Host-a2wave_session=browser-token' },
    })
    expect(res.status).toBe(200)
    expect(mockVerifyToken).toHaveBeenCalledWith('browser-token')
    expect(mockValidateAgentToken).not.toHaveBeenCalled()
  })

  it('non-localhost + no token → 401', async () => {
    const app = createMemoryApp(makeLocalhostEnv('203.0.113.5'))
    const res = await app.request('/test')
    expect(res.status).toBe(401)
  })
})

describe('authMiddleware cookie selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyToken.mockResolvedValue({ sub: 'usr_1', tv: 0 })
    mockDbUser.mockReturnValue({ id: 'usr_1', role: 'user', tokenVersion: 0, isActive: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function createApp() {
    const app = new Hono()
    app.use('*', authMiddleware)
    app.get('/protected', (c) => c.json({ userId: c.get('userId' as never) }))
    return app
  }

  it('does not accept the legacy cookie name in production', async () => {
    const res = await createApp().request('/protected', {
      headers: { Cookie: 'a2wave_session=legacy-token' },
    })

    expect(res.status).toBe(401)
    expect(mockVerifyToken).not.toHaveBeenCalled()
  })

  it('accepts the __Host cookie name in production', async () => {
    const res = await createApp().request('/protected', {
      headers: { Cookie: '__Host-a2wave_session=host-token' },
    })

    expect(res.status).toBe(200)
    expect(mockVerifyToken).toHaveBeenCalledWith('host-token')
  })
})
