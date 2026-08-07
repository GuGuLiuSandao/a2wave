import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * set-admin-password is only reachable in the production image if `build`
 * compiles it into dist/scripts/. Nothing else fails when that tsup entry is
 * dropped in a refactor: the image simply ships without it, and
 * `a2wave setup --reset-password` fails at runtime with a "Cannot find
 * module" that surfaces as an unrelated diagnosis.
 *
 * apps/cli hardcodes the resulting path, so this pins the contract on the
 * producing side. Arch rule R1 forbids importing across apps, hence the
 * string comparison rather than a shared constant.
 *
 * reset-admin.ts is deliberately EXCLUDED from this list and from the image:
 * it clears passwordHash and reopens unauthenticated `POST /auth/setup`
 * immediately (isSetupRequired() reads the DB live, no restart needed) —
 * shipping it in an image reachable via `docker exec` turns a local dev
 * convenience into a live attack surface. It stays available only via
 * `pnpm reset-admin` against a source checkout.
 */
const SHIPPED_RECOVERY_SCRIPTS = ['set-admin-password']

describe('apps/api build entries', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf-8'),
  ) as { scripts: Record<string, string> }

  it.each(SHIPPED_RECOVERY_SCRIPTS)('compiles src/scripts/%s.ts into dist/scripts/', (name) => {
    expect(pkg.scripts.build).toContain(`src/scripts/${name}.ts`)
  })

  it('emits them into dist/scripts, the path apps/cli and the docs reference', async () => {
    expect(pkg.scripts.build).toContain('--outDir dist/scripts')
  })

  it('does not compile reset-admin.ts into the shipped image', async () => {
    expect(pkg.scripts.build).not.toContain('src/scripts/reset-admin.ts')
  })
})
