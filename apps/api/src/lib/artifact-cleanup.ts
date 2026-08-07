/**
 * 磁盘产物定时清理调度器
 * 每小时执行一次：过期 Artifact + 过期 run 全量日志（NDJSON）
 */
import { deleteExpiredArtifacts } from './artifact-storage.js'
import { logger } from './logger.js'
import { deleteExpiredRunLogs } from './run-log-file.js'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export function startArtifactCleanupScheduler(): void {
  setInterval(() => {
    // `deleteExpiredArtifacts` is async and has no internal catch, so a
    // synchronous try/catch around it catches nothing — the rejection escapes as
    // an unhandled one. There is no `process.on('unhandledRejection')` here, so a
    // single database blip during the hourly sweep could terminate the API.
    // Attaching .catch() to the promise is the only thing that actually guards it.
    void deleteExpiredArtifacts().catch((err) => {
      logger.error({ err }, 'Artifact cleanup failed')
    })
    // Synchronous (run-log-file.ts), so try/catch is correct here.
    try {
      deleteExpiredRunLogs()
    } catch (err) {
      logger.error({ err }, 'Run log cleanup failed')
    }
  }, CLEANUP_INTERVAL_MS)

  logger.info('Artifact cleanup scheduler started (interval: 1h)')
}
