/**
 * Covers POST /skills/:id/reupload — both .md and .zip branches.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbUpdate = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    update: (...a: unknown[]) => dbUpdate(...a),
    insert: vi.fn(),
  },
  // `db/transaction.js` reads these at module load to pick a backend, and its
  // SQLite branch drives BEGIN/COMMIT on the raw handle. Without a stand-in
  // handle every transactional route throws before its own mocks are consulted.
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  skills: { id: 'skills.id', userId: 'skills.userId', createdAt: 'skills.createdAt' },
  skillGroups: { id: 'skillGroups.id', userId: 'skillGroups.userId' },
}))

const logAuditMock = vi.fn()
vi.mock('../../lib/audit.js', () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }))
vi.mock('../../lib/id.js', () => ({ createId: vi.fn((p?: string) => `${p}_x`) }))
vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn(() => undefined),
  getCurrentUserId: vi.fn(() => 'usr_test'),
}))

const extractZipToSkillMock = vi.fn()
const parseSkillMdMock = vi.fn()
const writeSkillMdMock = vi.fn()
const removeSkillStorageMock = vi.fn()
const validateSingleFileSizeMock = vi.fn()
vi.mock('../../lib/skill-storage.js', () => ({
  extractZipToSkill: (...a: unknown[]) => extractZipToSkillMock(...a),
  findSkillRoot: vi.fn(),
  getSkillStoragePath: vi.fn(),
  listSkillFiles: vi.fn(),
  parseSkillMd: (...a: unknown[]) => parseSkillMdMock(...a),
  readSkillFile: vi.fn(),
  removeSkillStorage: (...a: unknown[]) => removeSkillStorageMock(...a),
  validateSingleFileSize: (s: number) => validateSingleFileSizeMock(s),
  validateSkillTotalSize: vi.fn(),
  writeSkillFile: vi.fn(),
  writeSkillMd: (...a: unknown[]) => writeSkillMdMock(...a),
}))

vi.mock('@a2wave/shared', () => ({
  createSkillInput: { safeParse: () => ({ success: true, data: {} }) },
  updateSkillInput: { safeParse: () => ({ success: true, data: {} }) },
}))

import skillsApp from '../skills.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'set',
    'returning',
    'limit',
    'orderBy',
    'offset',
    'groupBy',
    'having',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
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

function queueSelects(...returns: Array<{ get?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    return c
  })
}

beforeEach(() => {
  dbSelect.mockReset()
  dbUpdate.mockReset().mockImplementation(() => {
    const c = makeChain()
    c.get.mockReturnValue({ id: 'skl_1', name: 'updated' })
    return c
  })
  logAuditMock.mockReset()
  extractZipToSkillMock.mockReset()
  parseSkillMdMock.mockReset()
  writeSkillMdMock.mockReset()
  removeSkillStorageMock.mockReset()
  validateSingleFileSizeMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/skills', skillsApp)
}

function form(filename: string, contents = 'x'): FormData {
  const fd = new FormData()
  fd.append('file', new File([contents], filename))
  return fd
}

describe('POST /skills/:id/reupload', () => {
  it('returns 404 when skill is missing', async () => {
    queueSelects({ get: undefined })
    const res = await buildApp().request('/skills/skl_x/reupload', {
      method: 'POST',
      body: form('note.md'),
    })
    expect(res.status).toBe(404)
  })

  it('rejects when no file is provided', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    const res = await buildApp().request('/skills/skl_1/reupload', {
      method: 'POST',
      body: new FormData(),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/Upload either a file field/)
  })

  it('rejects when extension is neither .md nor .zip', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    const res = await buildApp().request('/skills/skl_1/reupload', {
      method: 'POST',
      body: form('note.exe'),
    })
    expect(res.status).toBe(400)
  })

  it('replaces with a .md file: clears storage, parses metadata, writes SKILL.md', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    parseSkillMdMock.mockReturnValue({ name: 'Renamed', description: 'd', body: 'body text' })
    const res = await buildApp().request('/skills/skl_1/reupload', {
      method: 'POST',
      body: form('note.md', '---\nname: Renamed\n---\nbody text'),
    })
    expect(res.status).toBe(200)
    expect(removeSkillStorageMock).toHaveBeenCalledWith('skl_1')
    expect(writeSkillMdMock).toHaveBeenCalled()
    expect(logAuditMock).toHaveBeenCalled()
  })

  it('replaces with a .zip file: clears storage and extracts contents', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    extractZipToSkillMock.mockReturnValue({ name: 'Z', description: null, body: 'b' })
    const res = await buildApp().request('/skills/skl_1/reupload', {
      method: 'POST',
      body: form('pkg.zip', 'PKzip'),
    })
    expect(res.status).toBe(200)
    expect(removeSkillStorageMock).toHaveBeenCalledWith('skl_1')
    expect(extractZipToSkillMock).toHaveBeenCalled()
  })

  it('returns 400 with underlying message when validation throws', async () => {
    queueSelects({ get: { id: 'skl_1', storagePath: 'skl_1' } })
    validateSingleFileSizeMock.mockImplementation(() => {
      throw new Error('too big')
    })
    const res = await buildApp().request('/skills/skl_1/reupload', {
      method: 'POST',
      body: form('note.md'),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('too big')
  })
})
