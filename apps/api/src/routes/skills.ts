import {
  type RemoteSkillUpdateCheck,
  type SkillVisibility,
  createSkillInput,
  inspectRemoteSkillsInput,
  installRemoteSkillsInput,
  skillVisibilityEnum,
  updateRemoteSkillInput,
  updateSkillInput,
} from '@a2wave/shared'
import { and, count, desc, eq } from 'drizzle-orm'
import matter from 'gray-matter'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { skillGroups, skills, users } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { logAudit } from '../lib/audit.js'
import { createId } from '../lib/id.js'
import { withKeyedLock } from '../lib/keyed-mutex.js'
import { getCurrentUserId, getOwnerFilter } from '../lib/owner-filter.js'
import {
  RemoteSkillError,
  type RemoteSkillFile,
  type RemoteSkillPackage,
  buildRemoteSkillSource,
  calculateRemoteSkillDigest,
  compareRemoteSkillFiles,
  loadRemoteSkillBundle,
  mergeRemoteSkillFiles,
} from '../lib/remote-skill-source.js'
import { getSkillVisibilityFilter } from '../lib/skill-access.js'
import {
  type UploadedFolderFile,
  extractZipToSkill,
  getSkillStoragePath,
  listSkillFiles,
  makeTempSkillId,
  parseSkillMd,
  readAllSkillFiles,
  readSkillFile,
  removeSkillStorage,
  replaceSkillFilesWithRollback,
  replaceSkillFolder,
  validateSingleFileSize,
  writeSkillFile,
  writeSkillFolder,
  writeSkillMd,
} from '../lib/skill-storage.js'
import { isAdmin } from '../middleware/auth-middleware.js'

const app = new Hono()

function remoteSkillErrorResponse(c: Parameters<typeof getOwnerFilter>[0], error: unknown) {
  if (!(error instanceof RemoteSkillError)) {
    const message = error instanceof Error ? error.message : 'Remote Skill operation failed'
    return c.json({ error: message }, 500)
  }
  const status =
    error.code === 'not_found'
      ? 404
      : error.code === 'limit_exceeded'
        ? 413
        : error.code === 'upstream_error'
          ? 502
          : 400
  return c.json({ error: error.message, code: error.code }, status)
}

/** 校验 groupId 是否对调用方可见（admin 看全部，普通用户只看自己的）。null/undefined = 未分组，直接放行。 */
async function validateSkillGroupVisibility(
  c: Parameters<typeof getOwnerFilter>[0],
  groupId: string | null | undefined,
): Promise<string | null> {
  if (!groupId) return null
  const ownerFilter = getOwnerFilter(c, skillGroups.userId)
  const condition = ownerFilter
    ? and(eq(skillGroups.id, groupId), ownerFilter)
    : eq(skillGroups.id, groupId)
  const row = (
    await db.select({ id: skillGroups.id }).from(skillGroups).where(condition).limit(1)
  )[0]
  if (!row) return `Skill group not found: ${groupId}`
  return null
}

async function getVisibleSkill(c: Parameters<typeof getOwnerFilter>[0], id: string) {
  const visibilityFilter = getSkillVisibilityFilter(c, skills.userId, skills.visibility)
  const conditions = visibilityFilter ? and(eq(skills.id, id), visibilityFilter) : eq(skills.id, id)
  return (await db.select().from(skills).where(conditions).limit(1))[0]
}

/** Mutations stay owner-only for regular users even when a Skill is shared. */
async function getWritableSkill(c: Parameters<typeof getOwnerFilter>[0], id: string) {
  const ownerFilter = getOwnerFilter(c, skills.userId)
  const conditions = ownerFilter ? and(eq(skills.id, id), ownerFilter) : eq(skills.id, id)
  return (await db.select().from(skills).where(conditions).limit(1))[0]
}

