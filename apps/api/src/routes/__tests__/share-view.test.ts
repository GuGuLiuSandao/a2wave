/**
 * Unit tests for routes/share-view.ts
 * Uses Hono's test helper — verifies CSP headers, access control, agentId-segment
 * validation, directory trailing-slash redirect, HMAC password cookie, and raw endpoint.
 *
 * URL shape: /s/:agentId/:shareId. Artifacts in these tests have agentId=null, so the
 * agent segment is the placeholder `_`.
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Share service mock ─────────────────────────────────────────────────────

type MockShare = {
  id: string
  artifactId: string
  accessLevel: 'public' | 'password' | 'authenticated'
  passwordHash: string | null
  expiresAt: Date
  revokedAt: Date | null
}

let mockShare: MockShare | null = null
let recordViewCalled = false
let recordViewCount = 0

vi.mock('../../lib/artifact-share.js', () => ({
  getActiveShare: vi.fn(() => mockShare),
  recordShareView: vi.fn(() => {
    recordViewCalled = true
    recordViewCount++
  }),
}))

// ── DB mock ────────────────────────────────────────────────────────────────

type MockArtifact = {
  id: string
  kind: 'file' | 'directory'
  storagePath: string
  mimeType: string | null
  filename: string
  agentId: string | null
}

let mockArtifact: MockArtifact | null = null
let mockSessionUser: {
  id: string
  role: 'admin' | 'user'
  tokenVersion: number
  isActive: boolean
} | null = null

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          asyncQuery({
            // loadShareContext queries artifacts (returns mockArtifact); agents is only
            // queried when artifact.agentId != null, which these tests avoid (agentId=null).
            get: vi.fn(() => (selection?.tokenVersion ? mockSessionUser : mockArtifact)),
          }),
        ),
      })),
    })),
  },
}))

vi.mock('../../db/schema.js', () => ({
  artifacts: { id: 'id' },
  agents: { id: 'id', name: 'name' },
  users: { id: 'id', role: 'role', tokenVersion: 'tokenVersion', isActive: 'isActive' },
}))

// ── server-url mock (SHARE_NO_AGENT_SEGMENT) ────────────────────────────────

vi.mock('../../lib/server-url.js', () => ({
  SHARE_NO_AGENT_SEGMENT: '_',
}))

// ── FS mock ────────────────────────────────────────────────────────────────

let mockFileExists = true
let mockFileContent = '<h1>Hello</h1>'
let mockFileStat = {
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  size: 100,
}
let mockDirEntries: string[] = []

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => mockFileExists),
  readFileSync: vi.fn(() => mockFileContent),
  lstatSync: vi.fn(() => mockFileStat),
  readdirSync: vi.fn(() => mockDirEntries),
}))

// ── Auth mock ──────────────────────────────────────────────────────────────

let mockTokenPayload: { sub: string; tv: number } | null = null

vi.mock('../../lib/auth.js', () => ({
  verifyToken: vi.fn(async () => {
    if (!mockTokenPayload) throw new Error('invalid')
    return mockTokenPayload
  }),
  verifyPassword: vi.fn(async (hash: string, plain: string) => hash === `hashed:${plain}`),
  AUTH_COOKIE_NAME: '__Host-a2wave_session',
  LEGACY_AUTH_COOKIE_NAME: 'a2wave_session',
}))

vi.mock('../../lib/auth-cookie.js', () => ({
  isCookieSecure: vi.fn(() => false),
}))

vi.mock('../../lib/artifact-storage.js', () => ({
  guessMimeType: vi.fn((f: string) => {
    if (f.endsWith('.html') || f.endsWith('.htm')) return 'text/html'
    if (f.endsWith('.md')) return 'text/markdown'
    return 'application/octet-stream'
  }),
}))

// env is mutable so individual tests can flip dev-bypass off (E2E_STRICT_AUTH=true)
// to exercise the real authenticated-denial path.
const mockEnv = vi.hoisted(() => ({
  NODE_ENV: 'development',
  E2E_STRICT_AUTH: false,
  AUTH_SECRET: 'dev-secret-change-me',
  TRUSTED_PROXY: false,
  TRUSTED_PROXY_ADDRESSES: '',
}))

vi.mock('../../env.js', () => ({ env: mockEnv }))

// NOTE: rate-limit is intentionally NOT mocked — the real middleware backs the
// password brute-force 429 test below. Its in-memory store persists across requests
// within the module, so the password-auth describe block resets state via fresh shareIds.

// ── Route under test ───────────────────────────────────────────────────────

import { Hono } from 'hono'
import app from '../share-view.js'

import { asyncQuery } from '../../test/async-query.js'

// Wrap in a Hono app with /s prefix so paths match how index.ts mounts it
const root = new Hono()
root.route('/s', app)

function req(path: string, init?: RequestInit) {
  return root.request(path, init)
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockShare = null
  mockArtifact = null
  mockFileExists = true
  mockFileContent = '<h1>Hello</h1>'
  mockFileStat = {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    size: 100,
  }
  mockDirEntries = []
  mockTokenPayload = null
  mockSessionUser = null
  recordViewCalled = false
  recordViewCount = 0
  mockEnv.E2E_STRICT_AUTH = false
})

describe('CSP headers', () => {
  it('all responses include CSP sandbox allow-scripts', async () => {
    const res = await req('/s/_/shr_unknown')
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts')
  })

  it('404 page still has CSP header', async () => {
    const res = await req('/s/_/shr_missing')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts')
  })
})

describe('agentId segment validation', () => {
  beforeEach(() => {
    mockShare = {
      id: 'shr_x',
      artifactId: 'art_real',
      accessLevel: 'public',
      passwordHash: null,
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    }
    mockArtifact = {
      id: 'art_real',
      kind: 'file',
      storagePath: '/data/artifacts/art_real/r.html',
      mimeType: 'text/html',
      filename: 'r.html',
      agentId: 'agt_real',
    }
  })

  it('mismatched agent segment returns 404 (no info leak)', async () => {
    const res = await req('/s/agt_wrong/shr_x')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts')
  })
})

describe('public share — html artifact', () => {
  beforeEach(() => {
    mockShare = {
      id: 'shr_abc',
      artifactId: 'art_1',
      accessLevel: 'public',
      passwordHash: null,
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    }
    mockArtifact = {
      id: 'art_1',
      kind: 'file',
      storagePath: '/data/artifacts/art_1/report.html',
      mimeType: 'text/html',
      filename: 'report.html',
      agentId: null,
    }
  })

  it('renders html inline with CSP allow-scripts', async () => {
    mockFileContent = '<h1>Hello World</h1>'
    const res = await req('/s/_/shr_abc')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Hello World')
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts')
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex')
  })

  it('records share view', async () => {
    await req('/s/_/shr_abc')
    expect(recordViewCalled).toBe(true)
  })
})

describe('public share — markdown artifact', () => {
  beforeEach(() => {
    mockShare = {
      id: 'shr_md',
      artifactId: 'art_md',
      accessLevel: 'public',
      passwordHash: null,
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    }
    mockArtifact = {
      id: 'art_md',
      kind: 'file',
      storagePath: '/data/artifacts/art_md/report.md',
      mimeType: 'text/markdown',
      filename: 'report.md',
      agentId: null,
    }
  })

  it('renders markdown as HTML page with a raw link', async () => {
    mockFileContent = '# My Report\n\nHello **world**'
    const res = await req('/s/_/shr_md')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<h1')
    expect(text).toContain('My Report')
    expect(text).toContain('world')
    // raw link points at the /raw endpoint under the same agent+share prefix
    expect(text).toContain('/s/_/shr_md/raw')
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts')
  })

  it('serves raw markdown as text/plain', async () => {
    mockFileContent = '# Raw Source'
    const res = await req('/s/_/shr_md/raw')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toBe('# Raw Source')
  })
})

describe('password-protected share', () => {
  beforeEach(() => {
    mockShare = {
      id: 'shr_pwd',
      artifactId: 'art_1',
      accessLevel: 'password',
      passwordHash: 'hashed:secret123',
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    }
    mockArtifact = {
      id: 'art_1',
      kind: 'file',
      storagePath: '/data/artifacts/art_1/report.html',
      mimeType: 'text/html',
      filename: 'report.html',
      agentId: null,
    }
  })

  it('shows password form without auth cookie (CSP allow-forms)', async () => {
    const res = await req('/s/_/shr_pwd')
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).toContain('form')
    // form action carries the agent+share prefix
    expect(text).toContain('/s/_/shr_pwd/auth')
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-forms')
  })

  it('POST wrong password returns 401 with error', async () => {
    const body = new URLSearchParams({ password: 'wrongpass' })
    const res = await req('/s/_/shr_pwd/auth', {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-forms')
  })

  it('POST correct password sets HMAC cookie and redirects (cookie is not the hash)', async () => {
    const body = new URLSearchParams({ password: 'secret123' })
    const res = await req('/s/_/shr_pwd/auth', {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/s/_/shr_pwd')
    const setCookieHeader = res.headers.get('Set-Cookie')
    expect(setCookieHeader).toContain('a2w_share_shr_pwd')
    expect(setCookieHeader).toContain('HttpOnly')
    // The argon2 hash must never appear in the cookie value
    expect(setCookieHeader).not.toContain('hashed:secret123')
    // Cookie path is scoped to the agent+share prefix
    expect(setCookieHeader).toContain('Path=/s/_/shr_pwd')
  })

  // NOTE: kept last in this block — the real rate-limit store is shared across the
  // module, and these 15 POSTs exhaust the per-minute window. Running it before the
  // tests above would make their /auth POSTs spuriously 429.
  it('rate-limits password brute-force with 429 after the per-minute cap', async () => {
    // The real rate-limit middleware (10/min/IP) backs /auth. Hammer wrong passwords
    // and assert the limiter kicks in: early attempts fail closed with 401, and once
    // the window cap is exceeded the route returns 429 instead of evaluating the password.
    const statuses: number[] = []
    for (let i = 0; i < 15; i++) {
      const body = new URLSearchParams({ password: 'wrongpass' })
      const res = await req('/s/_/shr_pwd/auth', {
        method: 'POST',
        body: body.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      statuses.push(res.status)
    }
    // …at least one early attempt reached the password check (401, not 429)
    expect(statuses).toContain(401)
    // …brute-force eventually trips the limiter
    expect(statuses).toContain(429)
    // …and the final, over-cap request is rejected by the limiter, not the password check
    expect(statuses[statuses.length - 1]).toBe(429)
  })
})

describe('authenticated share', () => {
  beforeEach(() => {
    mockShare = {
      id: 'shr_auth',
      artifactId: 'art_1',
      accessLevel: 'authenticated',
      passwordHash: null,
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    }
    mockArtifact = {
      id: 'art_1',
      kind: 'file',
      storagePath: '/data/artifacts/art_1/report.html',
      mimeType: 'text/html',
      filename: 'report.html',
      agentId: null,
    }
  })

  it('renders for authenticated users (dev bypass active → usr_admin)', async () => {
    const res = await req('/s/_/shr_auth')
    expect(res.status).toBe(200)
  })

  it('denies anonymous access with 401 + login page when dev-bypass is off', async () => {
    // Disable dev-bypass so tryGetAuthUserId actually evaluates credentials. With no
    // viewer cookie and no valid session token, the authenticated gate must deny.
    mockEnv.E2E_STRICT_AUTH = true
    const res = await req('/s/_/shr_auth')
    expect(res.status).toBe(401)
    const text = await res.text()
    // login-required state page + login entry under /share-login
    expect(text).toContain('Sign-in required')
    expect(text).toContain('/share-login?returnTo=')
    // denial page relaxes CSP to allow-forms (no script execution on state pages)
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-forms')
  })

  it('renders for a valid session token when dev-bypass is off', async () => {
    // Positive counterpart: a verifiable session token passes the authenticated gate.
    mockEnv.E2E_STRICT_AUTH = true
    mockTokenPayload = { sub: 'usr_real', tv: 3 }
    mockSessionUser = { id: 'usr_real', role: 'user', tokenVersion: 3, isActive: true }
    const res = await req('/s/_/shr_auth', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
  })

  it.each([
    {
      name: 'disabled',
      user: { id: 'usr_real', role: 'user' as const, tokenVersion: 3, isActive: false },
    },
    { name: 'deleted', user: null },
    {
      name: 'revoked by tokenVersion',
      user: { id: 'usr_real', role: 'user' as const, tokenVersion: 4, isActive: true },
    },
  ])('denies a session whose user is $name', async ({ user }) => {
    mockEnv.E2E_STRICT_AUTH = true
    mockTokenPayload = { sub: 'usr_real', tv: 3 }
    mockSessionUser = user

    const res = await req('/s/_/shr_auth', {
      headers: { Authorization: 'Bearer stale-token' },
    })

    expect(res.status).toBe(401)
    expect(await res.text()).toContain('Sign-in required')
  })

  it('preserves the independent SSO viewer cookie path without requiring a users row', async () => {
    mockEnv.E2E_STRICT_AUTH = true
    const exp = Math.floor(Date.now() / 1000) + 3600
    const sig = createHmac('sha256', mockEnv.AUTH_SECRET)
      .update(`shareview:${exp}`)
      .digest('base64url')

    const res = await req('/s/_/shr_auth', {
      headers: { Cookie: `a2w_share_viewer=${exp}.${sig}` },
    })

    expect(res.status).toBe(200)
  })
})

describe('directory share', () => {
  beforeEach(async () => {
    mockShare = {
      id: 'shr_dir',
      artifactId: 'art_dir',
      accessLevel: 'public',
      passwordHash: null,
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    }
    mockArtifact = {
      id: 'art_dir',
      kind: 'directory',
      storagePath: '/data/artifacts/site',
      mimeType: null,
      filename: 'site',
      agentId: null,
    }
    // directory target resolves to a directory; index.html (if present) is a plain file
    const { lstatSync } = await import('node:fs')
    vi.mocked(lstatSync).mockReturnValue({
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      size: 100,
    } as ReturnType<typeof import('node:fs').lstatSync>)
  })

  it('GET without trailing slash redirects to trailing slash (F-H1)', async () => {
    const res = await req('/s/_/shr_dir')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/s/_/shr_dir/')
  })

  it('serves index.html at the trailing-slash root', async () => {
    mockFileContent = '<html><body>Site</body></html>'
    const res = await req('/s/_/shr_dir/')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Site')
  })

  it('counts a directory visit exactly once (redirect must not double-count)', async () => {
    // The no-trailing-slash entry 302-redirects and must NOT record a view;
    // only the /* root handler counts. Regression for the double-count bug.
    const redirect = await req('/s/_/shr_dir')
    expect(redirect.status).toBe(302)
    expect(recordViewCount).toBe(0)

    mockFileContent = '<html><body>Site</body></html>'
    await req('/s/_/shr_dir/')
    expect(recordViewCount).toBe(1)
  })

  it('shows file listing when no index.html', async () => {
    let callCount = 0
    const { existsSync } = await import('node:fs')
    vi.mocked(existsSync).mockImplementation(() => {
      callCount++
      // 1st: artifact.storagePath exists (loadShareContext) = true
      // 2nd: target dir exists = true
      // 3rd: index.html = false
      return callCount !== 3
    })
    mockDirEntries = []
    const res = await req('/s/_/shr_dir/')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('site')
  })

  it('GET /:agentId/:shareId/* path traversal returns 404', async () => {
    const res = await req('/s/_/shr_dir/..%2F..%2Fetc%2Fpasswd')
    expect(res.status).toBe(404)
  })
})

describe('expired/revoked share', () => {
  it('returns 404 for unknown share (no info leak)', async () => {
    mockShare = null
    const res = await req('/s/_/shr_anything')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts')
  })
})
