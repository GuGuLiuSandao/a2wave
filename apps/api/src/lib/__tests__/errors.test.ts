import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  AppError,
  ConflictError,
  EngineError,
  NotFoundError,
  ProviderBindingInvalidError,
  ProviderConfigurationError,
  ProviderMcpUnsupportedError,
  ValidationError,
} from '../errors.js'

describe('AppError', () => {
  it('stores statusCode, message, and code', async () => {
    const err = new AppError(418, 'I am a teapot', 'TEAPOT')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(418)
    expect(err.message).toBe('I am a teapot')
    expect(err.code).toBe('TEAPOT')
    expect(err.name).toBe('AppError')
  })

  it('allows code to be undefined', async () => {
    const err = new AppError(500, 'generic')
    expect(err.code).toBeUndefined()
  })
})

describe('NotFoundError', () => {
  it('defaults to 404 with NOT_FOUND code', async () => {
    const err = new NotFoundError('Agent')
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Agent not found')
    expect(err.code).toBe('NOT_FOUND')
    expect(err.name).toBe('NotFoundError')
    expect(err).toBeInstanceOf(AppError)
  })
})

describe('ValidationError', () => {
  it('defaults to 400 with VALIDATION_ERROR code', async () => {
    const err = new ValidationError('name is required')
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('name is required')
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.name).toBe('ValidationError')
    expect(err).toBeInstanceOf(AppError)
  })
})

describe('EngineError', () => {
  it('defaults to 502 with ENGINE_ERROR code', async () => {
    const err = new EngineError('upstream timeout')
    expect(err.statusCode).toBe(502)
    expect(err.message).toBe('upstream timeout')
    expect(err.code).toBe('ENGINE_ERROR')
    expect(err.name).toBe('EngineError')
    expect(err).toBeInstanceOf(AppError)
  })
})

describe('ConflictError', () => {
  it('defaults to 409 with CONFLICT code', async () => {
    const err = new ConflictError('resource already exists')
    expect(err.statusCode).toBe(409)
    expect(err.message).toBe('resource already exists')
    expect(err.code).toBe('CONFLICT')
    expect(err.name).toBe('ConflictError')
    expect(err).toBeInstanceOf(AppError)
  })
})

describe('ProviderConfigurationError', () => {
  it('identifies an unsupported persisted Provider without falling back to another engine', async () => {
    const err = new ProviderConfigurationError('prv_legacy', 'legacy:prv_legacy')

    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('PROVIDER_CONFIGURATION_ERROR')
    expect(err.providerId).toBe('prv_legacy')
    expect(err.providerKind).toBe('legacy:prv_legacy')
    expect(err.message).toBe(
      'Provider "prv_legacy" has unsupported kind "legacy:prv_legacy"; correct the Provider configuration before retrying',
    )
    expect(err).toBeInstanceOf(AppError)
  })

  it('keeps unsupported MCP delivery inside the Provider configuration boundary', async () => {
    const err = new ProviderMcpUnsupportedError('agt_1', 'prv_pi', 'pi', 'Pi CLI')

    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('PROVIDER_MCP_UNSUPPORTED')
    expect(err.providerId).toBe('prv_pi')
    expect(err.providerKind).toBe('pi')
    expect(err.agentId).toBe('agt_1')
    expect(err.message).toContain('does not support MCP delivery')
    expect(err).toBeInstanceOf(ProviderConfigurationError)
  })

  it('keeps an invalid binding inside the Provider configuration boundary', () => {
    const err = new ProviderBindingInvalidError(
      'agt_1',
      'pc_pi',
      'prv_pi',
      'pi',
      'Pi CLI',
      'invalid_input',
      ['apiKey'],
      'Missing required credentials: apiKey',
    )

    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('PROVIDER_BINDING_INVALID')
    expect(err.agentId).toBe('agt_1')
    expect(err.bindingId).toBe('pc_pi')
    expect(err.missingFields).toEqual(['apiKey'])
    expect(err).toBeInstanceOf(ProviderConfigurationError)
  })
})

describe('error handler integration', () => {
  function createAppWithHandler() {
    const app = new Hono()

    app.get('/app-error', () => {
      throw new NotFoundError('Agent')
    })

    app.get('/generic-error', () => {
      throw new Error('something broke')
    })

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json({ error: err.message, code: err.code }, err.statusCode as never)
      }
      return c.json({ error: 'Internal Server Error' }, 500)
    })

    return app
  }

  it('returns structured JSON for AppError', async () => {
    const app = createAppWithHandler()
    const res = await app.request('/app-error')
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body).toEqual({ error: 'Agent not found', code: 'NOT_FOUND' })
  })

  it('returns 500 for non-AppError', async () => {
    const app = createAppWithHandler()
    const res = await app.request('/generic-error')
    expect(res.status).toBe(500)
    const body = (await res.json()) as any
    expect(body).toEqual({ error: 'Internal Server Error' })
  })
})
