import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbGet = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => asyncQuery({ get: dbGet }),
      }),
    }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id' },
}))

const buildExportZipMock = vi.fn()
vi.mock('../../lib/agent-export.js', () => ({
  buildExportZip: (...args: unknown[]) => buildExportZipMock(...args),
}))

const validateShareTokenMock = vi.fn()
vi.mock('../../lib/agent-share.js', () => ({
  validateShareToken: (...args: unknown[]) => validateShareTokenMock(...args),
}))

import agentShared from '../agent-shared.js'

import { asyncQuery } from '../../test/async-query.js'

beforeEach(() => {
  dbGet.mockReset()
  buildExportZipMock.mockReset()
  validateShareTokenMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/agents/shared', agentShared)
}

describe('routes/agent-shared', () => {
  it('returns 404 when the share token is invalid', async () => {
    validateShareTokenMock.mockReturnValue(null)
    const res = await buildApp().request('/agents/shared/bad-token')
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body.error).toContain('invalid or has expired')
  })

  it('returns 404 when the agent referenced by the token no longer exists', async () => {
    validateShareTokenMock.mockReturnValue('agt_1')
    dbGet.mockReturnValue(undefined)
    const res = await buildApp().request('/agents/shared/tok')
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toEqual({ error: 'Agent not found' })
  })

  it('returns the export zip and a sanitized filename on success', async () => {
    validateShareTokenMock.mockReturnValue('agt_1')
    dbGet.mockReturnValue({ id: 'agt_1', name: 'My Agent / 演示' })
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    buildExportZipMock.mockReturnValue(zip)

    const res = await buildApp().request('/agents/shared/tok')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-length')).toBe(String(zip.length))
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-disposition')).toContain('export.zip')

    const out = new Uint8Array(await res.arrayBuffer())
    expect(out).toEqual(zip)
    expect(buildExportZipMock).toHaveBeenCalledWith('agt_1', { kind: 'public' })
  })

  it('returns 500 with the underlying error message when export fails', async () => {
    validateShareTokenMock.mockReturnValue('agt_1')
    dbGet.mockReturnValue({ id: 'agt_1', name: 'x' })
    buildExportZipMock.mockImplementation(() => {
      throw new Error('zip backend offline')
    })

    const res = await buildApp().request('/agents/shared/tok')
    expect(res.status).toBe(500)
    expect((await res.json()) as any).toEqual({ error: 'zip backend offline' })
  })
})
