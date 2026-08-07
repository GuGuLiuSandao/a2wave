/**
 * Agent 导出临时分享链接
 *
 * 限制说明：
 * - 内存存储，进程重启后所有分享链接失效
 * - 多副本部署时，token 仅在创建它的实例上有效（需粘性会话或共享存储）
 * - 单实例部署（当前默认架构）下无此问题
 */
import { randomBytes } from 'node:crypto'

interface ShareEntry {
  agentId: string
  expiresAt: number
}

const SHARE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_SHARES = 1000 // prevent memory leak

const shareStore = new Map<string, ShareEntry>()

/** Generate a share token for an agent export, valid for 24h */
export function createShareToken(agentId: string): string {
  // Evict expired entries first
  evictExpired()

  if (shareStore.size >= MAX_SHARES) {
    // Remove oldest entry
    const oldest = shareStore.keys().next().value
    if (oldest) shareStore.delete(oldest)
  }

  const token = randomBytes(24).toString('base64url')
  shareStore.set(token, {
    agentId,
    expiresAt: Date.now() + SHARE_TTL_MS,
  })
  return token
}

/** Validate a share token, returns agentId if valid */
export function validateShareToken(token: string): string | null {
  const entry = shareStore.get(token)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    shareStore.delete(token)
    return null
  }
  return entry.agentId
}

function evictExpired(): void {
  const now = Date.now()
  for (const [token, entry] of shareStore) {
    if (now > entry.expiresAt) {
      shareStore.delete(token)
    }
  }
}
