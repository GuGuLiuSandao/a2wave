import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbGet = vi.fn()
// The write is awaited at `values()` / `.set().where()` — there is no `.run()`
// terminator any more, so these spies stand for "the write actually executed".
const dbInsertRun = vi.fn()
const dbUpdateRun = vi.fn()
const insertChain = {
  values: vi.fn((_values: Record<string, unknown>) => {
    dbInsertRun()
    return asyncQuery({ run: () => ({ changes: 1 }) })
  }),
}
const updateChain = {
  set: vi.fn((_values: Record<string, unknown>) =>
    asyncQuery({
      where: () => {
        dbUpdateRun()
        return asyncQuery({ run: () => ({ changes: 1 }) })
      },
    }),
  ),
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({ from: () => asyncQuery({ where: () => asyncQuery({ get: dbGet }) }) }),
    insert: () => insertChain,
    update: () => updateChain,
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: { id: 'users.id', username: 'users.username' },
}))

const envMock = { ADMIN_PASSWORD: '' }
vi.mock('../../env.js', () => ({
  get env() {
    return envMock
  },
}))

const hashPasswordMock = vi.fn(async (_p: string) => 'hashed')
const validatePasswordMock = vi.fn()
vi.mock('../auth.js', () => ({
  hashPassword: (...a: unknown[]) => hashPasswordMock(...(a as [string])),
  validatePassword: (p: string) => validatePasswordMock(p),
}))

const loggerWarnMock = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: (...args: unknown[]) => loggerWarnMock(...args), error: vi.fn() },
}))

import { ensureAdminExists, isSetupRequired } from '../setup.js'

import { asyncQuery } from '../../test/async-query.js'

beforeEach(() => {
  dbGet.mockReset()
  dbInsertRun.mockReset()
  dbUpdateRun.mockReset()
  insertChain.values.mockClear()
  updateChain.set.mockClear()
  hashPasswordMock.mockReset().mockImplementation(async () => 'hashed')
  validatePasswordMock.mockReset()
  loggerWarnMock.mockReset()
  envMock.ADMIN_PASSWORD = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isSetupRequired', () => {
  it('returns true when admin row is missing', async () => {
    dbGet.mockReturnValue(undefined)
    expect(await isSetupRequired()).toBe(true)
  })

  it('returns true when admin has no passwordHash', async () => {
    dbGet.mockReturnValue({ id: 'u', passwordHash: null })
    expect(await isSetupRequired()).toBe(true)
  })

  it('returns false when admin has a passwordHash', async () => {
    dbGet.mockReturnValue({ id: 'u', passwordHash: 'h' })
    expect(await isSetupRequired()).toBe(false)
  })
})

describe('ensureAdminExists', () => {
  it('inserts an admin row when missing, then leaves password null when env is unset', async () => {
    dbGet
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: 'usr_admin', passwordHash: null })
    await ensureAdminExists()
    expect(insertChain.values).toHaveBeenCalledTimes(1)
    expect(insertChain.values.mock.calls[0][0]).toMatchObject({ username: 'admin', role: 'admin' })
    expect(dbInsertRun).toHaveBeenCalledTimes(1)
    expect(dbUpdateRun).not.toHaveBeenCalled()
  })

  it('hashes and persists ADMIN_PASSWORD when admin has no password and env is valid', async () => {
    dbGet.mockReturnValue({ id: 'usr_admin', passwordHash: null })
    envMock.ADMIN_PASSWORD = 'Aa1aaaaa'
    validatePasswordMock.mockReturnValue({ valid: true })
    await ensureAdminExists()
    expect(hashPasswordMock).toHaveBeenCalledWith('Aa1aaaaa')
    expect(updateChain.set.mock.calls[0][0]).toMatchObject({ passwordHash: 'hashed' })
    expect(dbUpdateRun).toHaveBeenCalledTimes(1)
  })

  it('throws (fails boot) when ADMIN_PASSWORD is set but fails the policy', async () => {
    // Silently leaving the admin passwordless would leave the unauthenticated
    // POST /auth/setup window open while the operator believes it is secured.
    dbGet.mockReturnValue({ id: 'usr_admin', passwordHash: null })
    envMock.ADMIN_PASSWORD = 'weak'
    validatePasswordMock.mockReturnValue({ valid: false, message: 'PASSWORD_TOO_SHORT' })
    await expect(ensureAdminExists()).rejects.toThrow(/ADMIN_PASSWORD does not meet/)
    expect(hashPasswordMock).not.toHaveBeenCalled()
    expect(dbUpdateRun).not.toHaveBeenCalled()
  })

  it('leaves an existing admin with a passwordHash untouched', async () => {
    dbGet.mockReturnValue({ id: 'usr_admin', passwordHash: 'h' })
    envMock.ADMIN_PASSWORD = 'Aa1aaaaa'
    await ensureAdminExists()
    expect(hashPasswordMock).not.toHaveBeenCalled()
    expect(dbUpdateRun).not.toHaveBeenCalled()
    expect(insertChain.values).not.toHaveBeenCalled()
  })
})
