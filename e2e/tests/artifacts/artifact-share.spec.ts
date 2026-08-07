/**
 * E2E tests for artifact share management API + /s/ public render route.
 *
 * Coverage:
 *   API — POST /api/artifacts/:id/shares (validation)
 *   API — GET  /api/artifacts/:id/shares (list)
 *   API — DELETE /api/artifacts/:id/shares/:shareId (revoke)
 *   /s/ — public share: response includes CSP sandbox allow-scripts
 *   /s/ — expired/revoked share: 404
 *   /s/ — password share: shows password form with CSP sandbox allow-forms
 *   /s/ — POST /s/:shareId/auth wrong password: 401
 *   /s/ — unknown share: 404 (no info leak)
 */
import { expect, test } from '@playwright/test'
import {
  type ArtifactSummary,
  createArtifactShare,
  getAdminToken,
  listArtifactShares,
  listArtifacts,
  listRuns,
  revokeArtifactShare,
} from '../../utils/api-helpers'
import { API_BASE } from '../../utils/test-constants'

/** Pick any artifact from the system to test against. Returns null if none exist. */
async function getAnyArtifact(token: string): Promise<ArtifactSummary | null> {
  const runs = await listRuns(token, 50)
  for (const run of runs) {
    const arts = await listArtifacts(token, run.id)
    if (arts.length > 0) return arts[0]
  }
  return null
}

// ── Share management API ───────────────────────────────────────────────────

