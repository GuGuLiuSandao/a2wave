/**
 * Ensure the administrator can log in before e2e tests start.
 * First-time setup takes no bootstrap credential, so an uninitialized server is
 * initialized here directly.
 * e2e-dev-server.mjs handles servers started by Playwright.
 */
import { API_BASE } from './utils/test-constants'

const E2E_PASSWORD = process.env.E2E_ADMIN_PASSWORD
if (!E2E_PASSWORD) {
  throw new Error('E2E_ADMIN_PASSWORD env var is required for e2e tests')
}

async function waitForApi(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return false
    try {
      const res = await fetch(`${API_BASE}/api/health`, {
        signal: AbortSignal.timeout(Math.min(2_000, remainingMs)),
      })
      if (res.ok) return true
    } catch {
      // ignore
    }
    const delayMs = Math.min(1_000, deadline - Date.now())
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

export default async function globalSetup() {
  const up = await waitForApi()
  if (!up) {
    throw new Error(`[e2e globalSetup] API did not become healthy at ${API_BASE}`)
  }

  const statusRes = await fetch(`${API_BASE}/api/auth/status`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!statusRes.ok) {
    throw new Error(`[e2e globalSetup] /api/auth/status failed with HTTP ${statusRes.status}`)
  }
  const { data } = await statusRes.json()
  if (!data?.needSetup) return

  const setupRes = await fetch(`${API_BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      password: E2E_PASSWORD,
      confirmPassword: E2E_PASSWORD,
    }),
  })
  if (!setupRes.ok) {
    const code = await setupRes
      .json()
      .then((body) => (body as { error?: unknown }).error)
      .catch(() => undefined)
    throw new Error(
      `[e2e globalSetup] /api/auth/setup failed with HTTP ${setupRes.status}${typeof code === 'string' ? `: ${code}` : ''}`,
    )
  }
  console.log('[e2e globalSetup] Admin password set for e2e')
}
