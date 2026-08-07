import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn(() => 'prv_test1'),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return { ...actual }
})

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../middleware/auth-middleware.js', () => ({
  requireAdmin: vi.fn().mockImplementation((_c: unknown, next: () => Promise<void>) => next()),
}))

const capabilities = {
  authModes: ['apiKey'],
  defaultAuthMode: 'apiKey',
  modelDiscovery: { apiKey: 'automatic' },
  credentialFields: {},
  mcpDelivery: { mode: 'runtime-injection' },
  executionOptions: [],
  sessionResume: true,
  sandbox: 'native',
}

vi.mock('../../engine/index.js', () => ({
  providerCatalog: {
    toProviderDto: (provider: { kind: string }) => {
      if (provider.kind !== 'cursor') throw new Error(`Unknown Provider kind: ${provider.kind}`)
      return { ...provider, minVersion: null, capabilities }
    },
    get: vi.fn((kind: string) => (kind === 'cursor' ? { manifest: { capabilities } } : undefined)),
  },
}))

function makeDbChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result),
            all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
          }),
        ),
        all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
      }),
    ),
  }
}

function makeUpdateChain(result?: unknown) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          returning: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue(
                result ?? {
                  id: 'prv_test1',
                  kind: 'cursor',
                  name: 'Updated',
                  models: [],
                  enabledModels: [],
                },
              ),
            }),
          ),
          run: vi.fn(),
        }),
      ),
    }),
  }
}

import { db } from '../../db/client.js'

import { asyncQuery } from '../../test/async-query.js'

describe('Providers routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../providers.js')
    app = new Hono()
    app.route('/api/providers', mod.default)
  })

  describe('GET /', () => {
    it('returns all providers', async () => {
      const providers = [{ id: 'prv_1', kind: 'cursor', name: 'Cursor CLI' }]
      ;(db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue(providers),
            }),
          ),
        }),
      })

      const res = await app.request('/api/providers')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: Array<{ kind: string; capabilities: typeof capabilities }>
      }
      expect(body.data).toEqual([{ ...providers[0], minVersion: null, capabilities }])
      expect(body.data[0].kind).toBe('cursor')
    })

    it('keeps unsupported historical providers visible as diagnostic placeholders', async () => {
      const providers = [
        { id: 'prv_1', kind: 'cursor', name: 'Cursor CLI' },
        { id: 'prv_gemini', kind: 'legacy:prv_gemini', name: 'Gemini CLI' },
      ]
      ;(db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue(providers),
            }),
          ),
        }),
      })

      const res = await app.request('/api/providers')

      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: Array<Record<string, unknown>> }
      expect(body.data).toEqual([
        { ...providers[0], minVersion: null, capabilities },
        {
          ...providers[1],
          status: 'unsupported',
          diagnostic: {
            code: 'PROVIDER_KIND_UNSUPPORTED',
            message: 'No runtime adapter is registered for Provider kind "legacy:prv_gemini"',
          },
        },
      ])
    })
  })

  describe('GET /:id', () => {
    it('returns a provider by id', async () => {
      const provider = { id: 'prv_1', kind: 'cursor', name: 'Cursor CLI' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(provider))

      const res = await app.request('/api/providers/prv_1')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { kind: string; capabilities: typeof capabilities }
      }
      expect(body.data).toEqual({ ...provider, minVersion: null, capabilities })
    })

    it('returns 404 for non-existent provider', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/providers/prv_none')
      expect(res.status).toBe(404)
    })

    it('returns a structured conflict for an unsupported Provider kind', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'prv_gemini', kind: 'legacy:prv_gemini', name: 'Gemini CLI' }),
      )

      const res = await app.request('/api/providers/prv_gemini')

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: 'No runtime adapter is registered for Provider kind "legacy:prv_gemini"',
        code: 'PROVIDER_KIND_UNSUPPORTED',
        details: { providerId: 'prv_gemini', providerKind: 'legacy:prv_gemini' },
      })
    })
  })

  describe('PATCH /:id', () => {
    // Providers are entirely preset-owned now: identity/scripts come from
    // PRESET_PROVIDERS, capabilities from the manifest, and the model catalog is
    // probed live from the CLI. Nothing is editable, so the route rejects every
    // body rather than offering a way to persist a stale model list.
    it.each([
      ['models', { models: ['claude-sonnet', 'gpt-4'] }],
      ['enabledModels', { enabledModels: ['claude-sonnet'] }],
      ['name', { name: 'New Name' }],
    ])('returns 403 for a %s edit', async (_field, body) => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'prv_1', kind: 'cursor', name: 'Cursor CLI' }),
      )

      const res = await app.request('/api/providers/prv_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      expect(res.status).toBe(403)
      expect(db.update as Mock).not.toHaveBeenCalled()
    })

    it('returns 404 for a non-existent provider', async () => {
      // 403 here would report "not allowed" when the truth is "no such
      // Provider"; callers that distinguish the two must keep working.
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/providers/prv_none', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: ['gpt-4'] }),
      })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /:id', () => {
    it('returns 403 - cannot delete preset provider', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'prv_1', name: 'Cursor CLI' }))

      const res = await app.request('/api/providers/prv_1', { method: 'DELETE' })
      expect(res.status).toBe(403)
    })

    it('returns 404 for non-existent provider', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/providers/prv_none', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /:id/dependents', () => {
    it('returns dependent agents', async () => {
      const agents = [{ id: 'agt_1', name: 'Agent1' }]
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'prv_1' }))
        .mockReturnValueOnce(makeDbChain(agents))

      const res = await app.request('/api/providers/prv_1/dependents')
      expect(res.status).toBe(200)
    })

    it('returns 404 for non-existent provider', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/providers/prv_none/dependents')
      expect(res.status).toBe(404)
    })
  })
})
