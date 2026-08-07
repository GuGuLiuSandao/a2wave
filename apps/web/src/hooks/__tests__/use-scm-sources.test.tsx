import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * Regression tests for useScmSourceWorkspaces / useDeleteScmWorkspace.
 *
 * Locks the API URL shape (especially encodeURIComponent on the workspace
 * `name` segment — path traversal / special-char safety) and the cache
 * invalidation key after delete.
 */
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock @/lib/api before importing the hooks
const mockGet = vi.fn()
const mockDelete = vi.fn()
const mockList = vi.fn()
const mockPost = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    list: (...args: unknown[]) => mockList(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}))

import {
  useDeleteScmWorkspace,
  useScmSourceWorkspaces,
  useScmSources,
  useSyncScmSource,
} from '../use-scm-sources'

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, wrapper }
}

describe('useScmSourceWorkspaces', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockDelete.mockReset()
  })

  it('fetches /scm-sources/:id/workspaces and exposes .data (unwraps select)', async () => {
    const workspaces = [
      {
        name: 'wt-a',
        path: '/ws/wt-a',
        repos: [],
        occupied: false,
        cleanup: 'ttl',
        lastRunId: null,
        lastActivityAt: null,
      },
    ]
    mockGet.mockResolvedValueOnce({ data: workspaces })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useScmSourceWorkspaces('scm_1'), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGet).toHaveBeenCalledWith('/scm-sources/scm_1/workspaces')
    expect(result.current.data).toEqual(workspaces)
  })

  it('is disabled when id is empty', () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useScmSourceWorkspaces(''), { wrapper })

    expect(result.current.fetchStatus).toBe('idle')
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('is disabled when enabled=false even with valid id', () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useScmSourceWorkspaces('scm_1', false), { wrapper })

    expect(result.current.fetchStatus).toBe('idle')
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('useDeleteScmWorkspace', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockDelete.mockReset()
  })

  it('calls DELETE /scm-sources/:id/workspaces/:name with the name URI-encoded', async () => {
    mockDelete.mockResolvedValueOnce({ data: { message: 'ok' } })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useDeleteScmWorkspace(), { wrapper })

    // Name with path-traversal / space characters must be encoded.
    await result.current.mutateAsync({ id: 'scm_1', name: 'feature/x y' })

    expect(mockDelete).toHaveBeenCalledTimes(1)
    expect(mockDelete).toHaveBeenCalledWith('/scm-sources/scm_1/workspaces/feature%2Fx%20y')
  })

  it('invalidates the workspaces query for the same scm source on success', async () => {
    mockDelete.mockResolvedValueOnce({ data: { message: 'ok' } })

    const { qc, wrapper } = makeWrapper()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')

    const { result } = renderHook(() => useDeleteScmWorkspace(), { wrapper })
    await result.current.mutateAsync({ id: 'scm_1', name: 'wt-a' })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['scm-sources', 'scm_1', 'workspaces'],
      })
    })
  })
})

describe('useScmSources — polling while a sync runs', () => {
  beforeEach(() => {
    mockList.mockReset()
  })

  it('polls while any source is syncing', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'scm_1', syncStatus: 'syncing' }] })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useScmSources(), { wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())
    // POST /sync returns 202 and finishes in the background, so without a poll
    // the card would spin until a manual reload.
    const interval = result.current.dataUpdatedAt
    expect(interval).toBeGreaterThan(0)
    await waitFor(() => expect(mockList.mock.calls.length).toBeGreaterThan(1), { timeout: 6000 })
  })

  it('stops polling once every source has settled', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'scm_1', syncStatus: 'idle' }] })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useScmSources(), { wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())
    const callsAfterLoad = mockList.mock.calls.length
    await new Promise((r) => setTimeout(r, 3500))
    expect(mockList.mock.calls.length).toBe(callsAfterLoad)
  })
})

describe('useSyncScmSource', () => {
  beforeEach(() => {
    mockPost.mockReset()
  })

  it('invalidates the list key, not just the per-id one', async () => {
    mockPost.mockResolvedValueOnce({ data: { message: 'Sync started' } })

    const { qc, wrapper } = makeWrapper()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')

    const { result } = renderHook(() => useSyncScmSource(), { wrapper })
    await result.current.mutateAsync('scm_1')

    // The list query key is ['scm-sources', page, pageSize], which
    // ['scm-sources','scm_1'] does not prefix-match — so invalidating only the
    // id left the card that triggered the sync showing its stale status.
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['scm-sources'] })
    })
  })
})
