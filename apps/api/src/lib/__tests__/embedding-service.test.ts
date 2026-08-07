import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Hoisted mocks ---

const mockGetCategorySettings = vi.hoisted(() => vi.fn())

vi.mock('../settings.js', () => ({
  getCategorySettings: mockGetCategorySettings,
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { getEmbeddingConfig, getEmbeddings, isEmbeddingAvailable } from '../embedding-service.js'

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function makeSettings(overrides: Record<string, string> = {}) {
  return {
    enabled: 'true',
    apiKey: 'sk-test-key',
    baseUrl: 'https://api.openai.com',
    model: 'text-embedding-3-large',
    ...overrides,
  }
}

function makeApiResponse(embeddings: number[][]): {
  data: Array<{ embedding: number[]; index: number }>
} {
  return {
    data: embeddings.map((embedding, index) => ({ embedding, index })),
  }
}

// ----------------------------------------------------------------
// getEmbeddingConfig
// ----------------------------------------------------------------

describe('getEmbeddingConfig', () => {
  it('parses enabled=true correctly', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'true' }))
    const config = await getEmbeddingConfig()
    expect((await config).enabled).toBe(true)
  })

  it('parses enabled=false correctly', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'false' }))
    const config = await getEmbeddingConfig()
    expect((await config).enabled).toBe(false)
  })

  it('defaults model to text-embedding-3-large when not set', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ model: '' }))
    const config = await getEmbeddingConfig()
    expect((await config).model).toBe('text-embedding-3-large')
  })

  it('defaults apiKey to empty string when not set', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ apiKey: '' }))
    const config = await getEmbeddingConfig()
    expect((await config).apiKey).toBe('')
  })

  it('passes through baseUrl', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ baseUrl: 'https://my-llm.example.com' }))
    const config = await getEmbeddingConfig()
    expect((await config).baseUrl).toBe('https://my-llm.example.com')
  })

  it('calls getCategorySettings with category "embedding"', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings())
    await getEmbeddingConfig()
    expect(mockGetCategorySettings).toHaveBeenCalledWith('embedding')
  })
})

// ----------------------------------------------------------------
// isEmbeddingAvailable
// ----------------------------------------------------------------

describe('isEmbeddingAvailable', () => {
  it('returns false when disabled', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'false' }))
    expect(await isEmbeddingAvailable()).toBe(false)
  })

  it('returns false when enabled but apiKey is empty', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'true', apiKey: '' }))
    expect(await isEmbeddingAvailable()).toBe(false)
  })

  it('returns false when enabled but baseUrl is empty', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'true', baseUrl: '' }))
    expect(await isEmbeddingAvailable()).toBe(false)
  })

  it('returns false when both disabled and no apiKey', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'false', apiKey: '' }))
    expect(await isEmbeddingAvailable()).toBe(false)
  })

  it('returns true when enabled, apiKey and baseUrl are configured', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings())
    expect(await isEmbeddingAvailable()).toBe(true)
  })
})

// ----------------------------------------------------------------
// getEmbeddings
// ----------------------------------------------------------------

describe('getEmbeddings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns empty array immediately when texts is empty', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings())
    const result = await getEmbeddings([])
    expect(result).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns empty array when embedding is disabled', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'false' }))
    const result = await getEmbeddings(['hello'])
    expect(result).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns empty array when apiKey is not configured', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'true', apiKey: '' }))
    const result = await getEmbeddings(['hello'])
    expect(result).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns empty array when baseUrl is not configured', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'true', baseUrl: '' }))
    const result = await getEmbeddings(['hello'])
    expect(result).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('calls the configured baseUrl endpoint', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ baseUrl: 'https://my-llm.example.com' }))
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([[0.1, 0.2, 0.3]]),
    } as Response)

    await getEmbeddings(['hello'])

    expect(fetch).toHaveBeenCalledOnce()
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://my-llm.example.com/v1/embeddings')
  })

  it('strips trailing slashes from baseUrl', async () => {
    mockGetCategorySettings.mockReturnValue(
      makeSettings({ baseUrl: 'https://my-llm.example.com///' }),
    )
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([[0.1, 0.2]]),
    } as Response)

    await getEmbeddings(['hello'])

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://my-llm.example.com/v1/embeddings')
  })

  it('sends POST request with correct headers', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ apiKey: 'sk-secret' }))
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([[0.1]]),
    } as Response)

    await getEmbeddings(['hello'])

    const [, options] = vi.mocked(fetch).mock.calls[0]
    expect((options as RequestInit).method).toBe('POST')
    const headers = (options as RequestInit).headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toBe('Bearer sk-secret')
  })

  it('sends model and input in request body', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ model: 'text-embedding-ada-002' }))
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([[0.1], [0.2]]),
    } as Response)

    await getEmbeddings(['hello', 'world'])

    const [, options] = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.model).toBe('text-embedding-ada-002')
    expect(body.input).toEqual(['hello', 'world'])
  })

  it('parses response and returns embeddings in correct order', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings())
    // Return data out of order — service must sort by index
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.3, 0.4], index: 1 },
          { embedding: [0.1, 0.2], index: 0 },
        ],
      }),
    } as Response)

    const result = await getEmbeddings(['first', 'second'])

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
  })

  it('returns empty array on non-ok HTTP response (graceful degradation)', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings())
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response)

    const result = await getEmbeddings(['hello'])

    expect(result).toEqual([])
  })

  it('returns empty array when fetch throws a network error (graceful degradation)', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings())
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await getEmbeddings(['hello'])

    expect(result).toEqual([])
  })

  it('returns empty array when response.json() throws (graceful degradation)', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings())
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('invalid JSON')
      },
    } as unknown as Response)

    const result = await getEmbeddings(['hello'])

    expect(result).toEqual([])
  })
})
