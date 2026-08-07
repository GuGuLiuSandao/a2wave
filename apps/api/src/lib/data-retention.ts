import { and, eq, gt, inArray, isNull, lt, notExists } from 'drizzle-orm'
import { db } from '../db/client.js'
import { artifactShares, artifacts, auditLogs, runs } from '../db/schema.js'
import { purgeArtifactFilesForRuns } from './artifact-storage.js'
import { logBackgroundAudit } from './audit.js'
import { logger } from './logger.js'
import { getSetting } from './settings.js'

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const
// Rows deleted per batch. Must stay well under better-sqlite3's
// MAX_VARIABLE_NUMBER (32766) since each id becomes one bound `?` in the IN (...)
// of both the artifact purge and the run delete.
const RETENTION_DELETE_BATCH = 500

export interface RetentionPolicy {
  enabled: boolean
  retentionDays: number
}

/** Read + validate the retention policy from settings, falling back to defaults. */
export async function resolveRetentionPolicy(): Promise<RetentionPolicy> {
  const enabled = getSetting('dataRetention', 'enabled') !== 'false'
  const raw = Number(getSetting('dataRetention', 'retentionDays'))
  // Guard against 0/negative/NaN, which would delete everything; fall back to 60.
  const retentionDays = Number.isFinite(raw) && raw > 0 ? raw : 60
  return { enabled, retentionDays }
}

export interface RetentionDeps {
  deleteTerminalRunsBefore: (cutoff: Date, now?: Date) => Promise<number>
  deleteAuditLogsBefore: (cutoff: Date) => Promise<number>
}

const defaultDeps: RetentionDeps = {
  // Deleting a terminal run cascades to its run_steps + chat_messages AND its
  // artifacts + artifact_shares (FK onDelete: 'cascade', foreign_keys=ON). The
  // cascade only removes DB rows, so we first physically purge the artifact
  // files for these runs — otherwise the bulk delete strands them on disk.
  //
  // Age by updatedAt, NOT createdAt: a debug conversation reuses one run row and
  // only bumps updatedAt on each turn, so a months-old-but-still-active session
  // would be deleted (with today's messages) if we aged by createdAt.
  async deleteTerminalRunsBefore(cutoff, now = new Date()) {
    // Exclude runs that still own an artifact with an ACTIVE share (not revoked,
    // not expired). Deleting such a run would cascade-drop the share and its
    // file, breaking a link the user was promised until its expiry (up to 365d).
    // Those runs are simply retried on a later sweep once the share lapses.
    const hasActiveShare = notExists(
      db
        .select({ id: artifactShares.id })
        .from(artifactShares)
        .innerJoin(artifacts, eq(artifactShares.artifactId, artifacts.id))
        .where(
          and(
            eq(artifacts.runId, runs.id),
            isNull(artifactShares.revokedAt),
            gt(artifactShares.expiresAt, now),
          ),
        ),
    )
    const doomedFilter = and(
      inArray(runs.status, [...TERMINAL_STATUSES]),
      lt(runs.updatedAt, cutoff),
      hasActiveShare,
    )
    // Delete in fixed batches. An unbounded IN (...) would exceed better-sqlite3's
    // MAX_VARIABLE_NUMBER (32766) once the backlog is large enough, throwing "too
    // many SQL variables" — and because each sweep re-selects the FULL backlog,
    // that state would never self-heal. RETENTION_DELETE_BATCH keeps every IN
    // clause (doomed select, artifact purge, run delete) well under the limit.
    let totalDeleted = 0
    while (true) {
      const doomed = await db
        .select({ id: runs.id })
        .from(runs)
        .where(doomedFilter)
        .limit(RETENTION_DELETE_BATCH)
      if (doomed.length === 0) break
      const ids = doomed.map((r) => r.id)
      // Purge files first, then delete this batch (cascade clears artifact rows).
      // Awaited: the purge reads artifacts by runId, so racing it against the
      // DELETE below lets the cascade wipe those rows first — the purge then
      // finds nothing and the files are stranded on disk forever.
      await purgeArtifactFilesForRuns(ids)
      const res = await db.delete(runs).where(inArray(runs.id, ids)).returning({ id: runs.id })
      totalDeleted += res.length
      // A short batch means the backlog is drained; avoid a needless empty query.
      if (doomed.length < RETENTION_DELETE_BATCH) break
    }
    return totalDeleted
  },
  async deleteAuditLogsBefore(cutoff) {
    // Batched for the same reason the runs sweep is: the first cleanup on a busy
    // deployment can face hundreds of thousands of rows, and RETURNING pulls
    // every id back into memory purely to be counted. `.returning({id})` on the
    // WRONG table's column (runs.id) used to hide here — it happened to work
    // only because drizzle strips the qualifier for a single-table delete and
    // audit_logs also has an `id`, so any rename would have turned it into a
    // hard SQL error.
    let totalDeleted = 0
    while (true) {
      const doomed = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(lt(auditLogs.createdAt, cutoff))
        .limit(RETENTION_DELETE_BATCH)
      if (doomed.length === 0) break
      const ids = doomed.map((r) => r.id)
      const res = await db
        .delete(auditLogs)
        .where(inArray(auditLogs.id, ids))
        .returning({ id: auditLogs.id })
      totalDeleted += res.length
      if (doomed.length < RETENTION_DELETE_BATCH) break
    }
    return totalDeleted
  },
}

/**
 * Delete history older than the policy window. Evaluation task/result history is
 * deliberately NOT pruned here — it's kept for config-comparison across tasks.
 * `now`/`deps` are injected for testing. Returns rows deleted per table.
 */
export async function runDataRetentionSweep(
  policy: RetentionPolicy,
  now: Date,
  deps: RetentionDeps = defaultDeps,
): Promise<{ runs: number; auditLogs: number }> {
  if (!policy.enabled) return { runs: 0, auditLogs: 0 }
  const cutoff = new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000)
  return {
    runs: await deps.deleteTerminalRunsBefore(cutoff, now),
    auditLogs: await deps.deleteAuditLogsBefore(cutoff),
  }
}

/** Start the daily retention sweeper. Returns a stop function. */
export function startDataRetentionSweeper(intervalMs = SWEEP_INTERVAL_MS): () => void {
  const tick = async () => {
    try {
      const policy = await resolveRetentionPolicy()
      const deleted = await runDataRetentionSweep(policy, new Date())
      if (deleted.runs > 0 || deleted.auditLogs > 0) {
        logger.info({ ...deleted, retentionDays: policy.retentionDays }, 'Data retention sweep')
        // Background destructive write needs a durable audit trail (not just a
        // log line) — records policy, window and how much was removed.
        logBackgroundAudit({
          action: 'data_retention.sweep',
          resource: 'data_retention',
          details: {
            retentionDays: policy.retentionDays,
            deletedRuns: deleted.runs,
            deletedAuditLogs: deleted.auditLogs,
          },
        })
      }
    } catch (error) {
      logger.error({ error }, 'data-retention: sweep failed')
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