function rejectUnauthorizedSharedVisibility(
  c: Parameters<typeof getOwnerFilter>[0],
  visibility: SkillVisibility | undefined,
  existingVisibility?: SkillVisibility,
) {
  if (visibility === 'all-users' && existingVisibility !== 'all-users' && !isAdmin(c)) {
    return c.json({ error: 'Only administrators can make a Skill available to all users' }, 403)
  }
  return null
}

function rejectSystemSkillVisibilityDowngrade(
  c: Parameters<typeof getOwnerFilter>[0],
  visibility: SkillVisibility | undefined,
  existing: Pick<typeof skills.$inferSelect, 'userId' | 'visibility'>,
) {
  if (visibility === 'private' && existing.userId === null && existing.visibility === 'all-users') {
    return c.json({ error: 'Platform built-in Skills must remain available to all users' }, 400)
  }
  return null
}

function findRemotePackage(packages: RemoteSkillPackage[], path: string): RemoteSkillPackage {
  const candidate = packages.find((item) => item.path === path)
  if (!candidate) {
    throw new RemoteSkillError('not_found', `Remote Skill no longer exists at ${path}`)
  }
  return candidate
}

async function applyDatabaseMetadataToLocalFiles(
  files: RemoteSkillFile[],
  skill: NonNullable<Awaited<ReturnType<typeof getVisibleSkill>>>,
): Promise<RemoteSkillFile[]> {
  const skillMd = files.find((file) => file.path === 'SKILL.md')
  if (!skillMd) return files

  const stored = parseSkillMd(skillMd.content.toString('utf-8'))
  const currentDescription = skill.description ?? null
  const currentContent = skill.content ?? ''
  if (
    stored.name === skill.name &&
    stored.description === currentDescription &&
    stored.body === currentContent
  ) {
    return files
  }

  const document = matter(skillMd.content.toString('utf-8'))
  const { description: _storedDescription, ...storedMetadata } = document.data
  const metadata: Record<string, unknown> = {
    ...storedMetadata,
    name: skill.name,
    ...(currentDescription === null ? {} : { description: currentDescription }),
  }
  const content = Buffer.from(matter.stringify(currentContent, metadata))
  return files.map((file) => (file.path === 'SKILL.md' ? { ...file, content } : file))
}

async function inspectInstalledRemoteSkill(
  skill: NonNullable<Awaited<ReturnType<typeof getVisibleSkill>>>,
) {
  const source = skill.remoteSource
  if (!source) {
    throw new RemoteSkillError('invalid_url', 'Skill was not installed from a remote source')
  }
  if (!skill.storagePath) {
    throw new RemoteSkillError('not_found', 'Remote Skill has no local file storage')
  }

  const latestBundle = await loadRemoteSkillBundle(source.inputUrl, undefined, source.requestedRef)
  const latestPackage = findRemotePackage(latestBundle.packages, source.path)
  const baseBundle =
    latestBundle.inspection.revision === source.revision
      ? latestBundle
      : await loadRemoteSkillBundle(source.inputUrl, source.revision, source.requestedRef)
  const basePackage = findRemotePackage(baseBundle.packages, source.path)
  const localFiles = applyDatabaseMetadataToLocalFiles(readAllSkillFiles(skill.id), skill)
  const localDigest = calculateRemoteSkillDigest(await localFiles)
  const files = compareRemoteSkillFiles(basePackage.files, await localFiles, latestPackage.files)
  const conflicts = files.filter((file) => file.conflict).map((file) => file.path)
  const check: RemoteSkillUpdateCheck = {
    skillId: skill.id,
    source,
    installedRevision: source.revision,
    latestRevision: latestBundle.inspection.revision,
    installedDigest: source.digest,
    localDigest,
    latestDigest: latestPackage.digest,
    updateAvailable:
      latestBundle.inspection.revision !== source.revision ||
      latestPackage.digest !== source.digest,
    sourceDirty: skill.sourceDirty || localDigest !== source.digest,
    files,
    conflicts,
  }
  return { check, basePackage, latestBundle, latestPackage, localFiles }
}

