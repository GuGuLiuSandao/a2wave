/**
 * Covers the file-storage related endpoints on /skills, which aren't reached
 * by skills.test.ts.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbInsert = vi.fn()
const dbUpdate = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: (...a: unknown[]) => dbInsert(...a),
    update: (...a: unknown[]) => dbUpdate(...a),
  },
  // `db/transaction.js` reads these at module load to pick a backend, and its
  // SQLite branch drives BEGIN/COMMIT on the raw handle. Without a stand-in
  // handle every transactional route throws before its own mocks are consulted.
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  skills: {
    id: 'skills.id',
    userId: 'skills.userId',
    visibility: 'skills.visibility',
    createdAt: 'skills.createdAt',
  },
  skillGroups: { id: 'skillGroups.id', userId: 'skillGroups.userId' },
}))

const logAuditMock = vi.fn()
vi.mock('../../lib/audit.js', () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn((p?: string) => `${p}_test`),
}))

vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn(() => undefined),
  getCurrentUserId: vi.fn(() => 'usr_test'),
}))

const extractZipToSkillMock = vi.fn()
const getSkillStoragePathMock = vi.fn()
const listSkillFilesMock = vi.fn()
const parseSkillMdMock = vi.fn()
const readSkillFileMock = vi.fn()
const removeSkillStorageMock = vi.fn()
const replaceSkillFolderMock = vi.fn()
const validateSingleFileSizeMock = vi.fn()
const writeSkillFileMock = vi.fn()
const writeSkillFolderMock = vi.fn()
const writeSkillMdMock = vi.fn()
vi.mock('../../lib/skill-storage.js', () => ({
  extractZipToSkill: (...a: unknown[]) => extractZipToSkillMock(...a),
  getSkillStoragePath: (...a: unknown[]) => getSkillStoragePathMock(...a),
  listSkillFiles: (...a: unknown[]) => listSkillFilesMock(...a),
  parseSkillMd: (...a: unknown[]) => parseSkillMdMock(...a),
  readSkillFile: (...a: unknown[]) => readSkillFileMock(...a),
  removeSkillStorage: (...a: unknown[]) => removeSkillStorageMock(...a),
  replaceSkillFolder: (...a: unknown[]) => replaceSkillFolderMock(...a),
  validateSingleFileSize: (...a: unknown[]) => validateSingleFileSizeMock(...a),
  writeSkillFile: (...a: unknown[]) => writeSkillFileMock(...a),
  writeSkillFolder: (...a: unknown[]) => writeSkillFolderMock(...a),
  writeSkillMd: (...a: unknown[]) => writeSkillMdMock(...a),
}))

const sharedMock = vi.hoisted(() => ({
  createSkillInput: { safeParse: () => ({ success: true, data: {} }) },
  updateSkillInput: { safeParse: () => ({ success: true, data: {} }) },
  skillVisibilityEnum: {
    safeParse: (value: unknown) =>
      value === 'private' || value === 'all-users'
        ? { success: true, data: value }
        : { success: false },
  },
}))
vi.mock('@a2wave/shared', () => sharedMock)

import skillsApp from '../skills.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'set',
    'values',
    'returning',
    'orderBy',
    'limit',
    'offset',
    'groupBy',
    'having',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()
  c.run = vi.fn()

  // Awaiting the chain yields what `.get()`/`.all()` was configured to return,
  // as an array — production code destructures `[row]` from `.limit(1)` now.
  // The original mock fns stay reachable, so existing assertions are unaffected.
  let __settled: Promise<unknown[]> | undefined
  const __rows = (): unknown[] => {
    // `get` before `all`: mocks often define both, with `all` a placeholder.
    const get = c.get as undefined | (() => unknown)
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = c.all as undefined | (() => unknown)
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = c.run as undefined | (() => unknown)
    if (run) {
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const __chain = Object.assign(
    {
      // Lazy: resolving eagerly would consume a queued `get` per intermediate
      // node while the chain is still being built.
      // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
      then: (f?: (v: unknown[]) => unknown, r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.then(f, r)
      },
      catch: (r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.catch(r)
      },
    },
    c,
  )
  for (const k of Object.keys(c)) {
    const fn = c[k] as unknown
    if (typeof fn === 'function' && !['get', 'all', 'run'].includes(k)) {
      ;(__chain as Record<string, unknown>)[k] = fn
    }
  }
  return __chain as unknown as typeof c
}

function queueSelects(...returns: Array<{ get?: unknown; all?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    if ('all' in cfg) c.all.mockReturnValue(cfg.all)
    return c
  })
}

beforeEach(() => {
  dbSelect.mockReset()
  dbInsert.mockReset().mockImplementation(() => {
    const c = makeChain()
    c.get.mockReturnValue({ id: 'skl_test' })
    return c
  })
  dbUpdate.mockReset().mockImplementation(() => makeChain())
  logAuditMock.mockReset()
  extractZipToSkillMock.mockReset()
  getSkillStoragePathMock.mockReset()
  listSkillFilesMock.mockReset()
  parseSkillMdMock.mockReset()
  readSkillFileMock.mockReset()
  removeSkillStorageMock.mockReset()
  replaceSkillFolderMock.mockReset()
  validateSingleFileSizeMock.mockReset()
  writeSkillFileMock.mockReset()
  writeSkillFolderMock.mockReset()
  writeSkillMdMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp(role: 'admin' | 'user' = 'user') {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userRole' as never, role as never)
    c.set('userId' as never, 'usr_test' as never)
    await next()
  })
  return app.route('/skills', skillsApp)
}

function form(fields: Record<string, string | File>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    fd.append(k, v as never)
  }
  return fd
}

describe('GET /skills/:id/files', () => {
  it('returns 404 when skill is missing', async () => {
    queueSelects({ get: undefined })
    const res = await buildApp().request('/skills/skl_x/files')
    expect(res.status).toBe(404)
  })

  it('returns empty entries when skill has no storagePath', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: null } })
    const res = await buildApp().request('/skills/skl_1/files')
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ data: { path: '', entries: [] } })
  })

  it('returns file listing from storage', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    listSkillFilesMock.mockReturnValue([{ name: 'a.txt', type: 'file', size: 3 }])
    const res = await buildApp().request('/skills/skl_1/files')
    const body = (await res.json()) as any
    expect(body.data.entries).toHaveLength(1)
  })
})

describe('GET /skills/:id/files/:filePath', () => {
  it('returns 404 when skill is missing', async () => {
    queueSelects({ get: undefined })
    const res = await buildApp().request('/skills/skl_x/files/note.md')
    expect(res.status).toBe(404)
  })

  it('returns 404 when skill has no storage', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: null } })
    const res = await buildApp().request('/skills/skl_1/files/note.md')
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error).toMatch(/no file storage/i)
  })

  it('returns text for known text extensions', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    readSkillFileMock.mockReturnValue(Buffer.from('# hello'))
    const res = await buildApp().request('/skills/skl_1/files/note.md')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('# hello')
  })

  it('returns binary stream with octet-stream MIME for unknown extensions', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    readSkillFileMock.mockReturnValue(Buffer.from([0x01, 0x02, 0x03]))
    const res = await buildApp().request('/skills/skl_1/files/icon.bin')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('translates readSkillFile error to 404 with the underlying message', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    readSkillFileMock.mockImplementation(() => {
      throw new Error('missing.png')
    })
    const res = await buildApp().request('/skills/skl_1/files/missing.png')
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error).toBe('missing.png')
  })
})

describe('POST /skills/:id/files/upload', () => {
  it('returns 404 when skill is missing', async () => {
    queueSelects({ get: undefined })
    const fd = new FormData()
    fd.append('files', new File(['x'], 'a.txt'))
    const res = await buildApp().request('/skills/skl_x/files/upload', {
      method: 'POST',
      body: fd,
    })
    expect(res.status).toBe(404)
  })

  it('rejects when no files are provided', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    const res = await buildApp().request('/skills/skl_1/files/upload', {
      method: 'POST',
      body: new FormData(),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/files/)
  })

  it('writes uploaded files into storage', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    const fd = new FormData()
    fd.append('files', new File(['hello'], 'a.txt'))
    fd.append('paths', '')
    const res = await buildApp().request('/skills/skl_1/files/upload', {
      method: 'POST',
      body: fd,
    })
    expect(res.status).toBe(201)
    expect(writeSkillFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /skills/upload', () => {
  it('rejects when neither folder mode nor file field is present', async () => {
    const res = await buildApp().request('/skills/upload', {
      method: 'POST',
      body: new FormData(),
    })
    expect(res.status).toBe(400)
  })

  it('rejects md/zip when neither extension applies', async () => {
    const fd = new FormData()
    fd.append('file', new File(['x'], 'note.exe'))
    const res = await buildApp().request('/skills/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/Only \.md or \.zip files are supported/)
  })

  it('uploads a .md file', async () => {
    parseSkillMdMock.mockReturnValue({ name: 'M', description: null, body: '# body' })
    const fd = new FormData()
    fd.append('file', new File(['---\nname: M\n---'], 'note.md'))
    const res = await buildApp().request('/skills/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(201)
    expect(writeSkillMdMock).toHaveBeenCalled()
    const insert = dbInsert.mock.results[0]?.value as ReturnType<typeof makeChain>
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_test', visibility: 'private' }),
    )
  })

  it('rejects all-users visibility for a non-admin before writing files', async () => {
    const fd = new FormData()
    fd.append('file', new File(['---\nname: Shared\n---'], 'SKILL.md'))
    fd.append('visibility', 'all-users')

    const res = await buildApp('user').request('/skills/upload', { method: 'POST', body: fd })

    expect(res.status).toBe(403)
    expect(writeSkillMdMock).not.toHaveBeenCalled()
    expect(dbInsert).not.toHaveBeenCalled()
  })

  it('lets an admin upload an all-users Skill', async () => {
    parseSkillMdMock.mockReturnValue({ name: 'Shared', description: null, body: '# body' })
    const fd = new FormData()
    fd.append('file', new File(['---\nname: Shared\n---'], 'SKILL.md'))
    fd.append('visibility', 'all-users')

    const res = await buildApp('admin').request('/skills/upload', { method: 'POST', body: fd })

    expect(res.status).toBe(201)
    const insert = dbInsert.mock.results[0]?.value as ReturnType<typeof makeChain>
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_test', visibility: 'all-users' }),
    )
  })

  it('uploads a .zip file', async () => {
    extractZipToSkillMock.mockReturnValue({ name: 'Z', description: 'd', body: 'body' })
    const fd = new FormData()
    fd.append('file', new File(['PK..'], 'pkg.zip'))
    const res = await buildApp().request('/skills/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(201)
    expect(extractZipToSkillMock).toHaveBeenCalled()
  })

  it('uploads from folder mode using files[] + paths[]', async () => {
    writeSkillFolderMock.mockResolvedValue({ name: 'F', description: null, body: 'b' })
    const fd = new FormData()
    fd.append('files', new File(['---\nname: F\n---'], 'SKILL.md'))
    fd.append('files', new File(['x'], 'extra.txt'))
    fd.append('paths', 'pkg/SKILL.md')
    fd.append('paths', 'pkg/extra.txt')
    const res = await buildApp().request('/skills/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(201)
    expect(writeSkillFolderMock).toHaveBeenCalled()
  })

  it('returns 400 when folder upload is invalid (writeSkillFolder rejects)', async () => {
    writeSkillFolderMock.mockRejectedValue(new Error('files and paths have different lengths'))
    const fd = new FormData()
    fd.append('files', new File(['x'], 'a.md'))
    fd.append('paths', 'a.md')
    fd.append('paths', 'extra')
    const res = await buildApp().request('/skills/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/files and paths have different lengths/)
  })
})
