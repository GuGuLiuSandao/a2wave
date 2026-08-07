import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Load the monorepo-root (and apps/api-local) `.env` into process.env.
 *
 * tsx/Node does not auto-load .env, so without this env had to be `export`ed by
 * the user shell — easy to forget for vars added late (e.g. the OAuth
 * external-IdP settings). `process.loadEnvFile` (Node 22+, sync, stable in 22.x)
 * reads `KEY=value` pairs and *does not* overwrite already-set env vars, so
 * shell exports still win — same precedence as dotenv. That also makes this
 * function idempotent, so the several entrypoints that call it may do so freely.
 *
 * Lives outside env.ts because operational CLIs (db:migrate) must read a raw
 * variable *before* pulling in the validated env — importing env.ts to get the
 * side effect would drag in the whole Zod schema and its startup assertions.
 */
export function loadDotenvFiles(): void {
  const candidates = [
    path.resolve(here, '../../../.env'), // monorepo root: .../a2wave/.env
    path.resolve(here, '../.env'), // apps/api-local: .../apps/api/.env
  ]
  const present = candidates.filter((p) => existsSync(p))
  if (present.length > 0 && typeof process.loadEnvFile !== 'function') {
    // Node < 20.12 has no loadEnvFile; the supported project runtime starts at
    // 20.18.1 because the existing Undici 7 dependency line requires it.
    console.warn(
      `[env] .env found (${present.join(', ')}) but this Node version (${process.version}) cannot auto-load it — upgrade to Node >= 20.18.1 or export the variables in your shell.`,
    )
  }
  for (const p of present) {
    if (typeof process.loadEnvFile === 'function') {
      try {
        process.loadEnvFile(p)
      } catch (err) {
        // Bad file shouldn't crash startup, but silence made a malformed .env
        // indistinguishable from an ignored one.
        console.warn(`[env] failed to parse ${p}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
}