async function insertUploadedSkill(params: {
  id: string
  name: string
  description: string | null
  content: string
  userId: string | null
  groupId?: string | null
  visibility: SkillVisibility
}) {
  const { id, name, description, content, userId, groupId, visibility } = params
  try {
    return (
      await db
        .insert(skills)
        .values({
          id,
          name,
          description,
          content,
          storagePath: id,
          userId,
          groupId: groupId ?? null,
          visibility,
        })
        .returning()
    )[0]
  } catch (err) {
    removeSkillStorage(id)
    throw err
  }
}

/** GET / - 列出所有 Skills */
app.get('/', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(500, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const visibilityFilter = getSkillVisibilityFilter(c, skills.userId, skills.visibility)
  const totalResult = (
    await db.select({ count: count() }).from(skills).where(visibilityFilter).limit(1)
  )[0]
  const rows = await db
    .select({ skill: skills, displayName: users.displayName, username: users.username })
    .from(skills)
    .leftJoin(users, eq(skills.userId, users.id))
    .where(visibilityFilter)
    .orderBy(desc(skills.createdAt))
    .limit(limit)
    .offset(offset)
  // 展开 join：把提交者展示名（display_name 优先，回退 username）拍平到 authorName
  const data = rows.map(({ skill, displayName, username }) => ({
    ...skill,
    authorName: displayName ?? username ?? null,
  }))
  const total = totalResult?.count ?? 0

  return c.json({
    data,
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

/** GET /:id/files - 列出 skill 存储目录下的文件树 */
app.get('/:id/files', async (c) => {
  const { id } = c.req.param()
  const skill = await getVisibleSkill(c, id)
  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404)
  }
  if (!skill.storagePath) {
    return c.json({ data: { path: '', entries: [] } })
  }
  const entries = listSkillFiles(id)
  return c.json({ data: { path: '', entries } })
})

/** GET /:id/files/:filePath{.+} - 返回指定文件内容（filePath 可含 /） */
app.get('/:id/files/:filePath{.+\\.*}', async (c) => {
  const { id, filePath } = c.req.param()
  const skill = await getVisibleSkill(c, id)
  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404)
  }
  if (!skill.storagePath) {
    return c.json({ error: 'Skill has no file storage' }, 404)
  }
  const path = filePath ?? ''
  if (!path) {
    return c.json({ error: 'File path required' }, 400)
  }
  try {
    const buf = readSkillFile(id, path)
    const ext = filePath.split('.').pop() ?? ''
    const textExtensions = [
      'md',
      'txt',
      'json',
      'js',
      'ts',
      'py',
      'sh',
      'yaml',
      'yml',
      'css',
      'html',
    ]
    if (textExtensions.includes(ext)) {
      return c.text(buf.toString('utf-8'))
    }
    // 零拷贝 view：避免大文件拷贝；as ArrayBuffer 修正 BodyInit 的类型窄化
    const body = new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength)
    return new Response(body, {
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'File not found'
    return c.json({ error: message }, 404)
  }
})

/** POST /:id/files/upload - 为已有 Skill 上传一个或多个附加文件（?replace=true 先清空再上传） */
app.post('/:id/files/upload', async (c) => {
  const { id } = c.req.param()
  const replace = c.req.query('replace') === 'true'
  const skill = await getWritableSkill(c, id)

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404)
  }

  try {
    const formData = await c.req.formData()
    // FormData.getAll returns (string | File)[] but the File shape differs
    // between @types/node (buffer.File) and undici (web File). We only depend
    // on the web-File methods (arrayBuffer, name), so drop the string entries
    // and cast to the minimal duck-typed shape we use below.
    type WebFile = { arrayBuffer(): Promise<ArrayBuffer>; name: string }
    const files = formData
      .getAll('files')
      .filter((entry) => typeof entry !== 'string') as unknown as WebFile[]
    const paths = formData.getAll('paths').map((entry) => (typeof entry === 'string' ? entry : ''))

    if (files.length === 0) {
      return c.json({ error: 'Upload at least one file (files)' }, 400)
    }

    // 与 /:id/reupload 共用同一把 per-skill 锁，使 replace swap 与 reupload 的
    // storage 替换互斥，避免并发下互删目录 / DB-磁盘错位。
    return await withKeyedLock(`skill-storage:${id}`, async () => {
      if (replace && skill.storagePath) {
        // Write to temp location first, then swap to avoid data loss on partial failure.
        // 随机后缀（makeTempSkillId）避免同毫秒并发请求撞同一临时目录。
        const tempId = makeTempSkillId(id)
        for (const [index, file] of files.entries()) {
          const content = Buffer.from(await file.arrayBuffer())
          validateSingleFileSize(content.length)
          const filePath = paths[index]?.trim() || file.name
          writeSkillFile(tempId, filePath, content)
        }
        removeSkillStorage(id)
        const { renameSync } = await import('node:fs')
        renameSync(getSkillStoragePath(tempId), getSkillStoragePath(id))
      } else {
        for (const [index, file] of files.entries()) {
          const content = Buffer.from(await file.arrayBuffer())
          validateSingleFileSize(content.length)
          const filePath = paths[index]?.trim() || file.name
          writeSkillFile(id, filePath, content)
        }
      }

      if (!skill.storagePath) {
        await db
          .update(skills)
          .set({
            storagePath: id,
            sourceDirty: skill.remoteSource ? true : skill.sourceDirty,
            updatedAt: new Date(),
          })
          .where(eq(skills.id, id))
      } else if (skill.remoteSource) {
        await db
          .update(skills)
          .set({ sourceDirty: true, updatedAt: new Date() })
          .where(eq(skills.id, id))
      }

      logAudit(c, { action: 'skill.update', resource: 'skill', resourceId: id })

      return c.json({ data: { uploaded: files.length } }, 201)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    return c.json({ error: message }, 400)
  }
})

/** GET /:id - 获取单个 Skill */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const skill = await getVisibleSkill(c, id)
  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404)
  }
  return c.json({ data: skill })
})

