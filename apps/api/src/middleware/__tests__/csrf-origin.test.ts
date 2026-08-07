import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: {
    CORS_ORIGIN: 'https://a2wave.example.com',
    PUBLIC_URL: '',
  },
}))

const { env } = await import('../../env.js')
const { csrfOriginMiddleware } = await import('../csrf-origin.js')

const mutableEnv = env as unknown as { CORS_ORIGIN: string; PUBLIC_URL: string }

function createApp() {
  const app = new Hono()
  app.use('*', csrfOriginMiddleware)
  app.post('/api/users/usr_admin/reset-password', (c) => c.json({ ok: true }))
  app.get('/api/users', (c) => c.json({ ok: true }))
  app.post('/api/auth/oidc/callback', (c) => c.json({ ok: true }))
  app.post('/api/gateway/agt_1/invoke', (c) => c.json({ ok: true }))
  return app
}

const SESSION_COOKIE = '__Host-a2wave_session=jwt-value'

beforeEach(() => {
  mutableEnv.CORS_ORIGIN = 'https://a2wave.example.com'
  mutableEnv.PUBLIC_URL = ''
})

describe('csrfOriginMiddleware', () => {
  it('rejects a cookie-authenticated POST from a sibling subdomain', async () => {
    // The reported attack: evil.example.com is same-*site* under SameSite=Lax,
    // so the browser attaches the session cookie to this cross-origin request.
    const res = await createApp().request('/api/users/usr_admin/reset-password', {
      method: 'POST',
      headers: {
        Cookie: SESSION_COOKIE,
        Origin: 'https://evil.example.com',
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ newPassword: 'Attacker123!' }),
    })

    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('CSRF_ORIGIN_REJECTED')
  })

  it('allows a cookie-authenticated POST from the configured origin', async () => {
    const res = await createApp().request('/api/users/usr_admin/reset-password', {
      method: 'POST',
      headers: {
        Cookie: SESSION_COOKIE,
        Origin: 'https://a2wave.example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'Legit123!' }),
    })

    expect(res.status).toBe(200)
  })

  it('allows an origin matching PUBLIC_URL when it differs from CORS_ORIGIN', async () => {
    mutableEnv.PUBLIC_URL = 'https://public.example.com'
    const res = await createApp().request('/api/users/usr_admin/reset-password', {
      method: 'POST',
      headers: {
        Cookie: SESSION_COOKIE,
        Origin: 'https://public.example.com',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    expect(res.status).toBe(200)
  })

  it('allows a Bearer-authenticated request from any origin (CLI / programmatic)', async () => {
    // A cross-origin attacker cannot set Authorization, so Bearer callers need no
    // CSRF gate — and gating them would break every CLI client.
    const res = await createApp().request('/api/users/usr_admin/reset-password', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer some-jwt',
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    expect(res.status).toBe(200)
  })

  it('allows a request carrying no session cookie (public gateway channel)', async () => {
    const res = await createApp().request('/api/gateway/agt_1/invoke', {
      method: 'POST',
      headers: { Origin: 'https://somewhere.example.com', 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(200)
  })

  it('allows safe methods regardless of origin', async () => {
    const res = await createApp().request('/api/users', {
      method: 'GET',
      headers: { Cookie: SESSION_COOKIE, Origin: 'https://evil.example.com' },
    })

    expect(res.status).toBe(200)
  })

  it('exempts the SSO callback paths, which are legitimately cross-origin', async () => {
    const res = await createApp().request('/api/auth/oidc/callback', {
      method: 'POST',
      headers: { Cookie: SESSION_COOKIE, Origin: 'https://idp.example.com' },
      body: '',
    })

    expect(res.status).toBe(200)
  })

  it('rejects a cookie-authenticated unsafe request with no Origin header', async () => {
    // A browser always sends Origin on cross-origin unsafe requests; its absence
    // on a cookie-bearing POST is not a shape any supported browser client produces.
    const res = await createApp().request('/api/users/usr_admin/reset-password', {
      method: 'POST',
      headers: { Cookie: SESSION_COOKIE, 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(403)
  })

  it('allows a same-origin write when the API hosts the frontend itself', async () => {
    // The single-container Docker deployment: the API serves apps/web/dist, so the
    // browser's Origin is the API's own host — which CORS_ORIGIN
    // (http://localhost:3501, the dev two-port topology) never matches. Without this
    // every post-login write in the README's quickstart 403s.
    mutableEnv.CORS_ORIGIN = 'http://localhost:3501'
    const res = await createApp().request(
      'http://localhost:3502/api/users/usr_admin/reset-password',
      {
        method: 'POST',
        headers: {
          Cookie: SESSION_COOKIE,
          Origin: 'http://localhost:3502',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    )

    expect(res.status).toBe(200)
  })

  it('allows a same-host write when TLS is terminated at a reverse proxy', async () => {
    // The proxy forwards over plain HTTP, so the request URL is http:// while the
    // browser sends an https:// Origin. Comparing whole strings would reject the
    // most common production topology.
    mutableEnv.CORS_ORIGIN = 'http://localhost:3501'
    const res = await createApp().request(
      'http://a2wave.corp.example/api/users/usr_admin/reset-password',
      {
        method: 'POST',
        headers: {
          Cookie: SESSION_COOKIE,
          Origin: 'https://a2wave.corp.example',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    )

    expect(res.status).toBe(200)
  })

  it('still rejects a foreign origin whose host merely suffixes the request host', async () => {
    // Guards the same-origin escape hatch against substring matching:
    // `evil-localhost:3502` must not pass as `localhost:3502`.
    mutableEnv.CORS_ORIGIN = 'http://localhost:3501'
    const res = await createApp().request(
      'http://localhost:3502/api/users/usr_admin/reset-password',
      {
        method: 'POST',
        headers: {
          Cookie: SESSION_COOKIE,
          Origin: 'http://evil-localhost:3502',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    )

    expect(res.status).toBe(403)
  })

  it('rejects a malformed Origin header', async () => {
    const res = await createApp().request('/api/users/usr_admin/reset-password', {
      method: 'POST',
      headers: { Cookie: SESSION_COOKIE, Origin: 'not-a-url', 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(403)
  })

  it('rejects the legacy session cookie name from a foreign origin', async () => {
    // Non-secure deployments fall back to the unprefixed cookie name; the CSRF
    // gate must recognise it too, or HTTP installs stay exploitable.
    const res = await createApp().request('/api/users/usr_admin/reset-password', {
      method: 'POST',
      headers: {
        Cookie: 'a2wave_session=jwt-value',
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    expect(res.status).toBe(403)
  })

  it('ignores an unrelated cookie (no session ⇒ no ambient authority)', async () => {
    const res = await createApp().request('/api/users/usr_admin/reset-password', {
      method: 'POST',
      headers: {
        Cookie: 'theme=dark',
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    expect(res.status).toBe(200)
  })
})
