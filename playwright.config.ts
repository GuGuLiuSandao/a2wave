import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * Load repo-root `.env` so `pnpm test:e2e` picks up E2E_ADMIN_PASSWORD (and
 * friends) without an inline prefix. Zero-dep on purpose — avoids pulling in
 * dotenv just for the test harness. Runs in the Playwright process, so both
 * globalSetup (same process) and the spawned dev server (webServer.env spreads
 * `...process.env` below) inherit it. Existing env vars win, so an inline
 * `E2E_ADMIN_PASSWORD=… pnpm test:e2e` still overrides the file.
 */
function loadDotenv() {
  let raw: string
  try {
    // Resolve from cwd — `pnpm test:e2e` always runs from the repo root where
    // both this config and `.env` live. (Avoid import.meta.url: Playwright
    // loads the config as CJS and it would break the transform.)
    raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
  } catch {
    return // no .env — rely on the ambient environment
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!key || key in process.env) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

loadDotenv()

// Isolated E2E runs use deterministic local CLI fixtures by default. Set this
// to 0 only when intentionally exercising locally installed provider CLIs.
process.env.A2WAVE_FAKE_PROVIDER_E2E ??= '1'

const WEB_PORT = Number(process.env.WEB_PORT) || 3501
const API_PORT = Number(process.env.PORT) || 3502
const WEB_BASE = `http://localhost:${WEB_PORT}`
const API_HEALTH_URL = `http://localhost:${API_PORT}/api/health`

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: 'html',

  use: {
    baseURL: WEB_BASE,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'node scripts/e2e-dev-server.mjs',
    // Probe the API, not the web root. Vite serves within ~2s while the API
    // still needs ~30s (tsx compile + migrations + seeding); gating on WEB_BASE
    // declared the stack ready that early and let globalSetup race a booting
    // API, which surfaced as ECONNREFUSED on :3502 and cascading test failures.
    // The API is the later of the two, so waiting on it implies both are up.
    url: API_HEALTH_URL,
    reuseExistingServer: true,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 7_000 },
    env: {
      ...process.env,
      ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD ?? '',
      E2E_STRICT_AUTH: '1',
      WEB_PORT: String(WEB_PORT),
      PORT: String(API_PORT),
    },
  },
})
