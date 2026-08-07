import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Fill an unset `AUTH_SECRET=` in an existing `.env`.
 *
 * The onboarding flow is `cp .env.example .env` → `pnpm install` → `pnpm dev`,
 * and the template ships `AUTH_SECRET=` empty, so step 3 used to stop on a value
 * only the developer's own `openssl rand -hex 32` could supply. Generating it is
 * mechanical and has one correct answer, so dev does it.
 *
 * Deliberately does *not* create `.env`: the file also carries deployment
 * choices (DATABASE_URL, ports), and conjuring one would skip the template the
 * developer is meant to read. A missing file keeps failing with the setup hint.
 */

/** Matches an uncommented `AUTH_SECRET=` line whose value is empty or blank. */
const EMPTY_AUTH_SECRET_LINE = /^([ \t]*AUTH_SECRET[ \t]*=)[ \t]*$/m
/** Matches any uncommented `AUTH_SECRET=` line, filled or not. */
const ANY_AUTH_SECRET_LINE = /^[ \t]*AUTH_SECRET[ \t]*=/m

export function generateAuthSecret() {
  return randomBytes(32).toString('hex')
}

/**
 * Return `contents` with AUTH_SECRET set to `secret`, filling an existing blank
 * line in place (so the template's surrounding comments survive) or appending
 * the key when none is present. A line that already has a value is left alone.
 */
export function upsertAuthSecretLine(contents, secret) {
  if (EMPTY_AUTH_SECRET_LINE.test(contents)) {
    return contents.replace(EMPTY_AUTH_SECRET_LINE, `$1${secret}`)
  }
  if (ANY_AUTH_SECRET_LINE.test(contents)) return contents
  const separator = contents.length === 0 || contents.endsWith('\n') ? '' : '\n'
  return `${contents}${separator}AUTH_SECRET=${secret}\n`
}

/**
 * Ensure `env.AUTH_SECRET` is populated, writing a generated value into the
 * first existing file among `candidates`.
 *
 * Returns `{ status, path?, secret? }` where status is one of:
 * - `already-set`    — the environment (or the .env it was loaded from) has one
 * - `generated`      — a new secret was written to `path` and exported
 * - `missing-env-file` — no candidate exists; the caller reports the setup hint
 * - `write-failed`   — the file exists but could not be updated (`error` carries why)
 */
export function ensureAuthSecret(candidates, env) {
  if (typeof env.AUTH_SECRET === 'string' && env.AUTH_SECRET.trim() !== '') {
    return { status: 'already-set' }
  }

  const envPath = candidates.find((p) => existsSync(p))
  if (!envPath) return { status: 'missing-env-file' }

  try {
    const contents = readFileSync(envPath, 'utf8')
    const secret = generateAuthSecret()
    const next = upsertAuthSecretLine(contents, secret)
    // Unchanged means the file already carries a value that simply had not been
    // loaded into this process — adopt it rather than overwriting a live secret,
    // which would invalidate every existing session and token.
    if (next === contents) {
      const existing = contents.match(/^[ \t]*AUTH_SECRET[ \t]*=[ \t]*(.*)$/m)?.[1]?.trim()
      if (existing) {
        env.AUTH_SECRET = existing
        return { status: 'already-set', path: envPath }
      }
      return { status: 'missing-env-file' }
    }
    writeFileSync(envPath, next)
    env.AUTH_SECRET = secret
    return { status: 'generated', path: envPath, secret }
  } catch (err) {
    return { status: 'write-failed', path: envPath, error: err }
  }
}
