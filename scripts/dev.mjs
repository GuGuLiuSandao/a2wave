#!/usr/bin/env node
/**
 * Dev orchestrator: runs shared (tsup --watch), api and web together and keeps
 * their lifecycles tied — when any one of them exits, the others are torn down
 * and the orchestrator exits non-zero.
 *
 * Replaces the previous `a & b & c` shell parallelism, which left the web dev
 * server (and its /api proxy) alive after an API crash, so the app looked "up"
 * while every request failed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureAuthSecret } from './ensure-auth-secret.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = platform() === 'win32'
// On Windows `pnpm` is a .cmd shim which Node >= 20.12.2 refuses to spawn
// without a shell (batch-file CVE fix → EINVAL).
const spawnOpts = { stdio: 'inherit', cwd: repoRoot, shell: isWindows }

// AUTH_SECRET is mandatory (env.ts refuses to start without it). Check here
// before spawning anything so the failure is one clear message instead of an
// API crash amid three interleaved watcher outputs. Load the same two .env
// candidates env.ts itself supports (repo root, then apps/api-local).
const envCandidates = [resolve(repoRoot, '.env'), resolve(repoRoot, 'apps/api/.env')]
if (!process.env.AUTH_SECRET && typeof process.loadEnvFile === 'function') {
  for (const envPath of envCandidates) {
    if (!existsSync(envPath)) continue
    try {
      process.loadEnvFile(envPath)
    } catch {
      // env.ts will report the parse problem with more detail
    }
  }
}
// Still unset means the template's empty `AUTH_SECRET=` was never filled — the
// one manual step in `cp .env.example .env` → `pnpm install` → `pnpm dev`. It
// has a single correct answer, so generate it instead of stopping. A *missing*
// .env still stops: that file also carries DATABASE_URL and ports, and the
// developer is meant to start from the template.
const secretResult = ensureAuthSecret(envCandidates, process.env)
if (secretResult.status === 'generated') {
  console.log(`[dev] AUTH_SECRET was empty — generated one into ${secretResult.path}`)
}
if (secretResult.status === 'write-failed') {
  const detail =
    secretResult.error instanceof Error ? secretResult.error.message : secretResult.error
  console.error(`[dev] ✗ could not write AUTH_SECRET into ${secretResult.path}: ${detail}`)
  console.error('[dev]   set it manually (generate one: openssl rand -hex 32)')
  process.exit(1)
}
if (!process.env.AUTH_SECRET) {
  console.error('[dev] ✗ AUTH_SECRET is not set and no .env was found — refusing to start.')
  console.error('[dev]   1. cp .env.example .env')
  console.error('[dev]   2. pnpm dev (AUTH_SECRET is generated for you if left empty)')
  process.exit(1)
}

// On a fresh clone packages/shared/dist does not exist yet (gitignored), and
// both vite and tsx resolve @a2wave/shared → dist/index.js. Starting all three
// watchers at once races tsup's first emit and yields two different unreadable
// errors. One up-front build removes the race; afterwards tsup --watch takes over.
const sharedDist = resolve(repoRoot, 'packages/shared/dist/index.js')
if (!existsSync(sharedDist)) {
  console.log('[dev] packages/shared/dist missing (fresh clone?) — building once before watch…')
  const build = spawnSync('pnpm', ['--filter', '@a2wave/shared', 'build'], spawnOpts)
  if (build.status !== 0) {
    console.error('[dev] shared build failed — cannot start api/web without it')
    process.exit(build.status ?? 1)
  }
}

const SERVICES = [
  { name: 'shared', filter: '@a2wave/shared' },
  { name: 'api', filter: '@a2wave/api' },
  { name: 'web', filter: '@a2wave/web' },
]

const children = new Map()
let shuttingDown = false

/**
 * Signal a service's whole process group, not just the direct pnpm wrapper.
 * `child.kill()` alone leaves vite/tsx/tsup grandchildren orphaned holding the
 * ports — the exact problem this orchestrator exists to prevent. Children are
 * spawned `detached` (own process group) so `kill(-pid)` reaches everything.
 */
function signalTree(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    if (isWindows) {
      // No process groups on Windows; taskkill /T walks the child tree.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    // Group already gone — fall back to the direct child just in case.
    try {
      child.kill(signal)
    } catch {
      /* already dead */
    }
  }
}

function shutdown(exitCode, reason) {
  if (shuttingDown) return
  shuttingDown = true
  if (reason) console.error(`\n[dev] ${reason}`)
  for (const [name, child] of children) {
    if (child.exitCode === null) {
      console.error(`[dev] stopping ${name}…`)
      signalTree(child, 'SIGTERM')
    }
  }
  // Escalate if something ignores SIGTERM.
  setTimeout(() => {
    for (const child of children.values()) signalTree(child, 'SIGKILL')
    process.exit(exitCode)
  }, 3000).unref()
  // Exit as soon as everything is down.
  const poll = setInterval(() => {
    if ([...children.values()].every((c) => c.exitCode !== null)) {
      clearInterval(poll)
      process.exit(exitCode)
    }
  }, 100)
  poll.unref()
}

for (const { name, filter } of SERVICES) {
  const child = spawn('pnpm', ['--filter', filter, 'dev'], {
    ...spawnOpts,
    // Own process group so teardown can signal the whole tree (see signalTree).
    // Not on Windows: detached there opens a new console window.
    detached: !isWindows,
    env: process.env,
  })
  children.set(name, child)
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    const detail = signal ? `signal ${signal}` : `code ${code}`
    shutdown(code ?? 1, `${name} exited (${detail}) — shutting the rest down`)
  })
  child.on('error', (err) => {
    if (shuttingDown) return
    shutdown(1, `${name} failed to start: ${err.message}`)
  })
}

// With detached children the tty no longer delivers Ctrl+C to them — the
// orchestrator receives SIGINT and fans it out via signalTree.
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
