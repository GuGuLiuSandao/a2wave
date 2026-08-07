import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

/**
 * The Docker quickstart is `cp .env.example .env` → `docker compose up`, and the
 * template ships `AUTH_SECRET=` empty. Compose's `${AUTH_SECRET:?}` rejects an
 * *empty* value, not merely an unset one, so the documented two commands failed
 * on the second — the first ten seconds of every new user's experience.
 *
 * `pnpm dev` already solves this via scripts/ensure-auth-secret.mjs; the container
 * had no equivalent. ensure-container-auth-secret.sh is that equivalent: it mints
 * a secret into the persisted data directory on first boot so a restart keeps
 * every existing session valid, and it never overrides an explicit value.
 */

const SCRIPT = join(import.meta.dirname, '..', 'ensure-container-auth-secret.sh')
const dirs = []

function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'a2wave-container-secret-'))
  dirs.push(dir)
  return dir
}

/** Run the helper and return its stdout, mirroring how the entrypoint sources it. */
function run(dataDir, env = {}) {
  const stdout = execFileSync('/bin/sh', [SCRIPT, dataDir], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  })
  return stdout.trim()
}

/** Run and capture stderr, where every diagnostic goes so it cannot pollute the secret. */
function runStderr(dataDir, env = {}) {
  const res = spawnSync('/bin/sh', [SCRIPT, dataDir], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  })
  return { stdout: res.stdout.trim(), stderr: res.stderr, status: res.status }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ensure-container-auth-secret.sh', () => {
  it('prints an explicitly provided AUTH_SECRET unchanged and writes no file', () => {
    const dir = makeDataDir()
    const explicit = 'x'.repeat(48)

    assert.equal(run(dir, { AUTH_SECRET: explicit }), explicit)
    assert.throws(() => statSync(join(dir, '.auth-secret')))
  })

  it('generates a secret of at least the 32-char production floor when unset', () => {
    const secret = run(makeDataDir())

    assert.match(secret, /^[0-9a-f]{64}$/)
  })

  it('persists the generated secret so a restart keeps existing sessions valid', () => {
    const dir = makeDataDir()

    const first = run(dir)
    const second = run(dir)

    assert.equal(second, first, 'a second boot must reuse the stored secret')
    assert.equal(readFileSync(join(dir, '.auth-secret'), 'utf8').trim(), first)
  })

  it('stores the secret readable only by its owner', () => {
    const dir = makeDataDir()
    run(dir)

    const mode = statSync(join(dir, '.auth-secret')).mode & 0o777
    assert.equal(mode, 0o600)
  })

  it('prefers an explicit AUTH_SECRET over an already-stored one without overwriting it', () => {
    const dir = makeDataDir()
    const stored = run(dir)
    const explicit = 'y'.repeat(48)

    assert.equal(run(dir, { AUTH_SECRET: explicit }), explicit)
    assert.equal(readFileSync(join(dir, '.auth-secret'), 'utf8').trim(), stored)
  })

  it('treats a blank stored secret as absent and regenerates', () => {
    const dir = makeDataDir()
    const secretPath = join(dir, '.auth-secret')
    writeFileSync(secretPath, '   \n')
    chmodSync(secretPath, 0o600)

    assert.match(run(dir), /^[0-9a-f]{64}$/)
  })

  it('ignores a whitespace-only AUTH_SECRET, matching the .env.example empty line', () => {
    const dir = makeDataDir()

    assert.match(run(dir, { AUTH_SECRET: '   ' }), /^[0-9a-f]{64}$/)
  })

  it('warns loudly when it mints a new secret, since that invalidates every session', () => {
    const { stderr } = runStderr(makeDataDir())

    assert.match(stderr, /generating a new one/)
    assert.match(stderr, /stop being valid/)
    // Compose's ${AUTH_SECRET:?} used to fail fast here; the warning has to name the
    // broken-injection case that replaced it.
    assert.match(stderr, /injection is broken/)
  })

  it('says which source it used, so a silent rotation is distinguishable in logs', () => {
    const dir = makeDataDir()

    assert.match(
      runStderr(dir, { AUTH_SECRET: 'z'.repeat(48) }).stderr,
      /supplied by the environment/,
    )
    run(dir)
    assert.match(runStderr(dir).stderr, /reusing the generated secret/)
  })

  it('keeps diagnostics on stderr so stdout carries only the secret', () => {
    const { stdout } = runStderr(makeDataDir())

    assert.match(stdout, /^[0-9a-f]{64}$/)
  })

  it('refuses a symlinked secret file even when AUTH_SECRET is supplied', () => {
    const dir = makeDataDir()
    symlinkSync('/etc/hostname', join(dir, '.auth-secret'))

    // The check runs before the explicit-value return, so an injecting deployment
    // still fails on a tampered path rather than skipping the check entirely.
    const { status, stderr } = runStderr(dir, { AUTH_SECRET: 'z'.repeat(48) })

    assert.equal(status, 1)
    assert.match(stderr, /symlink/)
  })

  /**
   * AUTH_SECRET used to be mandatory, which implicitly forced every multi-replica
   * deployment to inject one shared value. Generating it removed that forcing
   * function — and a PostgreSQL URL is exactly the signal that replicas may share a
   * database while each holds its own /app/data, so per-instance secrets would mean
   * random 401s across replicas and SSO config one replica cannot decrypt.
   */
  it('refuses to generate a per-instance secret when DATABASE_URL is PostgreSQL', () => {
    const { status, stderr } = runStderr(makeDataDir(), {
      DATABASE_URL: 'postgres://a2wave:a2wave@postgres:5432/a2wave',
    })

    assert.equal(status, 1)
    assert.match(stderr, /AUTH_SECRET must be set explicitly/)
    assert.match(stderr, /replica/)
  })

  it('accepts the postgresql:// spelling too', () => {
    const { status } = runStderr(makeDataDir(), {
      DATABASE_URL: 'postgresql://a2wave@postgres:5432/a2wave',
    })

    assert.equal(status, 1)
  })

  it('still honours an explicit AUTH_SECRET on PostgreSQL', () => {
    const explicit = 'q'.repeat(48)
    const { status, stdout } = runStderr(makeDataDir(), {
      DATABASE_URL: 'postgres://a2wave@postgres:5432/a2wave',
      AUTH_SECRET: explicit,
    })

    assert.equal(status, 0)
    assert.equal(stdout, explicit)
  })

  it('reuses an already-stored secret on PostgreSQL rather than failing', () => {
    // An existing file means this instance already had a stable identity; failing
    // now would break a running deployment that predates this guard.
    const dir = makeDataDir()
    const first = run(dir)

    const { status, stdout } = runStderr(dir, {
      DATABASE_URL: 'postgres://a2wave@postgres:5432/a2wave',
    })

    assert.equal(status, 0)
    assert.equal(stdout, first)
  })

  it('generates normally for a SQLite path', () => {
    const { status, stdout } = runStderr(makeDataDir(), { DATABASE_URL: '/app/data/a2wave.db' })

    assert.equal(status, 0)
    assert.match(stdout, /^[0-9a-f]{64}$/)
  })

  /**
   * The guard has to agree with apps/api/src/db/dialect.ts, which matches
   * /^postgres(ql)?:\/\//i against a trimmed string. A stricter shell test lets
   * `PostgreSQL://…` through while the app still connects to PostgreSQL — the guard
   * would report success and hand back exactly the per-instance secret it exists to
   * prevent, which is worse than not having it.
   */
  for (const url of [
    'PostgreSQL://a2wave@postgres:5432/a2wave',
    'POSTGRES://a2wave@postgres:5432/a2wave',
    'PostgresQL://a2wave@postgres:5432/a2wave',
    '  postgres://a2wave@postgres:5432/a2wave',
    '\tpostgresql://a2wave@postgres:5432/a2wave',
  ]) {
    it(`refuses to generate for DATABASE_URL=${JSON.stringify(url)}`, () => {
      const { status, stderr } = runStderr(makeDataDir(), { DATABASE_URL: url })

      assert.equal(status, 1)
      assert.match(stderr, /AUTH_SECRET must be set explicitly/)
    })
  }

  /**
   * The mirror image: a SQLite file whose *name* contains "postgres" must not be
   * mistaken for a connection string — dialect.ts anchors the scheme for the same
   * reason, and a substring test here would block a legitimate SQLite deployment.
   */
  for (const url of ['./data/postgres-backup.db', '/app/data/a2wave.db', 'sqlite-postgres.db']) {
    it(`still generates for the SQLite path ${JSON.stringify(url)}`, () => {
      const { status, stdout } = runStderr(makeDataDir(), { DATABASE_URL: url })

      assert.equal(status, 0)
      assert.match(stdout, /^[0-9a-f]{64}$/)
    })
  }
})