/** POST /upload - 上传 SKILL.md / ZIP 包，或浏览器选中的整个 skill 文件夹（files[] + paths[]） */
app.post('/upload', async (c) => {
  try {
    const formData = await c.req.formData()

    const parsedVisibility = skillVisibilityEnum.safeParse(formData.get('visibility') ?? 'private')
    if (!parsedVisibility.success) {
      return c.json({ error: 'visibility must be private or all-users' }, 400)
    }
    const visibilityError = rejectUnauthorizedSharedVisibility(c, parsedVisibility.data)
    if (visibilityError) return visibilityError

    // 可选归属分组：CLI `skills create --file X --group G` 会带上 groupId。
    // 未分组时 groupId 为 undefined；分组时校验其对调用方可见，否则 400（防越权挂到别人的组）。
    const groupIdRaw = formData.get('groupId')
    const groupId = typeof groupIdRaw === 'string' && groupIdRaw ? groupIdRaw : undefined
    const groupError = await validateSkillGroupVisibility(c, groupId)
    if (groupError) return c.json({ error: groupError }, 400)

    // 文件夹模式：files[] + paths[] 同时提供
    const folderFiles = formData
      .getAll('files')
      .filter((entry) => typeof entry !== 'string') as unknown as UploadedFolderFile[]
    if (folderFiles.length > 0) {
      const folderPaths = formData.getAll('paths').map((p) => (typeof p === 'string' ? p : ''))
      const id = createId('skl')
      const userId = getCurrentUserId(c)

      const {
        name: skillName,
        description,
        body,
      } = await writeSkillFolder(id, folderFiles, folderPaths)

      const newSkill = await insertUploadedSkill({
        id,
        name: skillName,
        description,
        content: body,
        userId,
        groupId,
        visibility: parsedVisibility.data,
      })

      logAudit(c, { action: 'skill.create', resource: 'skill', resourceId: id })
      return c.json({ data: newSkill }, 201)
    }

    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Upload a file field (.md or .zip)' }, 400)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    validateSingleFileSize(buffer.length)

    const name = file.name.toLowerCase()
    const id = createId('skl')
    const userId = getCurrentUserId(c)

    if (name.endsWith('.md')) {
      const content = buffer.toString('utf-8')
      const { name: skillName, description, body } = parseSkillMd(content)
      writeSkillMd(id, content)
      const newSkill = await insertUploadedSkill({
        id,
        name: skillName,
        description,
        content: body,
        userId,
        groupId,
        visibility: parsedVisibility.data,
      })

      logAudit(c, { action: 'skill.create', resource: 'skill', resourceId: id })

      return c.json({ data: newSkill }, 201)
    }

    if (name.endsWith('.zip')) {
      const { name: skillName, description, body } = extractZipToSkill(buffer, id)
      const newSkill = await insertUploadedSkill({
        id,
        name: skillName,
        description,
        content: body,
        userId,
        groupId,
        visibility: parsedVisibility.data,
      })

      logAudit(c, { action: 'skill.create', resource: 'skill', resourceId: id })

      return c.json({ data: newSkill }, 201)
    }

    return c.json({ error: 'Only .md or .zip files are supported' }, 400)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    return c.json({ error: message }, 400)
  }
})

