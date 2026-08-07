/**
 * Artifact 分享服务层
 * 分享链接落 DB（artifact_shares 表，id 即 URL token），可撤销、可设密码与有效期。
 * 注意：与 lib/agent-share.ts（内存态 agent 导出分享）无关，本模块持久化存储。
 */
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { artifactShares } from '../db/schema.js'
import { hashPassword } from './auth.js'
import { createId } from './id.js'
import { logger } from './logger.js'

export type ShareAccessLevel = 'public' | 'password' | 'authenticated'

export type ArtifactShareRow = typeof artifactShares.$inferSelect

export const MIN_SHARE_EXPIRY_DAYS = 1
export const MAX_SHARE_EXPIRY_DAYS = 365

/**
 * 手动创建分享、且调用方未显式指定有效期时的兜底天数。
 * 分发策略（是否自动分享、有效期）已落在 agent 级 artifactPolicy；此处仅作为
 * 「手动分享对话框未传 expiryDays」的最后兜底，不再读任何全局设置。
 */
export const DEFAULT_SHARE_EXPIRY_DAYS = 7

export async function createArtifactShare(input: {
  artifactId: string
  createdBy: string | null
  accessLevel: ShareAccessLevel
  password?: string
  expiryDays?: number
}): Promise<ArtifactShareRow> {
  const { artifactId, createdBy, accessLevel, password } = input

  if (accessLevel === 'password' && !password) {
    throw new Error('Password is required for password-protected shares')
  }

  const expiryDays = input.expiryDays ?? DEFAULT_SHARE_EXPIRY_DAYS
  if (
    !Number.isFinite(expiryDays) ||
    expiryDays < MIN_SHARE_EXPIRY_DAYS ||
    expiryDays > MAX_SHARE_EXPIRY_DAYS
  ) {
    throw new Error(
      `expiryDays must be between ${MIN_SHARE_EXPIRY_DAYS} and ${MAX_SHARE_EXPIRY_DAYS}`,
    )
  }

  const id = createId('shr')
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
  const passwordHash = accessLevel === 'password' && password ? await hashPassword(password) : null

  await db
    .insert(artifactShares)
    .values({ id, artifactId, createdBy, accessLevel, passwordHash, expiresAt })

  const row = (await db.select().from(artifactShares).where(eq(artifactShares.id, id)).limit(1))[0]
  if (!row) throw new Error('Failed to create artifact share')
  logger.info({ shareId: id, artifactId, accessLevel, expiresAt }, 'Artifact share created')
  return row
}

/** 按 id 取活跃分享；不存在/已过期/已撤销统一返回 null（调用方一律 404，防枚举探测） */
export async function getActiveShare(shareId: string): Promise<ArtifactShareRow | null> {
  const row = (
    await db.select().from(artifactShares).where(eq(artifactShares.id, shareId)).limit(1)
  )[0]
  if (!row) return null
  if (row.revokedAt) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  return row
}

export async function listSharesForArtifact(artifactId: string): Promise<ArtifactShareRow[]> {
  return await db.select().from(artifactShares).where(eq(artifactShares.artifactId, artifactId))
}

export async function revokeShare(shareId: string): Promise<void> {
  await db
    .update(artifactShares)
    .set({ revokedAt: new Date() })
    .where(eq(artifactShares.id, shareId))
}

/** 记录一次访问（viewCount + lastViewedAt），失败不影响渲染 */
export async function recordShareView(shareId: string): Promise<void> {
  try {
    // 原子自增，避免并发访问读改写丢失计数
    await db
      .update(artifactShares)
      .set({ viewCount: sql`${artifactShares.viewCount} + 1`, lastViewedAt: new Date() })
      .where(eq(artifactShares.id, shareId))
  } catch (err) {
    logger.warn({ err, shareId }, 'Failed to record share view')
  }
}

/** 清理已过期或已撤销的分享行（由产物清理调度器调用） */
export async function deleteStaleShares(): Promise<void> {
  const now = new Date()
  await db
    .delete(artifactShares)
    .where(or(lt(artifactShares.expiresAt, now), isNotNull(artifactShares.revokedAt)))
}

/** 该产物是否存在活跃分享（未撤销且未过期）——retention 豁免判断 */
export async function hasActiveShare(artifactId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: artifactShares.id })
      .from(artifactShares)
      .where(
        and(
          eq(artifactShares.artifactId, artifactId),
          isNull(artifactShares.revokedAt),
          gt(artifactShares.expiresAt, new Date()),
        ),
      )
      .limit(1)
  )[0]
  return !!row
}
