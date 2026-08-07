import { KB_DOCUMENT_NAME_MAX, createKbDocumentInput, updateKbDocumentInput } from '@a2wave/shared'
import { and, count, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { agents, kbDocuments } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { computeContentHash, fetchFeishuDocByUrl } from '../lib/feishu-doc-fetcher.js'
import { createId } from '../lib/id.js'
import { hasRemoteKbCredentials, isRemoteKbSource } from '../lib/kb-remote-fetch.js'
import {
  getKbDocSize,
  readKbContent,
  removeKbStorage,
  validateKbFileSize,
  writeKbContent,
  writeKbMeta,
  writeKbOriginalFile,
} from '../lib/kb-storage.js'
import { hasActiveKbSyncLease } from '../lib/kb-sync-lease.js'
import { nextKbUpdatedAt, syncRemoteKbDocument } from '../lib/kb-sync-service.js'
import { fetchNotionDocByUrl, parseNotionPageUrl } from '../lib/notion-doc-fetcher.js'
import { getCurrentUserId, getOwnerFilter } from '../lib/owner-filter.js'

const app = new Hono()

/** Placeholder returned in place of secrets; also treated as "keep unchanged" on write. */
const MASKED_SECRET = '********'

/**
 * The name to store for a newly created document.
 *
 * `name` is optional on the input because the web create form no longer asks for one —
 * for a remote source the fetched title is a better name than anything the user would
 * type while pasting a batch of links, and an upload takes its filename. That makes this
 * fallback chain load-bearing in four ways: the column is NOT NULL so it must be total;
 * a Feishu "title" is just the document's first line and has no length bound at all, so
 * it must be clamped or the result could never round-trip through
 * `updateKbDocumentInput.name` and the document would be permanently unrenameable; the
 * clamp must not split a surrogate pair, or a title ending in an emoji yields a lone
 * half-character; and newlines must go, because the name is rendered into the
 * auto-generated Knowledge Base skill (see `agent-helpers.ts`) where a multi-line remote
 * title would inject arbitrary lines into the Agent's system prompt.
 */
/**
 * Squashes control/format/line-separator characters to spaces and trims; `''` means
 * "nothing usable". `Zl`/`Zp` are in the set alongside `Cc`/`Cf` because U+2028 and
 * U+2029 are line breaks that neither category covers.
 */
function collapseKbName(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
}

function resolveKbDocumentName(name: string | undefined, fallback: string): string {
  const resolved = collapseKbName(name ?? '') || collapseKbName(fallback) || 'Untitled'
  if (resolved.length <= KB_DOCUMENT_NAME_MAX) return resolved
  const clamped = resolved.slice(0, KB_DOCUMENT_NAME_MAX)
  // A trailing high surrogate means the cut landed inside an astral character.
  return /[\uD800-\uDBFF]$/.test(clamped) ? clamped.slice(0, -1) : clamped
}

/** Strip feishuAppSecret / notionToken from response data */
function sanitizeDoc<T extends Record<string, unknown>>(doc: T): T {
  if (!doc.feishuAppSecret && !doc.notionToken) {
    return doc
  }
  const out: Record<string, unknown> = { ...doc }
  if (out.feishuAppSecret) out.feishuAppSecret = MASKED_SECRET
  if (out.notionToken) out.notionToken = MASKED_SECRET
  return out as T
}

/** GET / - List KB documents (paginated, user-scoped) */
app.get('/', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  const totalResult = (
    await db.select({ count: count() }).from(kbDocuments).where(ownerFilter).limit(1)
  )[0]
  const data = await db
    .select()
    .from(kbDocuments)
    .where(ownerFilter)
    .orderBy(desc(kbDocuments.createdAt))
    .limit(limit)
    .offset(offset)
  const total = totalResult?.count ?? 0

  return c.json({
    data: data.map(sanitizeDoc),
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

/** GET /:id - Get single KB document */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  const conditions = ownerFilter ? and(eq(kbDocuments.id, id), ownerFilter) : eq(kbDocuments.id, id)
  const doc = (await db.select().from(kbDocuments).where(conditions).limit(1))[0]
  if (!doc) {
    return c.json({ error: 'KB document not found' }, 404)
  }
  return c.json({ data: sanitizeDoc(doc) })
})

/** POST / - Create KB document (Feishu URL or upload placeholder) */
app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = createKbDocumentInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const id = createId('kbd')
  const userId = getCurrentUserId(c)
  const {
    sourceType,
    name,
    description,
    feishuUrl,
    feishuAppId,
    feishuAppSecret,
    notionUrl,
    notionToken,
    autoSync,
    syncIntervalMin,
  } = parsed.data

  if (sourceType === 'feishu') {
    if (!feishuUrl || !feishuAppId || !feishuAppSecret) {
      return c.json(
        { error: 'Feishu documents require feishuUrl, feishuAppId, and feishuAppSecret' },
        400,
      )
    }

    try {
      const { title, content, contentHash, token, type } = await fetchFeishuDocByUrl(
        feishuUrl,
        feishuAppId,
        feishuAppSecret,
      )
      validateKbFileSize(Buffer.byteLength(content, 'utf-8'))
      writeKbContent(id, content)
      writeKbMeta(id, { title, fetchedAt: new Date().toISOString() })

      const newDoc = (
        await db
          .insert(kbDocuments)
          .values({
            id,
            name: resolveKbDocumentName(name, title),
            description,
            sourceType: 'feishu',
            feishuDocToken: token,
            feishuDocType: type,
            feishuUrl,
            feishuAppId,
            feishuAppSecret,
            storagePath: id,
            contentHash,
            fileSize: Buffer.byteLength(content, 'utf-8'),
            syncStatus: 'synced',
            lastSyncAt: new Date(),
            autoSync: autoSync ?? true,
            syncIntervalMin: syncIntervalMin ?? 60,
            userId,
          })
          .returning()
      )[0]

      logAudit(c, { action: 'kb_document.create', resource: 'kb_document', resourceId: id })
      return c.json({ data: sanitizeDoc(newDoc) }, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch Feishu document'
      return c.json({ error: message }, 400)
    }
  }

  if (sourceType === 'notion') {
    if (!notionUrl || !notionToken) {
      return c.json({ error: 'Notion documents require notionUrl and notionToken' }, 400)
    }

    try {
      const { title, content, contentHash, pageId } = await fetchNotionDocByUrl(
        notionUrl,
        notionToken,
      )
      validateKbFileSize(Buffer.byteLength(content, 'utf-8'))
      writeKbContent(id, content)
      writeKbMeta(id, { title, fetchedAt: new Date().toISOString() })

      const newDoc = (
        await db
          .insert(kbDocuments)
          .values({
            id,
            name: resolveKbDocumentName(name, title),
            description,
            sourceType: 'notion',
            notionPageId: pageId,
            notionUrl,
            notionToken,
            storagePath: id,
            contentHash,
            fileSize: Buffer.byteLength(content, 'utf-8'),
            syncStatus: 'synced',
            lastSyncAt: new Date(),
            autoSync: autoSync ?? true,
            syncIntervalMin: syncIntervalMin ?? 60,
            userId,
          })
          .returning()
      )[0]

      logAudit(c, { action: 'kb_document.create', resource: 'kb_document', resourceId: id })
      return c.json({ data: sanitizeDoc(newDoc) }, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch Notion document'
      return c.json({ error: message }, 400)
    }
  }

  // For upload type, create metadata-only record (file uploaded separately).
  // Unlike the remote branches there is no title to fall back on, so the name stays
  // required here. Nothing in the web app reaches this branch — the browser uses
  // POST /upload, which derives the name from the filename.
  // Tested with the same predicate the write uses, so a name made only of control
  // characters is rejected here rather than silently stored as "Untitled".
  if (!collapseKbName(name ?? '')) {
    return c.json({ error: 'Upload documents require a name' }, 400)
  }

  const newDoc = (
    await db
      .insert(kbDocuments)
      .values({
        id,
        name: resolveKbDocumentName(name, ''),
        description,
        sourceType: 'upload',
        syncStatus: 'idle',
        userId,
      })
      .returning()
  )[0]

  logAudit(c, { action: 'kb_document.create', resource: 'kb_document', resourceId: id })
  return c.json({ data: sanitizeDoc(newDoc) }, 201)
})

const ALLOWED_KB_EXTENSIONS = ['.md', '.txt']

/** POST /upload - Upload file as KB document */
app.post('/upload', async (c) => {
  try {
    const formData = await c.req.formData()
    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Please upload a file' }, 400)
    }

    const ext = file.name.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1')
    if (!ALLOWED_KB_EXTENSIONS.includes(ext)) {
      return c.json({ error: `Only ${ALLOWED_KB_EXTENSIONS.join(', ')} files are supported` }, 400)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    validateKbFileSize(buffer.length)

    const id = createId('kbd')
    const userId = getCurrentUserId(c)
    const content = buffer.toString('utf-8')
    const contentHash = computeContentHash(content)

    // Store original file and content
    writeKbOriginalFile(id, file.name, buffer)
    writeKbContent(id, content)
    writeKbMeta(id, { originalFilename: file.name, uploadedAt: new Date().toISOString() })

    const newDoc = (
      await db
        .insert(kbDocuments)
        .values({
          id,
          // Same clamp/fallback as the remote branches: multi-select upload makes this the
          // path a batch drives N times, and a 250-char filename (or a file named `.md`)
          // would otherwise store a name the edit form can never save again.
          name: resolveKbDocumentName(undefined, file.name.replace(/\.[^.]+$/, '')),
          sourceType: 'upload',
          originalFilename: file.name,
          mimeType: file.type || 'application/octet-stream',
          storagePath: id,
          contentHash,
          fileSize: buffer.length,
          syncStatus: 'synced',
          lastSyncAt: new Date(),
          userId,
        })
        .returning()
    )[0]

    logAudit(c, { action: 'kb_document.create', resource: 'kb_document', resourceId: id })
    return c.json({ data: sanitizeDoc(newDoc) }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    return c.json({ error: message }, 400)
  }
})

/** PATCH /:id - Update KB document metadata */
app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  const conditions = ownerFilter ? and(eq(kbDocuments.id, id), ownerFilter) : eq(kbDocuments.id, id)
  const existing = (await db.select().from(kbDocuments).where(conditions).limit(1))[0]
  if (!existing) {
    return c.json({ error: 'KB document not found' }, 404)
  }

  const body = await c.req.json()
  const parsed = updateKbDocumentInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  // A masked token echoed back from a sanitized GET response means "keep unchanged"
  // (mirrors the provider-secret convention); never persist the placeholder as the real token.
  if (parsed.data.notionToken === MASKED_SECRET) {
    parsed.data.notionToken = undefined
  }

  const credentialsChanged =
    (parsed.data.notionUrl !== undefined && parsed.data.notionUrl !== existing.notionUrl) ||
    (parsed.data.notionToken !== undefined && parsed.data.notionToken !== existing.notionToken)
  if (credentialsChanged && existing.sourceType !== 'notion') {
    return c.json({ error: 'Notion credentials can only be updated for Notion documents' }, 400)
  }

  const updateData: Record<string, unknown> = { ...parsed.data }
  // A rename goes through the same normalization as a create, so the "no control
  // characters in a name" invariant holds on every write path — the name is rendered
  // into the agent's auto-generated Knowledge Base skill, and a rename is the one path
  // where a user supplies it directly. Falls back to the stored name if it trims empty.
  if (parsed.data.name !== undefined) {
    updateData.name = resolveKbDocumentName(parsed.data.name, existing.name)
  }
  if (parsed.data.notionUrl) {
    try {
      updateData.notionPageId = parseNotionPageUrl(parsed.data.notionUrl).pageId
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid Notion page URL'
      return c.json({ error: message }, 400)
    }
  }
  if (credentialsChanged) {
    updateData.syncStatus = 'idle'
    updateData.lastSyncError = null
  }

  const updated = (
    await db
      .update(kbDocuments)
      .set({ ...updateData, updatedAt: nextKbUpdatedAt(existing.updatedAt) })
      .where(and(conditions, eq(kbDocuments.updatedAt, existing.updatedAt)))
      .returning()
  )[0]

  if (!updated) {
    return c.json({ error: 'KB document was modified concurrently; retry the update' }, 409)
  }

  logAudit(c, { action: 'kb_document.update', resource: 'kb_document', resourceId: id })

  return c.json({ data: sanitizeDoc(updated) })
})

/** DELETE /:id - Delete KB document */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  const conditions = ownerFilter ? and(eq(kbDocuments.id, id), ownerFilter) : eq(kbDocuments.id, id)
  const doc = (await db.select().from(kbDocuments).where(conditions).limit(1))[0]
  if (!doc) {
    return c.json({ error: 'KB document not found' }, 404)
  }

  // Clean up agent references before deleting
  const allAgents = await db
    .select({ id: agents.id, kbDocumentIds: agents.kbDocumentIds })
    .from(agents)
  for (const agent of allAgents) {
    const ids = (agent.kbDocumentIds as string[] | null) || []
    if (ids.includes(id)) {
      const updated = ids.filter((kid) => kid !== id)
      await db
        .update(agents)
        .set({ kbDocumentIds: updated, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
    }
  }

  const deleted = (await db.delete(kbDocuments).where(eq(kbDocuments.id, id)).returning())[0]
  removeKbStorage(id)

  logAudit(c, { action: 'kb_document.delete', resource: 'kb_document', resourceId: id })

  return c.json({ data: deleted ? sanitizeDoc(deleted) : null })
})

/** POST /:id/reupload - Replace uploaded file */
app.post('/:id/reupload', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  const conditions = ownerFilter ? and(eq(kbDocuments.id, id), ownerFilter) : eq(kbDocuments.id, id)
  const existing = (await db.select().from(kbDocuments).where(conditions).limit(1))[0]
  if (!existing) return c.json({ error: 'KB document not found' }, 404)
  if (existing.sourceType !== 'upload')
    return c.json({ error: 'Only upload documents can be reuploaded' }, 400)

  try {
    const formData = await c.req.formData()
    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Please upload a file' }, 400)
    }

    const ext = file.name.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1')
    if (!ALLOWED_KB_EXTENSIONS.includes(ext)) {
      return c.json({ error: `Only ${ALLOWED_KB_EXTENSIONS.join(', ')} files are supported` }, 400)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    validateKbFileSize(buffer.length)

    const content = buffer.toString('utf-8')
    const contentHash = computeContentHash(content)

    writeKbOriginalFile(id, file.name, buffer)
    writeKbContent(id, content)
    writeKbMeta(id, { originalFilename: file.name, uploadedAt: new Date().toISOString() })

    const updated = (
      await db
        .update(kbDocuments)
        .set({
          originalFilename: file.name,
          mimeType: file.type || 'application/octet-stream',
          storagePath: id,
          contentHash,
          fileSize: buffer.length,
          syncStatus: 'synced',
          lastSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(kbDocuments.id, id))
        .returning()
    )[0]

    logAudit(c, { action: 'kb_document.reupload', resource: 'kb_document', resourceId: id })
    return c.json({ data: sanitizeDoc(updated) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reupload failed'
    return c.json({ error: message }, 400)
  }
})

/** POST /:id/sync - Manual sync for remote (Feishu/Notion) documents */
app.post('/:id/sync', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  const conditions = ownerFilter ? and(eq(kbDocuments.id, id), ownerFilter) : eq(kbDocuments.id, id)
  const doc = (await db.select().from(kbDocuments).where(conditions).limit(1))[0]
  if (!doc) return c.json({ error: 'KB document not found' }, 404)
  if (!isRemoteKbSource(doc.sourceType))
    return c.json({ error: 'Only Feishu/Notion documents can be synced' }, 400)
  if (!hasRemoteKbCredentials(doc)) {
    return c.json({ error: 'Missing sync credentials' }, 400)
  }
  if (hasActiveKbSyncLease(doc)) {
    return c.json({ data: sanitizeDoc(doc) })
  }

  try {
    const result = await syncRemoteKbDocument(doc)
    if (result.status === 'not-claimed') {
      return c.json({ data: sanitizeDoc(doc) })
    }
    if (result.status === 'superseded') {
      return c.json({ error: 'Sync was superseded by a newer document update' }, 409)
    }
    return c.json({ data: sanitizeDoc(result.document) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed'
    return c.json({ error: message }, 500)
  }
})

/** GET /:id/content - Read cached content */
app.get('/:id/content', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  const conditions = ownerFilter ? and(eq(kbDocuments.id, id), ownerFilter) : eq(kbDocuments.id, id)
  const doc = (await db.select().from(kbDocuments).where(conditions).limit(1))[0]
  if (!doc) return c.json({ error: 'KB document not found' }, 404)

  const content = readKbContent(id)
  if (content === null) return c.json({ error: 'No content cached' }, 404)
  return c.text(content)
})

export default app
