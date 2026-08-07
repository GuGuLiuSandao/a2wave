/**
 * 附件暂存区 TTL 定时清理调度器。每小时扫一次，回收早于 stagingTtlHours 的暂存目录。
 * TTL is re-read from Settings each round (operable and live-editable — Iron Rule 5).
 */
import { getPinnedAttachmentTokens } from './attachment-access.js'
import { deleteExpiredStagedAttachments } from './attachment-storage.js'
import { logger } from './logger.js'
import { getAttachmentSettings } from './settings.js'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour，与 artifact-cleanup 一致

async function sweep(): Promise<void> {
  try {
    const ttlMs = getAttachmentSettings().stagingTtlHours * 3600_000
    // pin 仍被非终态 run 引用的 token，避免长队列附件被 TTL 提前删。
    const pinned = await getPinnedAttachmentTokens()
    const removed = await deleteExpiredStagedAttachments(ttlMs, async (token) => pinned.has(token))
    if (removed > 0) {
      logger.info({ removed }, 'Reaped expired staged attachments')
    }
  } catch (err) {
    logger.error({ err }, 'Attachment staging cleanup failed')
  }
}

export function startAttachmentStagingCleanupScheduler(): void {
  sweep() // 启动即扫一次，收拾重启前的积压
  setInterval(sweep, CLEANUP_INTERVAL_MS)
  logger.info('Attachment staging cleanup scheduler started (interval: 1h)')
}
