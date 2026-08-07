import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ensureAuthSecret, upsertAuthSecretLine } from '../ensure-auth-secret.mjs'

/**
 * `pnpm dev` used to refuse to start on an unfilled `AUTH_SECRET=`, which every
 * fresh clone hits right after `cp .env.example .env`. Filling it is mechanical,
 * so dev does it — but only into an existing .env: creating the file would hide
 * the deliberate "copy the template first" step.
 */

const dirs = []

function makeEnvDir(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'a2wave-env-'))
  dirs.push(dir)
  const envPath = join(dir, '.env')
  if (contents !== undefined) writeFileSync(envPath, contents)
  return envPath
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('upsertAuthSecretLine', () => {
  it('fills an empty AUTH_SECRET in place, preserving surrounding lines', () => {
    const out = upsertAuthSecretLine('# comment\nAUTH_SECRET=\nPORT=3502\n', 'abc')
    assert.equal(out, '# comment\nAUTH_SECRET=abc\nPORT=3502\n')
  })

  it('fills a whitespace-only value and tolerates spacing around the key', () => {
    assert.equal(upsertAuthSecretLine('  AUTH_SECRET =   \n', 'abc'), '  AUTH_SECRET =abc\n')
  })

  it('appends the key when the file has no AUTH_SECRET line', () => {
    assert.equal(upsertAuthSecretLine('PORT=3502\n', 'abc'), 'PORT=3502\nAUTH_SECRET=abc\n')
  })

  it('appends a newline first when the file does not end with one', () => {
    assert.equal(upsertAuthSecretLine('PORT=3502', 'abc'), 'PORT=3502\nAUTH_SECRET=abc\n')
  })

  it('leaves an already-filled AUTH_SECRET untouched', () => {
    assert.equal(upsertAuthSecretLine('AUTH_SECRET=kept\n', 'abc'), 'AUTH_SECRET=kept\n')
  })

  it('ignores a commented-out AUTH_SECRET and appends a real one', () => {
    assert.equal(
      upsertAuthSecretLine('# AUTH_SECRET=old\n', 'abc'),
      '# AUTH_SECRET=old\nAUTH_SECRET=abc\n',
    )
  })
})

describe('ensureAuthSecret', () => {
  it('generates a 64-char hex secret into the existing .env and exports it', () => {
    const envPath = makeEnvDir('AUTH_SECRET=\n')
    const env = {}

    const result = ensureAuthSecret([envPath], env)

    assert.equal(result.status, 'generated')
    assert.equal(result.path, envPath)
    const written = readFileSync(envPath, 'utf8')
    const match = written.match(/^AUTH_SECRET=([0-9a-f]{64})$/m)
    assert.ok(match, `expected a hex secret, got: ${written}`)
    assert.equal(env.AUTH_SECRET, match[1])
  })

  it('is a no-op when AUTH_SECRET is already set in the environment', () => {
    const envPath = makeEnvDir('AUTH_SECRET=\n')

    const result = ensureAuthSecret([envPath], { AUTH_SECRET: 'preset' })

    assert.equal(result.status, 'already-set')
    assert.equal(readFileSync(envPath, 'utf8'), 'AUTH_SECRET=\n')
  })

  it('reports missing-env-file rather than creating one', () => {
    const envPath = makeEnvDir(undefined)

    const result = ensureAuthSecret([envPath], {})

    assert.equal(result.status, 'missing-env-file')
    assert.equal(existsSyncSafe(envPath), false)
  })

  it('writes into the first candidate that exists', () => {
    const missing = makeEnvDir(undefined)
    const present = makeEnvDir('PORT=3502\n')

    const result = ensureAuthSecret([missing, present], {})

    assert.equal(result.status, 'generated')
    assert.equal(result.path, present)
    assert.match(readFileSync(present, 'utf8'), /^AUTH_SECRET=[0-9a-f]{64}$/m)
  })

  it('does not rewrite a .env that already carries a usable secret', () => {
    const envPath = makeEnvDir('AUTH_SECRET=already-there\n')

    const result = ensureAuthSecret([envPath], {})

    assert.equal(result.status, 'already-set')
    assert.equal(readFileSync(envPath, 'utf8'), 'AUTH_SECRET=already-there\n')
  })
})

function existsSyncSafe(p) {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Both templates are candidates `ensureAuthSecret` may write into (dev.mjs and
 * env.ts read the repo root first, then apps/api). A placeholder value in either
 * one is worse than no value: it counts as "already set", so generation is
 * skipped, and it then fails the production >= 32-character check at startup.
 * apps/api/.env.example shipped `change-me-to-a-random-string` (28 chars) for
 * exactly that reason, so pin the invariant rather than the one file.
 */
describe('shipped .env templates', () => {
  const repoRoot = join(import.meta.dirname, '..', '..')
  const templates = ['.env.example', join('apps', 'api', '.env.example')]

  for (const template of templates) {
    it(`${template} leaves AUTH_SECRET empty so dev can generate one`, () => {
      const contents = readFileSync(join(repoRoot, template), 'utf8')
      const line = contents.match(/^[ \t]*AUTH_SECRET[ \t]*=.*$/m)

      assert.ok(line, `${template} should document AUTH_SECRET`)
      assert.match(line[0], /^[ \t]*AUTH_SECRET[ \t]*=[ \t]*$/)
      assert.notEqual(
        upsertAuthSecretLine(contents, 'x'.repeat(64)),
        contents,
        `${template} must be fillable by ensureAuthSecret`,
      )
    })
  }
})
