import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `withTransaction`'s SQLite branch drives BEGIN/COMMIT on the raw handle and
 * hands the callback the shared `db` — it never calls `db.transaction`. So the
 * transaction boundary is observed through this `exec` spy.
 */
const sqliteExec = vi.hoisted(() => vi.fn())

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: sqliteExec },
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn(() => 'skl_test1'),
}))

vi.mock('../../lib/skill-storage.js', () => ({
  MAX_SKILL_TOTAL_UPLOAD_BYTES: 10 * 1024 * 1024,
  extractZipToSkill: vi.fn(),
  listSkillFiles: vi.fn().mockReturnValue([]),
  parseSkillMd: vi.fn().mockReturnValue({ name: 'Parsed', description: null, body: 'body' }),
  readAllSkillFiles: vi.fn().mockReturnValue([]),
  readSkillFile: vi.fn(),
  removeSkillStorage: vi.fn(),
  replaceSkillFilesWithRollback: vi.fn().mockReturnValue({
    commit: vi.fn(),
    rollback: vi.fn(),
  }),
  replaceSkillFolder: vi
    .fn()
    .mockResolvedValue({ name: 'Folder', description: null, body: 'body' }),
  validateSingleFileSize: vi.fn(),
  writeSkillFile: vi.fn(),
  writeSkillFolder: vi.fn().mockResolvedValue({ name: 'Folder', description: null, body: 'body' }),
  writeSkillMd: vi.fn(),
}))

vi.mock('../../lib/remote-skill-source.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/remote-skill-source.js')>(
    '../../lib/remote-skill-source.js',
  )
  return {
    ...actual,
    buildRemoteSkillSource: vi.fn(() => ({
      provider: 'github',
      catalog: null,
      inputUrl: 'https://github.com/acme/tools',
      repository: 'acme/tools',
      repositoryUrl: 'https://github.com/acme/tools',
      requestedRef: 'main',
      path: 'skills/demo-skill',
      revision: 'a'.repeat(40),
      digest: `sha256:${'b'.repeat(64)}`,
    })),
    loadRemoteSkillBundle: vi.fn(),
  }
})

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return { ...actual }
})

vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn(() => undefined),
  getCurrentUserId: vi.fn(() => 'usr_admin'),
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

function makeDbChain(result: unknown) {
  // An array result models a multi-row query, so it must NOT also expose `get`:
  // `asyncQuery` consults `get` first and would wrap the whole array as one row.
  const leaf = Array.isArray(result)
    ? { all: vi.fn().mockReturnValue(result) }
    : {
        get: vi.fn().mockReturnValue(result),
        all: vi.fn().mockReturnValue(result ? [result] : []),
      }
  return asyncQuery({
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(asyncQuery(leaf)),
        all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
      }),
    ),
  })
}

function makeInsertChain(result?: unknown) {
  return asyncQuery({
    values: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result ?? { id: 'skl_test1', name: 'Test Skill' }),
          }),
        ),
        run: vi.fn(),
      }),
    ),
  })
}

function makeFailingInsertChain(error = new Error('insert failed')) {
  // Production awaits `.returning()`, so the failure has to surface from the
  // awaited node rather than from a `.get()` terminator nothing calls anymore.
  return asyncQuery({
    values: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn(() => {
          throw error
        }),
      }),
    ),
  })
}

function makeUpdateChain(result?: unknown) {
  const returned = result === undefined ? { id: 'skl_test1', name: 'Updated' } : result
  // `where` is hoisted onto the returned object rather than left inside the
  // nested literal: `asyncQuery` re-wraps whatever a chain method returns, so a
  // spy reached via `set.mock.results[0].value.where` would be the wrapper, and
  // tests that assert on the UPDATE predicate could no longer read its args.
  const where = vi.fn().mockReturnValue(
    asyncQuery({
      run: vi.fn(),
      returning: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue(returned) })),
    }),
  )
  const set = vi.fn().mockReturnValue(asyncQuery({ where }))
  return Object.assign(asyncQuery({ set }), { set, where })
}

function makeDeleteChain(result?: unknown) {
  return asyncQuery({
    where: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result ?? { id: 'skl_test1' }),
          }),
        ),
      }),
    ),
  })
}

import { db } from '../../db/client.js'
import { logAudit } from '../../lib/audit.js'
import {
  RemoteSkillError,
  buildRemoteSkillSource,
  loadRemoteSkillBundle,
} from '../../lib/remote-skill-source.js'
import {
  extractZipToSkill,
  parseSkillMd,
  readAllSkillFiles,
  removeSkillStorage,
  replaceSkillFilesWithRollback,
  replaceSkillFolder,
  writeSkillFile,
  writeSkillFolder,
  writeSkillMd,
} from '../../lib/skill-storage.js'
import { asyncQuery } from '../../test/async-query.js'

