import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
/**
 * Artifacts API 路由
 * GET  /api/artifacts?runId=xxx  列出产物
 * GET  /api/artifacts/:id/download  下载产物
 * DELETE /api/artifacts/:id  删除产物
 */
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { artifacts } from '../db/schema.js'
import { getArtifactReadFilter, hasAgentScopedAccess } from '../lib/agent-access.js'
import {
  MAX_ZIP_SOURCE_BYTES,
  getArtifactsStorageRoot,
  zipDirectoryToBuffer,
} from '../lib/artifact-storage.js'
import { logAudit } from '../lib/audit.js'
import { NotFoundError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { getSetting } from '../lib/settings.js'
import { streamFileDownload } from '../lib/stream-file-download.js'

const app = new Hono()

/** GET /artifacts?runId=xxx | ?agentId=xxx - 列出某次 Run 或某个 Agent 的产物 */
app.get('/', async (c) => {
  const { runId, agentId } = c.req.query()
  if (!runId && !agentId) {
    return c.json({ error: 'runId or agentId is required' }, 400)
  }

  const scopeFilter = runId ? eq(artifacts.runId, runId) : eq(artifacts.agentId, agentId)
  const visibilityFilter = getArtifactReadFilter(c)
  const conditions = visibilityFilter ? and(scopeFilter, visibilityFilter) : scopeFilter

  const data = await db
    .select({
      id: artifacts.id,
      runId: artifacts.runId,
      agentId: artifacts.agentId,
      userId: artifacts.userId,
      filename: artifacts.filename,
      kind: artifacts.kind,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      expiresAt: artifacts.expiresAt,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .where(conditions)
    .orderBy(desc(artifacts.createdAt))
  return c.json({ data })
})

/** GET /artifacts/:id/download - 下载产物 */
app.get('/:id/download', async (c) => {
  const { id } = c.req.param()

  const artifact = (await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1))[0]
  if (!artifact) throw new NotFoundError('Artifact')

  // When download auth is off the endpoint is unauthenticated by design (see the
  // middleware in index.ts) — the link inside an agent's reply must stay usable.
  // When it is on, authorize the same way the listing does, otherwise turning the
  // setting on would 403 an agent owner out of their own agent's artifacts.
  const requireAuth = getSetting('artifacts', 'requireAuthForDownload') === 'true'
  if (requireAuth && !(await hasAgentScopedAccess(c, artifact, 'read'))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  // Path traversal protection: ensure storagePath is within the artifacts root
  const artifactsRoot = resolve(await getArtifactsStorageRoot())
  const resolvedPath = resolve(artifact.storagePath)
  if (!resolvedPath.startsWith(`${artifactsRoot}/`) && resolvedPath !== artifactsRoot) {
    logger.warn(
      { artifactId: id, storagePath: artifact.storagePath },
      'Artifact storagePath outside allowed root',
    )
    return c.json({ error: 'Forbidden' }, 403)
  }

  if (!existsSync(resolvedPath)) {
    logger.warn({ artifactId: id }, 'Artifact file not found on disk')
    return c.json({ error: 'File not found' }, 404)
  }

  // 目录产物打包为 zip 下载（内存构建，超大目录拒绝）
  if (artifact.kind === 'directory') {
    if ((artifact.size ?? 0) > MAX_ZIP_SOURCE_BYTES) {
      return c.json({ error: 'Directory artifact too large to download as zip' }, 413)
    }
    const zipBuffer = zipDirectoryToBuffer(resolvedPath, artifact.filename)
    const encodedName = encodeURIComponent(`${artifact.filename}.zip`)
    return new Response(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
        'Content-Length': String(zipBuffer.length),
      },
    })
  }

  return streamFileDownload(c, resolvedPath, {
    filename: artifact.filename,
    mimeType: artifact.mimeType ?? 'application/octet-stream',
    size: artifact.size,
  })
})

/** DELETE /artifacts/:id - 删除产物 */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()

  const artifact = (await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1))[0]
  if (!artifact) throw new NotFoundError('Artifact')

  // Deleting destroys the file for everyone, so it needs write on the agent —
  // a viewer may see the artifact but may only delete what they produced.
  if (!(await hasAgentScopedAccess(c, artifact, 'write'))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  try {
    if (existsSync(artifact.storagePath)) {
      rmSync(artifact.storagePath, { recursive: true, force: true })
    }
  } catch (err) {
    logger.warn({ err, artifactId: id }, 'Failed to delete artifact file from disk')
  }

  await db.delete(artifacts).where(eq(artifacts.id, id))

  // Iron Rule 5: the row and the file on disk are both gone after this point,
  // so the filename is recorded here or nowhere.
  logAudit(c, {
    action: 'artifact.delete',
    resource: 'artifact',
    resourceId: id,
    details: { filename: artifact.filename, agentId: artifact.agentId },
  })

  return c.json({ success: true })
})

export default app
