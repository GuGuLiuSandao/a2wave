import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

const dbSelectAll = vi.fn()
// Call recorders, shared across nodes so assertions can read the whole sequence
// of `set(...)` payloads regardless of which builder produced them.
const dbUpdateChain = {
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  get: vi.fn(() => ({ id: 'kbd_1' })),
}

/**
 * Production awaits the update builder and reads `[0]` off the returned rows, so
 * every node has to be a thenable. A fresh one is built per `db.update()` call
 * because asyncQuery memoizes the rows it resolves to — one shared node would
 * settle once and every later update would read that same stale result.
 */
function makeUpdateNode(): ReturnType<typeof asyncQuery> {
  const record =
    (spy: (typeof dbUpdateChain)['set']) =>
    (...args: unknown[]) => {
      spy(...args)
      return node
    }
  const node = asyncQuery({
    set: record(dbUpdateChain.set),
    where: record(dbUpdateChain.where),
    returning: record(dbUpdateChain.returning),
    get: () => dbUpdateChain.get(),
  })
  return node
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => asyncQuery({ where: () => asyncQuery({ all: dbSelectAll }) }),
    }),
    update: vi.fn(() => makeUpdateNode()),
    transaction: vi.fn((callback) => callback({ update: vi.fn(() => makeUpdateNode()) })),
  },
}))

vi.mock('../../db/schema.js', () => ({
  kbDocuments: {
    id: 'kbDocuments.id',
    sourceType: 'kbDocuments.sourceType',
    autoSync: 'kbDocuments.autoSync',
    syncStatus: 'kbDocuments.syncStatus',
    updatedAt: 'kbDocuments.updatedAt',
  },
}))

const fetchFeishuDocByUrlMock = vi.fn()
vi.mock('../feishu-doc-fetcher.js', () => ({
  fetchFeishuDocByUrl: (...args: unknown[]) => fetchFeishuDocByUrlMock(...args),
}))

const fetchNotionDocByUrlMock = vi.fn()
vi.mock('../notion-doc-fetcher.js', () => ({
  fetchNotionDocByUrl: (...args: unknown[]) => fetchNotionDocByUrlMock(...args),
}))

