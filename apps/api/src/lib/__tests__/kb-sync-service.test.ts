import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

const dbUpdate = vi.fn()
const txUpdate = vi.fn()
const dbTransaction = vi.fn((callback: (tx: { update: typeof txUpdate }) => unknown) =>
  callback({ update: txUpdate }),
)

function updateChain(result?: unknown) {
  // Production awaits the builder and reads `[0]`, so every node has to be
  // awaitable and resolve to the row list `result` stands for.
  const chain = {
    set: vi.fn(),
    where: vi.fn(),
    returning: vi.fn(),
    get: vi.fn(() => result),
  }
  const node = asyncQuery(chain)
  chain.set.mockReturnValue(node)
  chain.where.mockReturnValue(node)
  chain.returning.mockReturnValue(node)
  return node
}

// `isPostgres: true` keeps `withTransaction` on the branch that calls
// `db.transaction`, so the completion write still lands on `txUpdate`. The
// SQLite branch would pass the shared `db`, routing it to `dbUpdate` instead
// and exhausting the queued claim/error chains.
vi.mock('../../db/client.js', () => ({
  db: {
    update: (...args: unknown[]) => dbUpdate(...args),
    transaction: (callback: (tx: { update: typeof txUpdate }) => unknown) =>
      dbTransaction(callback),
  },
  isPostgres: true,
}))

vi.mock('../../db/schema.js', () => ({
  kbDocuments: {
    id: 'kb.id',
    syncStatus: 'kb.syncStatus',
    updatedAt: 'kb.updatedAt',
  },
}))

const fetchRemoteKbContent = vi.fn()
vi.mock('../kb-remote-fetch.js', () => ({
  fetchRemoteKbContent: (...args: unknown[]) => fetchRemoteKbContent(...args),
}))

const writeKbContent = vi.fn()
const writeKbMeta = vi.fn()
const validateKbFileSize = vi.fn()
vi.mock('../kb-storage.js', () => ({
  writeKbContent: (...args: unknown[]) => writeKbContent(...args),
  writeKbMeta: (...args: unknown[]) => writeKbMeta(...args),
  validateKbFileSize: (...args: unknown[]) => validateKbFileSize(...args),
}))

import { syncRemoteKbDocument } from '../kb-sync-service.js'

function makeDoc() {
  return {
    id: 'kbd_1',
    name: 'Handbook',
    sourceType: 'notion' as const,
    notionUrl: 'https://www.notion.so/2dc2541e45a5495e817e2ac6e189ea5a',
    notionToken: 'old-token',
    contentHash: 'old-hash',
    syncStatus: 'idle' as const,
    updatedAt: new Date('2026-07-18T08:00:00.000Z'),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchRemoteKbContent.mockResolvedValue({
    title: 'Fresh',
    content: 'fresh content',
    contentHash: 'new-hash',
  })
})

describe('syncRemoteKbDocument', () => {
  it('allows only one runner to claim the same document snapshot', async () => {
    dbUpdate
      .mockReturnValueOnce(updateChain({ id: 'kbd_1' }))
      .mockReturnValueOnce(updateChain(undefined))
    txUpdate.mockReturnValue(updateChain({ ...makeDoc(), syncStatus: 'synced' }))

    const first = await syncRemoteKbDocument(makeDoc())
    const second = await syncRemoteKbDocument(makeDoc())
    const [, secondResult] = await Promise.all([first, second])

    expect(secondResult.status).toBe('not-claimed')
    expect(fetchRemoteKbContent).toHaveBeenCalledTimes(1)
  })

  it('does not write stale content after credential rotation invalidates the lease', async () => {
    dbUpdate.mockReturnValueOnce(updateChain({ id: 'kbd_1' }))
    txUpdate.mockReturnValueOnce(updateChain(undefined))

    const result = await syncRemoteKbDocument(makeDoc())

    expect(result.status).toBe('superseded')
    expect(writeKbContent).not.toHaveBeenCalled()
    expect(writeKbMeta).not.toHaveBeenCalled()
  })
})
