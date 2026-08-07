import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

class ExitCalled extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

const dbGet = vi.fn()
// The UPDATE is awaited at `.set().where()` — there is no `.run()` terminator
// any more, so `run` stands for "the write actually executed".
const updateRun = vi.fn()
const updateChain = {
  set: vi.fn((_values: Record<string, unknown>) =>
    asyncQuery({
      where: updateChain.where,
    }),
  ),
  where: vi.fn(() => {
    updateRun()
    return asyncQuery({ run: () => ({ changes: 1 }) })
  }),
  run: updateRun,
}

// The script wraps its writes in db.transaction so the credential change and
// its audit entry cannot land apart; the fake runs the callback with a `tx`
// that records which executor the audit was handed.
const txExecutor = { insert: vi.fn(), update: () => updateChain }
vi.mock('../../db/client.js', () => ({
  isPostgres: true,
  sqliteDatabase: null,
  db: {
    select: () => ({ from: () => asyncQuery({ where: () => asyncQuery({ get: dbGet }) }) }),
    update: () => updateChain,
    transaction: (fn: (tx: unknown) => unknown) => fn(txExecutor),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: { id: 'users.id', username: 'users.username', tokenVersion: 'users.token_version' },
}))

const logBackgroundAudit = vi.fn()
vi.mock('../../lib/audit.js', () => ({ logBackgroundAudit }))

let exitSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
let chdirSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dbGet.mockReset()
  updateChain.set.mockClear()
  updateChain.where.mockClear()
  updateChain.run.mockClear()
  logBackgroundAudit.mockClear()
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(typeof code === 'number' ? code : 0)
  })
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {})
  vi.resetModules()
})

afterEach(() => {
  exitSpy.mockRestore()
  logSpy.mockRestore()
  errorSpy.mockRestore()
  chdirSpy.mockRestore()
})

describe('scripts/reset-admin', () => {
  it('exits 1 and logs when admin is missing', async () => {
    dbGet.mockReturnValue(undefined)
    await expect(import('../reset-admin.js?case=missing')).rejects.toBeInstanceOf(ExitCalled)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Admin user not found'))
    expect(updateChain.run).not.toHaveBeenCalled()
  })

  it('clears the admin passwordHash, bumps tokenVersion, audits, and exits 0', async () => {
    dbGet.mockReturnValue({ id: 'usr_admin', username: 'admin' })
    try {
      await import('../reset-admin.js?case=ok')
    } catch (err) {
      expect(err).toBeInstanceOf(ExitCalled)
      expect((err as ExitCalled).code).toBe(0)
    }
    const setArg = updateChain.set.mock.calls[0][0]
    expect(setArg.passwordHash).toBeNull()
    // Clearing the hash alone would not revoke existing tokens — auth-middleware
    // never reads passwordHash, only tokenVersion — so this must be present too.
    expect(setArg.tokenVersion).toBeDefined()
    expect(updateChain.run).toHaveBeenCalledTimes(1)
    // Handed the transaction executor, not the ambient db — otherwise the audit
    // insert would commit independently of the credential change.
    expect(logBackgroundAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.password_reset',
        resource: 'user',
        resourceId: 'usr_admin',
      }),
      txExecutor,
    )
    // Must warn that this immediately reopens unauthenticated setup, not claim
    // a restart is required — isSetupRequired() reads the DB live.
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/reopen/i))
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringMatching(/restart the server/i))
  })

  // Regression: the audit write was fired without await, so this short-lived
  // script could reach process.exit() with the insert still in flight — a
  // credential reset landing with no trail (Iron Rule 5).
  it('waits for the audit write to settle before exiting', async () => {
    dbGet.mockReturnValue({ id: 'usr_admin', username: 'admin' })
    let auditSettled = false
    logBackgroundAudit.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      auditSettled = true
    })

    try {
      await import('../reset-admin.js?case=success')
    } catch (err) {
      expect(err).toBeInstanceOf(ExitCalled)
    }

    expect(auditSettled).toBe(true)
  })
})