/** POST /:id/reupload - 重新上传 .md 或 .zip 完整替换已有 Skill（名称、描述、内容、文件） */
app.post('/:id/reupload', async (c) => {
  const { id } = c.req.param()
  const existing = await getWritableSkill(c, id)
  if (!existing) {
    return c.json({ error: 'Skill not found' }, 404)
  }

  try {
    const formData = await c.req.formData()

    // 同一 skillId 的整段「storage 替换 + DB 更新」串行化：避免两个并发 reupload
    // 的磁盘 swap 与 db.update 顺序错位，出现「磁盘是 B、DB 却是 A」的不一致。
    return await withKeyedLock(`skill-storage:${id}`, async () => {
      // 文件夹模式：files[] + paths[] 同时提供，与 /upload 对称
      const folderFiles = formData
        .getAll('files')
        .filter((entry) => typeof entry !== 'string') as unknown as UploadedFolderFile[]
      if (folderFiles.length > 0) {
        const folderPaths = formData.getAll('paths').map((p) => (typeof p === 'string' ? p : ''))
        // temp-swap：先写临时目录并完成全部校验，成功后才替换旧内容。校验失败
        // （无 SKILL.md / 计数不符 / 超限）时旧 skill 保持不变，不会丢数据。
        const {
          name: skillName,
          description,
          body,
        } = await replaceSkillFolder(id, folderFiles, folderPaths)
        const updated = (
          await db
            .update(skills)
            .set({
              name: skillName,
              description,
              content: body,
              storagePath: id,
              sourceDirty: existing.remoteSource ? true : existing.sourceDirty,
              updatedAt: new Date(),
            })
            .where(eq(skills.id, id))
            .returning()
        )[0]

        logAudit(c, { action: 'skill.update', resource: 'skill', resourceId: id })
        return c.json({ data: updated })
      }

      const file = formData.get('file')
      if (!file || !(file instanceof File)) {
        return c.json(
          { error: 'Upload either a file field (.md / .zip) or files[] + paths[] (a folder)' },
          400,
        )
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      validateSingleFileSize(buffer.length)
      const name = file.name.toLowerCase()

      // Clear existing storage
      if (existing.storagePath) {
        removeSkillStorage(id)
      }

      if (name.endsWith('.md')) {
        const content = buffer.toString('utf-8')
        const { name: skillName, description, body } = parseSkillMd(content)
        writeSkillMd(id, content)
        const updated = (
          await db
            .update(skills)
            .set({
              name: skillName,
              description,
              content: body,
              storagePath: id,
              sourceDirty: existing.remoteSource ? true : existing.sourceDirty,
              updatedAt: new Date(),
            })
            .where(eq(skills.id, id))
            .returning()
        )[0]

        logAudit(c, { action: 'skill.update', resource: 'skill', resourceId: id })
        return c.json({ data: updated })
      }

      if (name.endsWith('.zip')) {
        const { name: skillName, description, body } = extractZipToSkill(buffer, id)
        const updated = (
          await db
            .update(skills)
            .set({
              name: skillName,
              description,
              content: body,
              storagePath: id,
              sourceDirty: existing.remoteSource ? true : existing.sourceDirty,
              updatedAt: new Date(),
            })
            .where(eq(skills.id, id))
            .returning()
        )[0]

        logAudit(c, { action: 'skill.update', resource: 'skill', resourceId: id })
        return c.json({ data: updated })
      }

      return c.json({ error: 'Only .md or .zip files are supported' }, 400)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    return c.json({ error: message }, 400)
  }
})

/** POST /remote/inspect - Resolve a public skills.sh/GitHub URL and preview installable Skills. */
app.post('/remote/inspect', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = inspectRemoteSkillsInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  try {
    const bundle = await loadRemoteSkillBundle(parsed.data.url)
    return c.json({ data: bundle.inspection })
  } catch (error) {
    return remoteSkillErrorResponse(c, error)
  }
})

/** POST /remote/install - Install selected candidates from the inspected immutable commit. */
app.post('/remote/install', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = installRemoteSkillsInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const groupError = await validateSkillGroupVisibility(c, parsed.data.groupId)
  if (groupError) return c.json({ error: groupError }, 400)

  const visibilityError = rejectUnauthorizedSharedVisibility(c, parsed.data.visibility)
  if (visibilityError) return visibilityError

  const userId = getCurrentUserId(c)
  const lockKey = [
    'remote-skill-install',
    userId ?? 'anonymous',
    parsed.data.revision,
    ...parsed.data.selections.map((item) => item.path).sort(),
  ].join(':')

  return await withKeyedLock(lockKey, async () => {
    const installedIds: string[] = []
    let databaseCommitted = false
    try {
      const bundle = await loadRemoteSkillBundle(
        parsed.data.url,
        parsed.data.revision,
        parsed.data.requestedRef,
      )

      const packageByPath = new Map(bundle.packages.map((candidate) => [candidate.path, candidate]))
      const seenPaths = new Set<string>()
      const selected = parsed.data.selections.map((selection) => {
        if (seenPaths.has(selection.path)) {
          throw new RemoteSkillError('invalid_url', `Duplicate Skill selection: ${selection.path}`)
        }
        seenPaths.add(selection.path)
        const candidate = packageByPath.get(selection.path)
        if (!candidate) {
          throw new RemoteSkillError(
            'not_found',
            `Selected Skill no longer exists at ${selection.path}`,
          )
        }
        if (candidate.digest !== selection.digest) {
          throw new RemoteSkillError(
            'invalid_url',
            `Selected Skill digest does not match the inspected snapshot: ${selection.path}`,
          )
        }
        return candidate
      })

      const rows = selected.map((candidate) => {
        const id = createId('skl')
        installedIds.push(id)
        for (const file of candidate.files) {
          writeSkillFile(id, file.path, file.content)
        }
        return {
          id,
          name: candidate.name,
          description: candidate.description,
          content: candidate.content,
          storagePath: id,
          userId,
          groupId: parsed.data.groupId ?? null,
          visibility: parsed.data.visibility,
          remoteSource: buildRemoteSkillSource(bundle.inspection, candidate),
          sourceDirty: false,
        }
      })

      const installed = await withTransaction(async (tx) => {
        const created = await Promise.all(
          rows.map(async (row) => (await tx.insert(skills).values(row).returning())[0]),
        )
        for (const skill of created) {
          if (!skill) continue
          logAudit(
            c,
            {
              action: 'skill.remote_install',
              resource: 'skill',
              resourceId: skill.id,
              details: { source: skill.remoteSource },
            },
            tx,
          )
        }
        return created
      })
      databaseCommitted = true
      return c.json({ data: installed }, 201)
    } catch (error) {
      if (!databaseCommitted) {
        for (const id of installedIds) removeSkillStorage(id)
      }
      return remoteSkillErrorResponse(c, error)
    }
  })
})

/** POST /:id/remote/check - Compare the installed snapshot, local files, and latest ref. */
app.post('/:id/remote/check', async (c) => {
  const { id } = c.req.param()
  const skill = await getWritableSkill(c, id)
  if (!skill) return c.json({ error: 'Skill not found' }, 404)

  try {
    return await withKeyedLock(`skill-storage:${id}`, async () => {
      const current = await getWritableSkill(c, id)
      if (!current) return c.json({ error: 'Skill not found' }, 404)
      const { check } = await inspectInstalledRemoteSkill(current)
      logAudit(c, {
        action: 'skill.remote_check',
        resource: 'skill',
        resourceId: id,
        details: {
          installedRevision: check.installedRevision,
          latestRevision: check.latestRevision,
          updateAvailable: check.updateAvailable,
          conflictCount: check.conflicts.length,
        },
      })
      return c.json({ data: check })
    })
  } catch (error) {
    return remoteSkillErrorResponse(c, error)
  }
})

/** POST /:id/remote/update - Apply an inspected remote revision with an explicit conflict policy. */
app.post('/:id/remote/update', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json().catch(() => null)
  const parsed = updateRemoteSkillInput.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  if (!(await getWritableSkill(c, id))) return c.json({ error: 'Skill not found' }, 404)

  try {
    return await withKeyedLock(`skill-storage:${id}`, async () => {
      const current = await getWritableSkill(c, id)
      if (!current) return c.json({ error: 'Skill not found' }, 404)
      const { check, basePackage, latestBundle, latestPackage, localFiles } =
        await inspectInstalledRemoteSkill(current)
      if (
        check.latestRevision !== parsed.data.revision ||
        check.latestDigest !== parsed.data.digest
      ) {
        return c.json(
          {
            error: 'Remote Skill changed after inspection; check for updates again',
            code: 'remote_changed',
            data: check,
          },
          409,
        )
      }
      if (check.conflicts.length > 0 && parsed.data.strategy === 'abort') {
        return c.json(
          {
            error: 'Remote Skill update conflicts with local changes',
            code: 'remote_conflict',
            data: check,
          },
          409,
        )
      }

      const merged = mergeRemoteSkillFiles(
        basePackage.files,
        await localFiles,
        latestPackage.files,
        parsed.data.strategy,
      )
      const skillMd = merged.files.find((file) => file.path === 'SKILL.md')
      if (!skillMd) {
        throw new RemoteSkillError('invalid_url', 'Updated Skill package has no SKILL.md')
      }
      const metadata = parseSkillMd(skillMd.content.toString('utf-8'))
      const swap = replaceSkillFilesWithRollback(id, merged.files)

      try {
        const updated = await withTransaction(async (tx) => {
          const row = (
            await tx
              .update(skills)
              .set({
                name: metadata.name,
                description: metadata.description,
                content: metadata.body,
                storagePath: id,
                remoteSource: buildRemoteSkillSource(latestBundle.inspection, latestPackage),
                sourceDirty: merged.preservedLocalChanges,
                updatedAt: new Date(),
              })
              .where(eq(skills.id, id))
              .returning()
          )[0]
          logAudit(
            c,
            {
              action: 'skill.remote_update',
              resource: 'skill',
              resourceId: id,
              details: {
                fromRevision: check.installedRevision,
                toRevision: check.latestRevision,
                strategy: parsed.data.strategy,
                preservedLocalChanges: merged.preservedLocalChanges,
                conflictCount: check.conflicts.length,
              },
            },
            tx,
          )
          return row
        })
        swap.commit()
        return c.json({
          data: {
            skill: updated,
            strategy: parsed.data.strategy,
            preservedLocalChanges: merged.preservedLocalChanges,
          },
        })
      } catch (error) {
        swap.rollback()
        throw error
      }
    })
  } catch (error) {
    return remoteSkillErrorResponse(c, error)
  }
})

