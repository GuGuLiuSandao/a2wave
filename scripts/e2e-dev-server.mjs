#!/usr/bin/env node
/**
 * Start the dev server for e2e tests and make sure the admin can log in.
 * When needSetup is reported, call /auth/setup to set the password.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const WEB_PORT = Number(process.env.WEB_PORT) || 3501
const API_PORT = Number(process.env.PORT) || 3502
const WEB_BASE = `http://localhost:${WEB_PORT}`
const API_BASE = `http://localhost:${API_PORT}`
const E2E_PASSWORD = process.env.E2E_ADMIN_PASSWORD
const FAKE_PROVIDER_E2E = process.env.A2WAVE_FAKE_PROVIDER_E2E === '1'
if (!E2E_PASSWORD) {
  console.error('[e2e-dev-server] E2E_ADMIN_PASSWORD env var is required')
  process.exit(1)
}

/**
 * Poll `url` until it answers OK. Bounded by wall-clock rather than attempt
 * count: each attempt also costs a connect/timeout, so 60 attempts expired well
 * under 60s on a cold start and reported "failed to start" while the API was
 * still compiling and migrating.
 */
async function waitFor(url, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return true
    } catch {
      // Not listening yet, or still slow to answer — keep polling.
    }
    await delay(1000)
  }
  return false
}

async function ensureAdminCanLogin() {
  const statusRes = await fetch(`${API_BASE}/api/auth/status`)
  if (!statusRes.ok) {
    throw new Error(`/api/auth/status failed with HTTP ${statusRes.status}`)
  }
  const { data } = await statusRes.json()
  if (!data?.needSetup) return
  const setupRes = await fetch(`${API_BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: E2E_PASSWORD,
      confirmPassword: E2E_PASSWORD,
    }),
  })
  if (!setupRes.ok) {
    const err = await setupRes.text()
    throw new Error(`[e2e-dev-server] setup failed with HTTP ${setupRes.status}: ${err}`)
  }
  console.log('[e2e-dev-server] Admin password set for e2e')
}

async function main() {
  const fakeClaudePath = join(process.cwd(), 'e2e/fixtures/bin/fake-claude.mjs')
  const fakeCodexPath = join(process.cwd(), 'e2e/fixtures/bin/fake-codex.mjs')
  const dataDir = mkdtempSync(join(tmpdir(), 'a2wave-e2e-'))
  process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
  const env = {
    ...process.env,
    DATABASE_URL: process.env.A2WAVE_E2E_DATABASE_URL || join(dataDir, 'a2wave.db'),
    A2WAVE_DB_BACKUP_SKIP: 'true',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || E2E_PASSWORD,
    E2E_STRICT_AUTH: '1',
    CLAUDE_CODE_PATH: FAKE_PROVIDER_E2E
      ? process.env.CLAUDE_CODE_PATH || fakeClaudePath
      : process.env.CLAUDE_CODE_PATH || 'claude',
    CODEX_PATH: FAKE_PROVIDER_E2E
      ? process.env.CODEX_PATH || fakeCodexPath
      : process.env.CODEX_PATH || 'codex',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    CORS_ORIGIN: WEB_BASE,
  }
  const child = spawn('pnpm', ['run', 'dev'], {
    stdio: 'inherit',
    env,
    shell: true,
  })

  let shuttingDown = false
  let shutdownPids = []
  const collectProcessTree = (rootPid) => {
    if (process.platform === 'win32') return [rootPid]
    try {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([pid, parentPid]) => Number.isInteger(pid) && Number.isInteger(parentPid))
      const childrenByParent = new Map()
      for (const [pid, parentPid] of rows) {
        const children = childrenByParent.get(parentPid) ?? []
        children.push(pid)
        childrenByParent.set(parentPid, children)
      }
      const result = [rootPid]
      for (let index = 0; index < result.length; index++) {
        result.push(...(childrenByParent.get(result[index]) ?? []))
      }
      return result
    } catch {
      return [rootPid]
    }
  }
  const terminateChildTree = (signal) => {
    if (shutdownPids.length === 0) shutdownPids = collectProcessTree(child.pid)
    // Stop the command root first so task runners cannot replace workers while they are killed.
    for (const pid of shutdownPids) {
      try {
        process.kill(pid, signal)
      } catch {
        // A descendant may already have exited between process-tree collection and delivery.
      }
    }
  }
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    terminateChildTree('SIGTERM')
    const forceTimer = globalThis.setTimeout(() => terminateChildTree('SIGKILL'), 5_000)
    forceTimer.unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  const webReady = await waitFor(`${WEB_BASE}/`)
  const apiReady = await waitFor(`${API_BASE}/api/health`)
  if (!webReady || !apiReady) {
    console.error('[e2e-dev-server] Server failed to start')
    process.exit(1)
  }

  await ensureAdminCanLogin()

  child.on('exit', (code) => process.exit(shuttingDown ? 0 : (code ?? 0)))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
