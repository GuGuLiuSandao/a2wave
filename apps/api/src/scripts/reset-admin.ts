import path from 'node:path'
/**
 * Reset admin password — clears the admin's passwordHash so
 * the next startup triggers the setup flow.
 *
 * Usage: pnpm run reset-admin
 */
import { fileURLToPath } from 'node:url'

// Same fallback as db/migrate.ts: env.ts defaults NODE_ENV to 'production',
// whose AUTH_SECRET superRefine would fail this local admin-recovery command
// with a confusing "production" error.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development'
// This script writes a password hash and never signs/verifies tokens; keep it
// usable even when .env is missing (the exact recovery scenario it exists for).
if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = 'ops-script-placeholder-secret-unused'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(__dirname, '..', '..')
process.chdir(apiRoot)

const { eq, sql } = await import('drizzle-orm')
const { db } = await import('../db/client.js')
const { withTransaction } = await import('../db/transaction.js')
const { users } = await import('../db/schema.js')
const { logBackgroundAudit } = await import('../lib/audit.js')
const { AUDIT_ACTIONS } = await import('../lib/audit-actions.js')

const admin = (await db.select().from(users).where(eq(users.username, 'admin')).limit(1))[0]
if (!admin) {
  console.error('Admin user not found. Run the migration first.')
  process.exit(1)
}

// One transaction, so the credential change and its audit entry cannot land
// apart: clearing the hash without a trail is exactly the untraceable state
// Iron Rule 5 forbids.
await withTransaction(async (tx) => {
  await tx
    .update(users)
    .set({
      passwordHash: null,
      // auth-middleware never checks passwordHash — only tokenVersion and
      // isActive — so clearing the hash alone leaves every outstanding admin
      // token (browser cookie, CLI config, a leaked JWT) valid throughout the
      // unauthenticated setup window this opens.
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, admin.id))
  // Awaited: this script exits the process a few lines later, so an unawaited
  // insert can be abandoned mid-flight — and on PostgreSQL it would in any case
  // be issued after `tx` has already committed and released its client. Either
  // way the credential reset lands with no trail (Iron Rule 5).
  await logBackgroundAudit(
    {
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET,
      resource: 'user',
      resourceId: admin.id,
      details: { via: 'reset-admin.ts', note: 'passwordHash cleared, setup mode reopened' },
    },
    tx,
  )
})

console.log('Admin password has been reset — this reopens the platform setup screen.')
console.log(
  'Complete setup NOW: /auth/setup takes no credential while the admin has no password, ' +
    'so whoever reaches this instance first claims the admin account.',
)
process.exit(0)