/** POST / - 创建 Skill */
app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = createSkillInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const groupError = await validateSkillGroupVisibility(c, parsed.data.groupId)
  if (groupError) return c.json({ error: groupError }, 400)

  const visibilityError = rejectUnauthorizedSharedVisibility(c, parsed.data.visibility)
  if (visibilityError) return visibilityError

  const id = createId('skl')
  const userId = getCurrentUserId(c)
  const newSkill = (
    await db
      .insert(skills)
      .values({ id, ...parsed.data, userId })
      .returning()
  )[0]

  logAudit(c, { action: 'skill.create', resource: 'skill', resourceId: id })

  return c.json({ data: newSkill }, 201)
})

/** PATCH /:id - 更新 Skill */
app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const existing = await getWritableSkill(c, id)
  if (!existing) {
    return c.json({ error: 'Skill not found' }, 404)
  }

  const body = await c.req.json()
  const parsed = updateSkillInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  if (parsed.data.groupId !== undefined) {
    const groupError = await validateSkillGroupVisibility(c, parsed.data.groupId)
    if (groupError) return c.json({ error: groupError }, 400)
  }

  const visibilityError = rejectUnauthorizedSharedVisibility(
    c,
    parsed.data.visibility,
    existing.visibility,
  )
  if (visibilityError) return visibilityError

  const systemVisibilityError = rejectSystemSkillVisibilityDowngrade(
    c,
    parsed.data.visibility,
    existing,
  )
  if (systemVisibilityError) return systemVisibilityError

  // A regular owner may preserve an existing shared scope while editing, but
  // may not restore it after an administrator revokes it. Keep that decision in
  // the UPDATE predicate so a concurrent revoke wins atomically.
  const preservesSharedVisibility = !isAdmin(c) && parsed.data.visibility === 'all-users'
  const updateCondition = preservesSharedVisibility
    ? and(
        eq(skills.id, id),
        eq(skills.userId, getCurrentUserId(c)),
        eq(skills.visibility, 'all-users'),
      )
    : eq(skills.id, id)

  const updated = (
    await db
      .update(skills)
      .set({
        ...parsed.data,
        sourceDirty:
          existing.remoteSource &&
          (parsed.data.name !== undefined ||
            parsed.data.description !== undefined ||
            parsed.data.content !== undefined)
            ? true
            : existing.sourceDirty,
        updatedAt: new Date(),
      })
      .where(updateCondition)
      .returning()
  )[0]

  if (preservesSharedVisibility && !updated) {
    return c.json({ error: 'Skill visibility changed while saving; reload and try again' }, 409)
  }

  logAudit(c, { action: 'skill.update', resource: 'skill', resourceId: id })

  return c.json({ data: updated })
})

/** DELETE /:id - 删除 Skill */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const skill = await getWritableSkill(c, id)
  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404)
  }

  const deleted = (await db.delete(skills).where(eq(skills.id, id)).returning())[0]
  if (skill.storagePath) {
    removeSkillStorage(id)
  }

  logAudit(c, { action: 'skill.delete', resource: 'skill', resourceId: id })

  return c.json({ data: deleted })
})

export default app