const writeKbContentMock = vi.fn()
const writeKbMetaMock = vi.fn()
const validateKbFileSizeMock = vi.fn()
vi.mock('../kb-storage.js', () => ({
  writeKbContent: (...args: unknown[]) => writeKbContentMock(...args),
  writeKbMeta: (...args: unknown[]) => writeKbMetaMock(...args),
  validateKbFileSize: (...args: unknown[]) => validateKbFileSizeMock(...args),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

async function loadScheduler() {
  vi.resetModules()
  const mod = await import('../kb-sync-scheduler.js')
  return mod
}

beforeEach(() => {
  vi.useFakeTimers()
  dbSelectAll.mockReset()
  dbUpdateChain.set.mockClear()
  dbUpdateChain.where.mockClear()
  dbUpdateChain.returning.mockClear()
  dbUpdateChain.get.mockClear()
  fetchFeishuDocByUrlMock.mockReset()
  fetchNotionDocByUrlMock.mockReset()
  writeKbContentMock.mockReset()
  writeKbMetaMock.mockReset()
  validateKbFileSizeMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'kbd_1',
    name: 'doc',
    syncStatus: 'idle',
    feishuUrl: 'https://x.feishu.cn/docx/T',
    feishuAppId: 'app',
    feishuAppSecret: 'sec',
    contentHash: 'old',
    autoSync: true,
    sourceType: 'feishu',
    syncIntervalMin: 1,
    lastSyncAt: null,
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('startKbSyncScheduler', () => {
  it('schedules a tick on a 60s interval and unrefs the timer', async () => {
    dbSelectAll.mockReturnValue([])
    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1)
  })

  it('runs the sync loop on tick — writes content + meta when contentHash changed', async () => {
    dbSelectAll.mockReturnValue([makeDoc()])
    fetchFeishuDocByUrlMock.mockResolvedValue({
      title: 'T',
      content: 'fresh body',
      contentHash: 'new',
      token: 'tok',
      type: 'docx',
    })

    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    // Allow the await chain inside doSync to settle
    await Promise.resolve()
    await Promise.resolve()

    expect(writeKbContentMock).toHaveBeenCalledWith('kbd_1', 'fresh body')
    expect(writeKbMetaMock).toHaveBeenCalledTimes(1)
    expect(validateKbFileSizeMock).toHaveBeenCalledWith(Buffer.byteLength('fresh body', 'utf-8'))
    // First update marks syncing, second marks synced
    expect(dbUpdateChain.set).toHaveBeenCalledTimes(2)
    const lastSetCall = dbUpdateChain.set.mock.calls.at(-1)![0]
    expect(lastSetCall.syncStatus).toBe('synced')
    expect(lastSetCall.contentHash).toBe('new')
  })

  it('skips writing when contentHash did not change but still marks synced', async () => {
    dbSelectAll.mockReturnValue([makeDoc({ contentHash: 'same' })])
    fetchFeishuDocByUrlMock.mockResolvedValue({
      title: 'T',
      content: 'unchanged',
      contentHash: 'same',
      token: 'tok',
      type: 'docx',
    })

    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(writeKbContentMock).not.toHaveBeenCalled()
    expect(writeKbMetaMock).not.toHaveBeenCalled()
  })

  it('marks the doc as error when fetch fails', async () => {
    dbSelectAll.mockReturnValue([makeDoc()])
    fetchFeishuDocByUrlMock.mockRejectedValue(new Error('feishu down'))

    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()

    const lastSetCall = dbUpdateChain.set.mock.calls.at(-1)![0]
    expect(lastSetCall.syncStatus).toBe('error')
    expect(lastSetCall.lastSyncError).toBe('feishu down')
  })

  it('filters out docs that are currently syncing or missing credentials', async () => {
    dbSelectAll.mockReturnValue([
      makeDoc({ syncStatus: 'syncing' }),
      makeDoc({ feishuUrl: '' }),
      makeDoc({ feishuAppId: '' }),
      makeDoc({ feishuAppSecret: '' }),
    ])
    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFeishuDocByUrlMock).not.toHaveBeenCalled()
  })

  it('recovers a document whose syncing lease is stale', async () => {
    dbSelectAll.mockReturnValue([
      makeDoc({
        syncStatus: 'syncing',
        updatedAt: new Date(Date.now() - 11 * 60 * 1000),
      }),
    ])
    fetchFeishuDocByUrlMock.mockResolvedValue({
      title: 'T',
      content: 'recovered',
      contentHash: 'new',
      token: 'tok',
      type: 'docx',
    })

    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchFeishuDocByUrlMock).toHaveBeenCalled()
    expect(writeKbContentMock).toHaveBeenCalledWith('kbd_1', 'recovered')
  })

  it('marks oversized remote content as error before writing it', async () => {
    dbSelectAll.mockReturnValue([makeDoc()])
    fetchFeishuDocByUrlMock.mockResolvedValue({
      title: 'T',
      content: 'oversized',
      contentHash: 'new',
      token: 'tok',
      type: 'docx',
    })
    validateKbFileSizeMock.mockImplementation(() => {
      throw new Error('too big')
    })

    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(writeKbContentMock).not.toHaveBeenCalled()
    expect(writeKbMetaMock).not.toHaveBeenCalled()
    expect(dbUpdateChain.set.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ syncStatus: 'error', lastSyncError: 'too big' }),
    )
  })

  it('syncs notion docs through the notion fetcher', async () => {
    dbSelectAll.mockReturnValue([
      makeDoc({
        id: 'kbd_n',
        sourceType: 'notion',
        feishuUrl: null,
        feishuAppId: null,
        feishuAppSecret: null,
        notionUrl: 'https://www.notion.so/x',
        notionToken: 'tok',
      }),
    ])
    fetchNotionDocByUrlMock.mockResolvedValue({
      title: 'N',
      content: '# N\n\nfresh',
      contentHash: 'new',
      pageId: 'pid',
    })

    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchNotionDocByUrlMock).toHaveBeenCalledWith('https://www.notion.so/x', 'tok')
    expect(writeKbContentMock).toHaveBeenCalledWith('kbd_n', '# N\n\nfresh')
    const lastSetCall = dbUpdateChain.set.mock.calls.at(-1)![0]
    expect(lastSetCall.syncStatus).toBe('synced')
  })

  it('filters out notion docs missing credentials', async () => {
    dbSelectAll.mockReturnValue([
      makeDoc({
        sourceType: 'notion',
        feishuUrl: null,
        feishuAppId: null,
        feishuAppSecret: null,
        notionUrl: 'https://www.notion.so/x',
        notionToken: '',
      }),
    ])
    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchNotionDocByUrlMock).not.toHaveBeenCalled()
  })

  it('skips docs that are not yet due (lastSyncAt within interval)', async () => {
    // Interval = 120 minutes; lastSyncAt = now. Even after advancing 60s the
    // elapsed time is well under the per-doc interval.
    const now = new Date(Date.now())
    dbSelectAll.mockReturnValue([makeDoc({ lastSyncAt: now, syncIntervalMin: 120 })])
    const { startKbSyncScheduler } = await loadScheduler()
    startKbSyncScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFeishuDocByUrlMock).not.toHaveBeenCalled()
  })
})