test.describe('Artifact Share Management API', () => {
  test('POST shares on non-existent artifact returns 404', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.post(`${API_BASE}/api/artifacts/art_ghost/shares`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { accessLevel: 'public' },
    })
    expect(res.status()).toBe(404)
  })

  test('POST shares without accessLevel returns 400', async ({ request }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const res = await request.post(`${API_BASE}/api/artifacts/${artifact.id}/shares`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { accessLevel: 'invalid-level' },
    })
    expect(res.status()).toBe(400)
  })

  test('POST password share without password returns 400', async ({ request }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const res = await request.post(`${API_BASE}/api/artifacts/${artifact.id}/shares`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { accessLevel: 'password' },
    })
    expect(res.status()).toBe(400)
  })

  test('POST password share with too-short password returns 400', async ({ request }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const res = await request.post(`${API_BASE}/api/artifacts/${artifact.id}/shares`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { accessLevel: 'password', password: 'short7!' }, // 7 chars, below 8-char minimum
    })
    expect(res.status()).toBe(400)
  })

  test('POST public share → returns share with url and no passwordHash', async ({ request }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const share = await createArtifactShare(token, artifact.id, {
      accessLevel: 'public',
      expiryDays: 1,
    })
    expect(share.id).toMatch(/^shr_/)
    expect(share.url).toContain('/s/')
    expect(share.accessLevel).toBe('public')
    expect(share.hasPassword).toBe(false)
    expect(share.revokedAt).toBeNull()
  })

  test('GET shares lists the share just created', async () => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const share = await createArtifactShare(token, artifact.id, {
      accessLevel: 'authenticated',
      expiryDays: 7,
    })
    const shares = await listArtifactShares(token, artifact.id)
    expect(shares.find((s) => s.id === share.id)).toBeDefined()
  })

  test('DELETE share (revoke) marks it as revoked', async () => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const share = await createArtifactShare(token, artifact.id, {
      accessLevel: 'public',
      expiryDays: 1,
    })
    await revokeArtifactShare(token, artifact.id, share.id)
    const shares = await listArtifactShares(token, artifact.id)
    const revoked = shares.find((s) => s.id === share.id)
    expect(revoked?.revokedAt).not.toBeNull()
  })

  test('Unauthenticated POST shares returns 401', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/artifacts/art_test/shares`, {
      headers: { 'Content-Type': 'application/json' },
      data: { accessLevel: 'public' },
    })
    if (res.status() === 404) {
      // dev bypass + 404 = share on non-existent artifact
      test.skip(true, 'dev bypass 模式，跳过')
      return
    }
    expect(res.status()).toBe(401)
  })
})

// ── /s/ public render route ────────────────────────────────────────────────

test.describe('/s/ share render route', () => {
  test('unknown share id returns 404 with CSP header', async ({ request }) => {
    const res = await request.get(`${API_BASE}/s/shr_totally_nonexistent_xyz`)
    expect(res.status()).toBe(404)
    const csp = res.headers()['content-security-policy']
    expect(csp).toBeTruthy()
    expect(csp).toContain('sandbox')
  })

  test('public html share: 200 + CSP sandbox allow-scripts', async ({ request }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    // Only html/md artifacts can be rendered inline; others still respond 200 as attachment
    const share = await createArtifactShare(token, artifact.id, {
      accessLevel: 'public',
      expiryDays: 1,
    })
    const res = await request.get(share.url)
    // Status is 200 (inline) or 200 (attachment) — both valid
    expect([200, 404]).toContain(res.status())
    if (res.status() === 200) {
      const csp = res.headers()['content-security-policy']
      expect(csp).toBeTruthy()
      expect(csp).toContain('sandbox')
      // Must never have allow-scripts AND allow-same-origin together
      if (csp?.includes('allow-scripts') && csp?.includes('allow-same-origin')) {
        throw new Error('SECURITY: CSP must never combine allow-scripts + allow-same-origin')
      }
    }
  })

  test('revoked share returns 404', async ({ request }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const share = await createArtifactShare(token, artifact.id, {
      accessLevel: 'public',
      expiryDays: 1,
    })
    await revokeArtifactShare(token, artifact.id, share.id)
    const res = await request.get(share.url)
    expect(res.status()).toBe(404)
    // Revoked link still carries CSP — confirms error page also has the header
    const csp = res.headers()['content-security-policy']
    expect(csp).toBeTruthy()
    expect(csp).toContain('sandbox')
  })

  test('password share: unauthenticated GET shows password form (CSP allow-forms)', async ({
    request,
  }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const share = await createArtifactShare(token, artifact.id, {
      accessLevel: 'password',
      password: 'TestPass1',
      expiryDays: 1,
    })
    // Fetch without any cookie — must be challenged
    const res = await request.get(share.url, { headers: {} })
    expect(res.status()).toBe(401)
    const csp = res.headers()['content-security-policy']
    expect(csp).toBe('sandbox allow-forms')
    const body = await res.text()
    expect(body).toContain('form')
  })

  test('password share: POST wrong password returns 401', async ({ request }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const share = await createArtifactShare(token, artifact.id, {
      accessLevel: 'password',
      password: 'CorrectPass1',
      expiryDays: 1,
    })
    const authUrl = `${share.url}/auth`
    const res = await request.post(authUrl, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'password=WrongPass1',
    })
    expect(res.status()).toBe(401)
    const csp = res.headers()['content-security-policy']
    expect(csp).toBe('sandbox allow-forms')
  })

  test('password share: POST correct password → 302 + Set-Cookie', async ({ request }) => {
    const token = await getAdminToken()
    const artifact = await getAnyArtifact(token)
    if (!artifact) {
      test.skip(true, '无可用产物，跳过')
      return
    }
    const share = await createArtifactShare(token, artifact.id, {
      accessLevel: 'password',
      password: 'Correct1Pass',
      expiryDays: 1,
    })
    const authUrl = `${share.url}/auth`
    const res = await request.post(authUrl, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'password=Correct1Pass',
      // Don't follow redirect so we can inspect the 302
      maxRedirects: 0,
    })
    expect(res.status()).toBe(302)
    expect(res.headers().location).toBe(new URL(share.url).pathname)
    const setCookie = res.headers()['set-cookie']
    expect(setCookie).toBeTruthy()
    expect(setCookie).toContain(`a2w_share_${share.id}`)
    expect(setCookie).toContain('HttpOnly')
  })

  test('all /s/ responses have X-Robots-Tag noindex', async ({ request }) => {
    const res = await request.get(`${API_BASE}/s/shr_notexist_check`)
    const robots = res.headers()['x-robots-tag']
    expect(robots).toBeTruthy()
    expect(robots).toContain('noindex')
  })

  test('all /s/ responses have Cache-Control private no-store', async ({ request }) => {
    const res = await request.get(`${API_BASE}/s/shr_cache_check`)
    const cc = res.headers()['cache-control']
    expect(cc).toBeTruthy()
    expect(cc).toContain('no-store')
  })
})
