import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { env } from '../env.js'
import { hashPassword, validatePassword } from './auth.js'
import { logger } from './logger.js'

/** 检查是否需要 setup（admin 无密码） */
export async function isSetupRequired(): Promise<boolean> {
  const admin = (await db.select().from(users).where(eq(users.username, 'admin')).limit(1))[0]
  return !admin || admin.passwordHash === null
}

/** 确保 admin 用户记录存在（服务启动时调用）；若 ADMIN_PASSWORD 已设置且 admin 无密码，则自动写入 */
export async function ensureAdminExists(): Promise<void> {
  let admin = (await db.select().from(users).where(eq(users.username, 'admin')).limit(1))[0]
  if (!admin) {
    const inserted = await db
      .insert(users)
      .values({
        id: 'usr_admin',
        username: 'admin',
        displayName: 'Administrator',
        role: 'admin',
        passwordHash: null,
        isActive: true,
      })
      .returning()
    admin = inserted[0]
    if (!admin) return
  }

  if (admin.passwordHash === null && env.ADMIN_PASSWORD) {
    const validation = validatePassword(env.ADMIN_PASSWORD)
    if (!validation.valid) {
      // An operator who set ADMIN_PASSWORD expects the admin to be protected. If
      // the value fails policy we must NOT silently leave the admin passwordless —
      // that leaves the unauthenticated POST /auth/setup window open (anyone who
      // can reach the port claims admin) while the operator believes the account
      // is secured. Fail the boot so the misconfiguration is fixed, mirroring the
      // fail-hard migration path.
      throw new Error(
        `ADMIN_PASSWORD does not meet the password policy (${validation.message}). Set a compliant ADMIN_PASSWORD or unset it and complete first-time setup via /auth/setup.`,
      )
    }
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD)
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, admin.id))
    logger.info('Admin password set from ADMIN_PASSWORD env')
  }
}