describe('Skills routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(parseSkillMd as Mock).mockReturnValue({ name: 'Parsed', description: null, body: 'body' })
    ;(writeSkillFolder as Mock).mockResolvedValue({
      name: 'Folder',
      description: null,
      body: 'body',
    })
    ;(replaceSkillFolder as Mock).mockResolvedValue({
      name: 'Folder',
      description: null,
      body: 'body',
    })
    ;(replaceSkillFilesWithRollback as Mock).mockReturnValue({
      commit: vi.fn(),
      rollback: vi.fn(),
    })
    ;(db.transaction as Mock).mockImplementation((callback) =>
      callback({ insert: db.insert, update: db.update }),
    )
    const mod = await import('../skills.js')
    app = new Hono()
    app.route('/api/skills', mod.default)
  })

  describe('GET /', () => {
    it('returns all skills with authorName resolved from the users join', async () => {
      // 列表 handler：select({skill, displayName, username}).from(skills)
      //   .leftJoin(users).where().orderBy().limit().offset().all()
      // 覆盖 authorName = displayName ?? username ?? null 三分支。
      const joinedRows = [
        { skill: { id: 'skl_1', name: 'Skill1' }, displayName: 'Tate', username: 'tate' },
        { skill: { id: 'skl_2', name: 'Skill2' }, displayName: null, username: 'bob' },
        { skill: { id: 'skl_3', name: 'Skill3' }, displayName: null, username: null },
      ]
      ;(db.select as Mock)
        .mockReturnValueOnce(
          asyncQuery({
            from: vi.fn().mockReturnValue(
              asyncQuery({
                where: vi
                  .fn()
                  .mockReturnValue(
                    asyncQuery({ get: vi.fn().mockReturnValue({ count: joinedRows.length }) }),
                  ),
              }),
            ),
          }),
        )
        .mockReturnValueOnce(
          asyncQuery({
            from: vi.fn().mockReturnValue(
              asyncQuery({
                leftJoin: vi.fn().mockReturnValue(
                  asyncQuery({
                    where: vi.fn().mockReturnValue(
                      asyncQuery({
                        orderBy: vi.fn().mockReturnValue(
                          asyncQuery({
                            limit: vi.fn().mockReturnValue(
                              asyncQuery({
                                offset: vi
                                  .fn()
                                  .mockReturnValue(
                                    asyncQuery({ all: vi.fn().mockReturnValue(joinedRows) }),
                                  ),
                              }),
                            ),
                          }),
                        ),
                      }),
                    ),
                  }),
                ),
              }),
            ),
          }),
        )

      const res = await app.request('/api/skills')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data).toEqual([
        { id: 'skl_1', name: 'Skill1', authorName: 'Tate' }, // displayName 优先
        { id: 'skl_2', name: 'Skill2', authorName: 'bob' }, // 回退 username
        { id: 'skl_3', name: 'Skill3', authorName: null }, // 都无 → null
      ])
    })
  })

  describe('GET /:id', () => {
    it('returns a skill by id', async () => {
      const skill = { id: 'skl_1', name: 'My Skill' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(skill))

      const res = await app.request('/api/skills/skl_1')
      expect(res.status).toBe(200)
    })

    it('returns 404 for non-existent skill', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/skills/skl_none')
      expect(res.status).toBe(404)
    })

    it('queries non-admin details with owner-or-all-users visibility', async () => {
      const where = vi
        .fn()
        .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ id: 'skl_shared' }) }))
      ;(db.select as Mock).mockReturnValue(
        asyncQuery({ from: vi.fn().mockReturnValue(asyncQuery({ where })) }),
      )
      const mod = await import('../skills.js')
      const userApp = new Hono()
      userApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'user' as never)
        c.set('userId' as never, 'usr_owner' as never)
        await next()
      })
      userApp.route('/api/skills', mod.default)

      const res = await userApp.request('/api/skills/skl_shared')

      expect(res.status).toBe(200)
      const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
      const query = new SQLiteSyncDialect().sqlToQuery(where.mock.calls[0]?.[0])
      expect(query.sql.toLowerCase()).toContain(' or ')
      expect(query.params).toEqual(expect.arrayContaining(['skl_shared', 'usr_owner', 'all-users']))
    })

    it('queries admin details without a visibility restriction', async () => {
      const where = vi
        .fn()
        .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ id: 'skl_private' }) }))
      ;(db.select as Mock).mockReturnValue(
        asyncQuery({ from: vi.fn().mockReturnValue(asyncQuery({ where })) }),
      )
      const mod = await import('../skills.js')
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin' as never)
        c.set('userId' as never, 'usr_admin' as never)
        await next()
      })
      adminApp.route('/api/skills', mod.default)

      const res = await adminApp.request('/api/skills/skl_private')

      expect(res.status).toBe(200)
      const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
      const query = new SQLiteSyncDialect().sqlToQuery(where.mock.calls[0]?.[0])
      expect(query.sql.toLowerCase()).not.toContain('visibility')
      expect(query.params).toEqual(['skl_private'])
    })
  })

  describe('POST /', () => {
    it('creates a new skill', async () => {
      ;(db.insert as Mock).mockReturnValue(makeInsertChain())

      const res = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Skill', content: 'instructions' }),
      })

      expect(res.status).toBe(201)
      const values = (db.insert as Mock).mock.results[0]?.value.values as Mock
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: 'private', userId: 'usr_admin' }),
      )
    })

    it('rejects all-users visibility for a non-admin', async () => {
      const res = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Shared Skill', visibility: 'all-users' }),
      })

      expect(res.status).toBe(403)
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('allows an admin to create an all-users Skill', async () => {
      const mod = await import('../skills.js')
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin' as never)
        c.set('userId' as never, 'usr_admin' as never)
        await next()
      })
      adminApp.route('/api/skills', mod.default)
      ;(db.insert as Mock).mockReturnValue(makeInsertChain())

      const res = await adminApp.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Shared Skill', visibility: 'all-users' }),
      })

      expect(res.status).toBe(201)
      const values = (db.insert as Mock).mock.results[0]?.value.values as Mock
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: 'all-users', userId: 'usr_admin' }),
      )
    })

    it('returns 400 for invalid input', async () => {
      const res = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
    })
  })

  describe('PATCH /:id', () => {
    it('updates an existing skill', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skl_1' }))
      ;(db.update as Mock).mockReturnValue(makeUpdateChain())

      const res = await app.request('/api/skills/skl_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Skill' }),
      })

      expect(res.status).toBe(200)
    })

    it('returns 404 for non-existent skill', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/skills/skl_none', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })

      expect(res.status).toBe(404)
    })

    it('lets a non-admin preserve an existing all-users visibility while editing', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'skl_1', userId: 'usr_admin', visibility: 'all-users' }),
      )
      const updateChain = makeUpdateChain()
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/skills/skl_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Updated', visibility: 'all-users' }),
      })

      expect(res.status).toBe(200)
      const where = updateChain.where as Mock
      const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
      const query = new SQLiteSyncDialect().sqlToQuery(where.mock.calls[0]?.[0])
      expect(query.sql.toLowerCase()).toContain('visibility')
      expect(query.params).toEqual(expect.arrayContaining(['skl_1', 'usr_admin', 'all-users']))
    })

    it('returns 409 when an administrator revokes all-users before the preserve update lands', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'skl_1', userId: 'usr_admin', visibility: 'all-users' }),
      )
      ;(db.update as Mock).mockReturnValue(makeUpdateChain(null))

      const res = await app.request('/api/skills/skl_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Stale edit', visibility: 'all-users' }),
      })

      expect(res.status).toBe(409)
      expect(String(((await res.json()) as { error: string }).error)).toContain(
        'visibility changed',
      )
      expect(logAudit).not.toHaveBeenCalled()
    })

    it('prevents an administrator from making a platform built-in Skill private', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'skl_builtin_memory',
          name: 'a2wave-memory',
          userId: null,
          visibility: 'all-users',
        }),
      )
      const mod = await import('../skills.js')
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin' as never)
        c.set('userId' as never, 'usr_admin' as never)
        await next()
      })
      adminApp.route('/api/skills', mod.default)

      const res = await adminApp.request('/api/skills/skl_builtin_memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: 'Platform built-in Skills must remain available to all users',
      })
      expect(db.update).not.toHaveBeenCalled()
      expect(logAudit).not.toHaveBeenCalled()
    })
  })

  describe('remote installation', () => {
    const inspection = {
      inputUrl: 'https://github.com/acme/tools',
      repository: 'acme/tools',
      repositoryUrl: 'https://github.com/acme/tools',
      requestedRef: 'main',
      revision: 'a'.repeat(40),
      catalog: null,
      candidates: [
        {
          name: 'demo-skill',
          description: 'Demo',
          path: 'skills/demo-skill',
          digest: `sha256:${'b'.repeat(64)}`,
          fileCount: 1,
          totalBytes: 10,
        },
      ],
    }
    const bundle = {
      inspection,
      packages: [
        {
          ...inspection.candidates[0],
          content: 'instructions',
          files: [{ path: 'SKILL.md', content: Buffer.from('skill') }],
        },
      ],
    }

    it('previews installable Skills without writing storage or database rows', async () => {
      ;(loadRemoteSkillBundle as Mock).mockResolvedValue(bundle)

      const res = await app.request('/api/skills/remote/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: inspection.inputUrl }),
      })

      expect(res.status).toBe(200)
      expect((await res.json()) as unknown).toEqual({ data: inspection })
      expect(writeSkillFile).not.toHaveBeenCalled()
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('maps an upstream preview failure to 502', async () => {
      ;(loadRemoteSkillBundle as Mock).mockRejectedValue(
        new RemoteSkillError('upstream_error', 'GitHub unavailable'),
      )

      const res = await app.request('/api/skills/remote/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: inspection.inputUrl }),
      })

      expect(res.status).toBe(502)
      expect((await res.json()) as { code: string }).toMatchObject({ code: 'upstream_error' })
    })

    it('installs the selected package from the inspected revision', async () => {
      ;(loadRemoteSkillBundle as Mock).mockResolvedValue(bundle)
      ;(db.insert as Mock).mockReturnValue(
        makeInsertChain({
          id: 'skl_test1',
          name: 'demo-skill',
          remoteSource: { repository: 'acme/tools' },
        }),
      )

      const res = await app.request('/api/skills/remote/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inspection.inputUrl,
          requestedRef: inspection.requestedRef,
          revision: inspection.revision,
          selections: [
            {
              path: inspection.candidates[0].path,
              digest: inspection.candidates[0].digest,
            },
          ],
        }),
      })

      expect(res.status).toBe(201)
      expect(loadRemoteSkillBundle).toHaveBeenCalledWith(
        inspection.inputUrl,
        inspection.revision,
        inspection.requestedRef,
      )
      expect(writeSkillFile).toHaveBeenCalledWith('skl_test1', 'SKILL.md', expect.any(Buffer))
      expect(buildRemoteSkillSource).toHaveBeenCalled()
      expect(sqliteExec).toHaveBeenCalledWith('BEGIN')
      expect(sqliteExec).toHaveBeenCalledWith('COMMIT')
      const values = (db.insert as Mock).mock.results[0]?.value.values as Mock
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private' }))
      expect(logAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'skill.remote_install', resourceId: 'skl_test1' }),
        expect.objectContaining({ insert: db.insert }),
      )
    })

    it('rejects all-users visibility for a non-admin before loading the remote bundle', async () => {
      const res = await app.request('/api/skills/remote/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inspection.inputUrl,
          requestedRef: inspection.requestedRef,
          revision: inspection.revision,
          visibility: 'all-users',
          selections: [
            {
              path: inspection.candidates[0].path,
              digest: inspection.candidates[0].digest,
            },
          ],
        }),
      })

      expect(res.status).toBe(403)
      expect(loadRemoteSkillBundle).not.toHaveBeenCalled()
      expect(sqliteExec).not.toHaveBeenCalledWith('BEGIN')
    })

    it('lets an admin remotely install an all-users Skill', async () => {
      ;(loadRemoteSkillBundle as Mock).mockResolvedValue(bundle)
      ;(db.insert as Mock).mockReturnValue(
        makeInsertChain({
          id: 'skl_test1',
          name: 'demo-skill',
          remoteSource: { repository: 'acme/tools' },
        }),
      )
      const mod = await import('../skills.js')
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin' as never)
        c.set('userId' as never, 'usr_admin' as never)
        await next()
      })
      adminApp.route('/api/skills', mod.default)

      const res = await adminApp.request('/api/skills/remote/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inspection.inputUrl,
          requestedRef: inspection.requestedRef,
          revision: inspection.revision,
          visibility: 'all-users',
          selections: [
            {
              path: inspection.candidates[0].path,
              digest: inspection.candidates[0].digest,
            },
          ],
        }),
      })

      expect(res.status).toBe(201)
      const values = (db.insert as Mock).mock.results[0]?.value.values as Mock
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'all-users' }))
    })

    it('removes prepared storage when the database insert fails', async () => {
      ;(loadRemoteSkillBundle as Mock).mockResolvedValue(bundle)
      ;(db.insert as Mock).mockReturnValue(makeFailingInsertChain())

      const res = await app.request('/api/skills/remote/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inspection.inputUrl,
          requestedRef: inspection.requestedRef,
          revision: inspection.revision,
          selections: [
            {
              path: inspection.candidates[0].path,
              digest: inspection.candidates[0].digest,
            },
          ],
        }),
      })

      expect(res.status).toBe(500)
      expect(removeSkillStorage).toHaveBeenCalledWith('skl_test1')
    })

    it('rejects a stale candidate digest before writing files', async () => {
      ;(loadRemoteSkillBundle as Mock).mockResolvedValue(bundle)

      const res = await app.request('/api/skills/remote/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inspection.inputUrl,
          requestedRef: inspection.requestedRef,
          revision: inspection.revision,
          selections: [
            {
              path: inspection.candidates[0].path,
              digest: `sha256:${'c'.repeat(64)}`,
            },
          ],
        }),
      })

      expect(res.status).toBe(400)
      expect(writeSkillFile).not.toHaveBeenCalled()
      expect(sqliteExec).not.toHaveBeenCalledWith('BEGIN')
    })

    it('rolls back storage when an audit insert aborts the database transaction', async () => {
      ;(loadRemoteSkillBundle as Mock).mockResolvedValue(bundle)
      ;(db.insert as Mock).mockReturnValue(
        makeInsertChain({
          id: 'skl_test1',
          name: 'demo-skill',
          remoteSource: { repository: 'acme/tools' },
        }),
      )
      ;(logAudit as Mock).mockImplementationOnce(() => {
        throw new Error('audit failed')
      })

      const res = await app.request('/api/skills/remote/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inspection.inputUrl,
          requestedRef: inspection.requestedRef,
          revision: inspection.revision,
          selections: [
            {
              path: inspection.candidates[0].path,
              digest: inspection.candidates[0].digest,
            },
          ],
        }),
      })

      expect(res.status).toBe(500)
      expect(removeSkillStorage).toHaveBeenCalledWith('skl_test1')
    })

    it('rolls back partial storage when a file write fails', async () => {
      ;(loadRemoteSkillBundle as Mock).mockResolvedValue(bundle)
      ;(writeSkillFile as Mock).mockImplementationOnce(() => {
        throw new Error('disk full')
      })

      const res = await app.request('/api/skills/remote/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inspection.inputUrl,
          requestedRef: inspection.requestedRef,
          revision: inspection.revision,
          selections: [
            {
              path: inspection.candidates[0].path,
              digest: inspection.candidates[0].digest,
            },
          ],
        }),
      })

      expect(res.status).toBe(500)
      expect(removeSkillStorage).toHaveBeenCalledWith('skl_test1')
    })

    it('serializes concurrent installs of the same inspected selection', async () => {
      let releaseFirst: (() => void) | undefined
      ;(loadRemoteSkillBundle as Mock)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirst = () => resolve(bundle)
            }),
        )
        .mockResolvedValueOnce(bundle)
      ;(db.insert as Mock).mockReturnValue(
        makeInsertChain({
          id: 'skl_test1',
          name: 'demo-skill',
          remoteSource: { repository: 'acme/tools' },
        }),
      )
      const request = () =>
        app.request('/api/skills/remote/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: inspection.inputUrl,
            requestedRef: inspection.requestedRef,
            revision: inspection.revision,
            selections: [
              {
                path: inspection.candidates[0].path,
                digest: inspection.candidates[0].digest,
              },
            ],
          }),
        })

      const first = request()
      await vi.waitFor(() => expect(loadRemoteSkillBundle).toHaveBeenCalledTimes(1))
      const second = request()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(loadRemoteSkillBundle).toHaveBeenCalledTimes(1)

      releaseFirst?.()
      const responses = await Promise.all([first, second])
      expect(responses.map((response) => response.status)).toEqual([201, 201])
      expect(loadRemoteSkillBundle).toHaveBeenCalledTimes(2)
    })
  })

  describe('remote update', () => {
    const source = {
      provider: 'github' as const,
      catalog: null,
      inputUrl: 'https://github.com/acme/tools/tree/main/skills/demo-skill',
      repository: 'acme/tools',
      repositoryUrl: 'https://github.com/acme/tools',
      requestedRef: 'main',
      path: 'skills/demo-skill',
      revision: 'a'.repeat(40),
      digest: `sha256:${'b'.repeat(64)}`,
    }
    const skill = {
      id: 'skl_remote',
      name: 'demo-skill',
      description: 'Demo',
      content: 'base',
      storagePath: 'skl_remote',
      userId: 'usr_admin',
      groupId: null,
      remoteSource: source,
      sourceDirty: true,
    }
    const basePackage = {
      name: 'demo-skill',
      description: 'Demo',
      content: 'base',
      path: source.path,
      digest: source.digest,
      fileCount: 2,
      totalBytes: 8,
      files: [
        { path: 'SKILL.md', content: Buffer.from('base') },
        { path: 'shared.txt', content: Buffer.from('base') },
      ],
    }
    const latestPackage = {
      ...basePackage,
      content: 'latest',
      digest: `sha256:${'d'.repeat(64)}`,
      files: [
        { path: 'SKILL.md', content: Buffer.from('remote') },
        { path: 'shared.txt', content: Buffer.from('remote') },
      ],
    }
    const latestInspection = {
      inputUrl: source.inputUrl,
      repository: source.repository,
      repositoryUrl: source.repositoryUrl,
      requestedRef: source.requestedRef,
      revision: 'c'.repeat(40),
      catalog: null,
      candidates: [latestPackage],
    }
    const latestBundle = { inspection: latestInspection, packages: [latestPackage] }
    const baseBundle = {
      inspection: { ...latestInspection, revision: source.revision, candidates: [basePackage] },
      packages: [basePackage],
    }

    function prepareRemoteUpdate() {
      ;(db.select as Mock).mockReturnValue(makeDbChain(skill))
      ;(loadRemoteSkillBundle as Mock)
        .mockResolvedValueOnce(latestBundle)
        .mockResolvedValueOnce(baseBundle)
      ;(parseSkillMd as Mock).mockReturnValue({
        name: skill.name,
        description: skill.description,
        body: skill.content,
      })
      ;(readAllSkillFiles as Mock).mockReturnValue([
        { path: 'SKILL.md', content: Buffer.from('local') },
        { path: 'shared.txt', content: Buffer.from('local') },
      ])
    }

    it('reports upstream changes, local changes, and conflicts without replacing files', async () => {
      prepareRemoteUpdate()

      const res = await app.request('/api/skills/skl_remote/remote/check', { method: 'POST' })
      const body = (await res.json()) as {
        data: { updateAvailable: boolean; sourceDirty: boolean; conflicts: string[] }
      }

      expect(res.status).toBe(200)
      expect(body.data).toMatchObject({
        updateAvailable: true,
        sourceDirty: true,
        conflicts: ['shared.txt', 'SKILL.md'],
      })
      expect(loadRemoteSkillBundle).toHaveBeenNthCalledWith(
        1,
        source.inputUrl,
        undefined,
        source.requestedRef,
      )
      expect(loadRemoteSkillBundle).toHaveBeenNthCalledWith(
        2,
        source.inputUrl,
        source.revision,
        source.requestedRef,
      )
      expect(replaceSkillFilesWithRollback).not.toHaveBeenCalled()
      expect(logAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'skill.remote_check' }),
      )
    })

    it('returns 409 without changing storage when abort is selected for conflicts', async () => {
      prepareRemoteUpdate()

      const res = await app.request('/api/skills/skl_remote/remote/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: latestInspection.revision,
          digest: latestPackage.digest,
          strategy: 'abort',
        }),
      })

      expect(res.status).toBe(409)
      expect((await res.json()) as { code: string }).toMatchObject({ code: 'remote_conflict' })
      expect(replaceSkillFilesWithRollback).not.toHaveBeenCalled()
      expect(sqliteExec).not.toHaveBeenCalledWith('BEGIN')
    })

    it('treats database-only metadata edits as local SKILL.md conflicts', async () => {
      const editedSkill = { ...skill, content: 'locally edited instructions' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(editedSkill))
      ;(loadRemoteSkillBundle as Mock)
        .mockResolvedValueOnce(latestBundle)
        .mockResolvedValueOnce(baseBundle)
      ;(parseSkillMd as Mock).mockReturnValue({
        name: skill.name,
        description: skill.description,
        body: skill.content,
      })
      ;(readAllSkillFiles as Mock).mockReturnValue(basePackage.files)

      const res = await app.request('/api/skills/skl_remote/remote/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: latestInspection.revision,
          digest: latestPackage.digest,
          strategy: 'abort',
        }),
      })
      const body = (await res.json()) as { code: string; data: { conflicts: string[] } }

      expect(res.status).toBe(409)
      expect(body).toMatchObject({
        code: 'remote_conflict',
        data: { conflicts: ['SKILL.md'] },
      })
      expect(replaceSkillFilesWithRollback).not.toHaveBeenCalled()
      expect(sqliteExec).not.toHaveBeenCalledWith('BEGIN')
    })

    it('preserves conflicting local files and atomically updates provenance', async () => {
      prepareRemoteUpdate()
      const swap = { commit: vi.fn(), rollback: vi.fn() }
      ;(replaceSkillFilesWithRollback as Mock).mockReturnValue(swap)
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({
          ...skill,
          remoteSource: { ...source, revision: latestInspection.revision },
        }),
      )

      const res = await app.request('/api/skills/skl_remote/remote/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: latestInspection.revision,
          digest: latestPackage.digest,
          strategy: 'preserve_local',
        }),
      })

      expect(res.status).toBe(200)
      expect(replaceSkillFilesWithRollback).toHaveBeenCalledWith(
        'skl_remote',
        expect.arrayContaining([
          expect.objectContaining({ path: 'SKILL.md', content: Buffer.from('local') }),
        ]),
      )
      expect(logAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'skill.remote_update',
          details: expect.objectContaining({ strategy: 'preserve_local' }),
        }),
        expect.objectContaining({ update: db.update }),
      )
      expect(swap.commit).toHaveBeenCalled()
      expect(swap.rollback).not.toHaveBeenCalled()
    })

    it('restores the previous files when the update transaction fails', async () => {
      prepareRemoteUpdate()
      const swap = { commit: vi.fn(), rollback: vi.fn() }
      ;(replaceSkillFilesWithRollback as Mock).mockReturnValue(swap)
      // Production awaits `.returning()`, so the failure has to surface there —
      // `.get()` is no longer called and a throw inside it would never fire.
      ;(db.update as Mock).mockReturnValue(
        asyncQuery({
          set: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue(
                asyncQuery({
                  returning: vi.fn(() => {
                    throw new Error('update failed')
                  }),
                }),
              ),
            }),
          ),
        }),
      )

      const res = await app.request('/api/skills/skl_remote/remote/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: latestInspection.revision,
          digest: latestPackage.digest,
          strategy: 'overwrite',
        }),
      })

      expect(res.status).toBe(500)
      expect(swap.rollback).toHaveBeenCalled()
      expect(swap.commit).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /:id', () => {
    it('deletes an existing skill', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skl_1', storagePath: 'skl_1' }))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain())

      const res = await app.request('/api/skills/skl_1', { method: 'DELETE' })
      expect(res.status).toBe(200)
    })

    it('returns 404 for non-existent skill', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/skills/skl_none', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /:id/files', () => {
    it('returns 404 when skill not found', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/skills/skl_none/files')
      expect(res.status).toBe(404)
    })

    it('returns empty entries when no storagePath', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skl_1', storagePath: null }))

      const res = await app.request('/api/skills/skl_1/files')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.entries).toEqual([])
    })
  })

  describe('POST /:id/files/upload', () => {
    it('uploads multiple files to an existing skill', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skl_1', storagePath: 'skl_1' }))

      const formData = new FormData()
      formData.append('files', new File(['A'], 'a.txt', { type: 'text/plain' }))
      formData.append('files', new File(['B'], 'b.txt', { type: 'text/plain' }))

      const res = await app.request('/api/skills/skl_1/files/upload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(201)
      expect(writeSkillFile).toHaveBeenCalledTimes(2)
    })
  })

  describe('POST /upload (folder mode)', () => {
    // 文件夹落盘/前缀剥离/超限回滚的细节由 writeSkillFolder 单测覆盖
    // （lib/__tests__/skill-storage.test.ts）。此处只验证路由编排。
    it('creates a skill from a folder upload via writeSkillFolder', async () => {
      ;(db.insert as Mock).mockReturnValue(
        makeInsertChain({ id: 'skl_test1', name: 'Folder Skill' }),
      )
      ;(writeSkillFolder as Mock).mockResolvedValue({
        name: 'Folder Skill',
        description: 'from folder',
        body: 'body content',
      })

      const formData = new FormData()
      formData.append('files', new File(['SKILL CONTENT'], 'SKILL.md'))
      formData.append('files', new File(['ref'], 'foo.md'))
      formData.append('paths', 'my-skill/SKILL.md')
      formData.append('paths', 'my-skill/references/foo.md')

      const res = await app.request('/api/skills/upload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(201)
      expect(writeSkillFolder).toHaveBeenCalledWith(
        'skl_test1',
        expect.arrayContaining([expect.anything()]),
        ['my-skill/SKILL.md', 'my-skill/references/foo.md'],
      )
    })

    it('returns 400 when writeSkillFolder rejects (e.g. no SKILL.md)', async () => {
      ;(writeSkillFolder as Mock).mockRejectedValue(new Error('No SKILL.md found in the folder'))

      const formData = new FormData()
      formData.append('files', new File(['x'], 'foo.md'))
      formData.append('paths', 'my-skill/foo.md')

      const res = await app.request('/api/skills/upload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/SKILL\.md/)
    })

    it('rolls back folder storage when database insert fails after files are written', async () => {
      ;(db.insert as Mock).mockReturnValue(makeFailingInsertChain())
      ;(writeSkillFolder as Mock).mockResolvedValue({
        name: 'F',
        description: null,
        body: 'b',
      })

      const formData = new FormData()
      formData.append('files', new File(['SKILL CONTENT'], 'SKILL.md'))
      formData.append('files', new File(['ref'], 'ref.md'))
      formData.append('paths', 'pkg/SKILL.md')
      formData.append('paths', 'pkg/ref.md')

      const res = await app.request('/api/skills/upload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(400)
      expect(writeSkillFolder).toHaveBeenCalled()
      expect(removeSkillStorage).toHaveBeenCalledWith('skl_test1')
    })
  })

  describe('POST /upload (single file mode)', () => {
    it('rolls back .md storage when database insert fails after SKILL.md is written', async () => {
      ;(db.insert as Mock).mockReturnValue(makeFailingInsertChain())

      const formData = new FormData()
      formData.append('file', new File(['---\nname: Skill\n---\nbody'], 'SKILL.md'))

      const res = await app.request('/api/skills/upload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(400)
      expect(writeSkillMd).toHaveBeenCalled()
      expect(removeSkillStorage).toHaveBeenCalledWith('skl_test1')
    })

    it('rolls back .zip storage when database insert fails after extraction', async () => {
      ;(db.insert as Mock).mockReturnValue(makeFailingInsertChain())
      ;(extractZipToSkill as Mock).mockReturnValue({
        name: 'Zip Skill',
        description: null,
        body: 'zip body',
      })

      const formData = new FormData()
      formData.append('file', new File(['zip'], 'skill.zip'))

      const res = await app.request('/api/skills/upload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(400)
      expect(extractZipToSkill).toHaveBeenCalledWith(expect.any(Buffer), 'skl_test1')
      expect(removeSkillStorage).toHaveBeenCalledWith('skl_test1')
    })

    it('persists groupId from the form field (CLI `skills create --file --group`)', async () => {
      // Group visibility check reads skillGroups via db.select.
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skg_1' }))
      const insertChain = makeInsertChain({ id: 'skl_test1', name: 'Grouped', groupId: 'skg_1' })
      ;(db.insert as Mock).mockReturnValue(insertChain)

      const formData = new FormData()
      formData.append('file', new File(['---\nname: Skill\n---\nbody'], 'SKILL.md'))
      formData.append('groupId', 'skg_1')

      const res = await app.request('/api/skills/upload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(201)
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'skg_1' }))
    })

    it('rejects an unknown / invisible groupId with 400 and does not insert', async () => {
      // Group not found → db.select().get() returns undefined.
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))
      const insertChain = makeInsertChain()
      ;(db.insert as Mock).mockReturnValue(insertChain)

      const formData = new FormData()
      formData.append('file', new File(['---\nname: Skill\n---\nbody'], 'SKILL.md'))
      formData.append('groupId', 'skg_missing')

      const res = await app.request('/api/skills/upload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Skill group not found/)
      expect(insertChain.values).not.toHaveBeenCalled()
    })
  })

  describe('POST /:id/reupload', () => {
    it('reuploads from folder mode via replaceSkillFolder (temp-swap, no direct delete)', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'skl_1', name: 'Old', storagePath: 'skl_1' }),
      )
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ id: 'skl_1', name: 'New Folder', description: null, content: 'b' }),
      )
      ;(replaceSkillFolder as Mock).mockResolvedValue({
        name: 'New Folder',
        description: null,
        body: 'b',
      })

      const formData = new FormData()
      formData.append('files', new File(['SKILL'], 'SKILL.md'))
      formData.append('files', new File(['ref'], 'foo.md'))
      formData.append('paths', 'pkg/SKILL.md')
      formData.append('paths', 'pkg/references/foo.md')

      const res = await app.request('/api/skills/skl_1/reupload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(200)
      // temp-swap：路由不直接 removeSkillStorage，旧内容删除由 replaceSkillFolder 在校验通过后内部处理
      expect(replaceSkillFolder).toHaveBeenCalledWith('skl_1', expect.any(Array), [
        'pkg/SKILL.md',
        'pkg/references/foo.md',
      ])
      expect(removeSkillStorage).not.toHaveBeenCalled()
      const body = (await res.json()) as { data: { name: string } }
      expect(body.data.name).toBe('New Folder')
    })

    it('returns 400 and preserves old skill when folder reupload fails validation', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'skl_1', name: 'Old', storagePath: 'skl_1' }),
      )
      ;(replaceSkillFolder as Mock).mockRejectedValue(new Error('No SKILL.md found in the folder'))

      const formData = new FormData()
      formData.append('files', new File(['x'], 'foo.md'))
      formData.append('paths', 'pkg/foo.md')

      const res = await app.request('/api/skills/skl_1/reupload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(400)
      // 旧内容未被删除、DB 未更新（temp-swap：校验失败时旧数据保留）
      expect(removeSkillStorage).not.toHaveBeenCalled()
      expect(db.update as Mock).not.toHaveBeenCalled()
    })

    it('still reuploads from a single .md file', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'skl_1', name: 'Old', storagePath: 'skl_1' }),
      )
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ id: 'skl_1', name: 'Parsed', description: null, content: 'body' }),
      )

      const formData = new FormData()
      formData.append('file', new File(['---\nname: Parsed\n---\nbody'], 'SKILL.md'))

      const res = await app.request('/api/skills/skl_1/reupload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(200)
      expect(writeSkillMd).toHaveBeenCalled()
      expect(writeSkillFolder).not.toHaveBeenCalled()
    })

    it('returns 404 when the skill does not exist', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const formData = new FormData()
      formData.append('files', new File(['SKILL'], 'SKILL.md'))
      formData.append('paths', 'pkg/SKILL.md')

      const res = await app.request('/api/skills/skl_missing/reupload', {
        method: 'POST',
        body: formData,
      })

      expect(res.status).toBe(404)
      expect(writeSkillFolder).not.toHaveBeenCalled()
    })

    it('serializes concurrent folder reuploads of the same skill (per-skill lock)', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'skl_lock', name: 'Old', storagePath: 'skl_lock' }),
      )
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ id: 'skl_lock', name: 'X', description: null, content: 'b' }),
      )
      // 记录临界区进出，验证两个并发请求不交错
      const events: string[] = []
      let n = 0
      ;(replaceSkillFolder as Mock).mockImplementation(async () => {
        const tag = `r${++n}`
        events.push(`start:${tag}`)
        await new Promise((res) => setTimeout(res, 10))
        events.push(`end:${tag}`)
        return { name: tag, description: null, body: 'b' }
      })

      const mkReq = () => {
        const fd = new FormData()
        fd.append('files', new File(['SKILL'], 'SKILL.md'))
        fd.append('paths', 'pkg/SKILL.md')
        return app.request('/api/skills/skl_lock/reupload', { method: 'POST', body: fd })
      }

      const [r1, r2] = await Promise.all([mkReq(), mkReq()])

      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      // 串行：第一个完整结束后第二个才进入临界区，绝不交错
      expect(events).toEqual(['start:r1', 'end:r1', 'start:r2', 'end:r2'])
    })
  })
})
