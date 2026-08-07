import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listMock = vi.fn()
const getMock = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    list: (path: string) => listMock(path),
    get: (...args: unknown[]) => getMock(...args),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

import { useAgent, useAllAgents } from '../use-agents'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function createAccessHarness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  })
  const accessWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper: accessWrapper }
}

describe('useAllAgents', () => {
  beforeEach(() => {
    listMock.mockReset()
  })

  it('loads every agent page for searchable selectors', async () => {
    listMock
      .mockResolvedValueOnce({
        data: [{ id: 'agt_1', name: 'First' }],
        pagination: { page: 1, pageSize: 100, total: 3, totalPages: 3 },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'agt_2', name: 'Second' }],
        pagination: { page: 2, pageSize: 100, total: 3, totalPages: 3 },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'agt_3', name: 'Third' }],
        pagination: { page: 3, pageSize: 100, total: 3, totalPages: 3 },
      })

    const { result } = renderHook(() => useAllAgents(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(listMock.mock.calls.map(([path]) => path)).toEqual([
      '/agents?page=1&pageSize=100',
      '/agents?page=2&pageSize=100',
      '/agents?page=3&pageSize=100',
    ])
    expect(result.current.data).toEqual({
      data: [
        { id: 'agt_1', name: 'First' },
        { id: 'agt_2', name: 'Second' },
        { id: 'agt_3', name: 'Third' },
      ],
      total: 3,
    })
  })

  it('does not query when disabled', () => {
    const { result } = renderHook(() => useAllAgents({ enabled: false }), { wrapper })

    expect(result.current.fetchStatus).toBe('idle')
    expect(listMock).not.toHaveBeenCalled()
  })
})

describe('useAgent', () => {
  beforeEach(() => {
    getMock.mockReset()
    getMock.mockResolvedValue({
      data: { id: 'agt_1', name: 'Agent' },
      meta: { permission: 'editor', skillBindingScope: 'owner-or-shared' },
    })
    focusManager.setFocused(undefined)
  })

  it('refreshes the Agent access projection despite globally fresh cache settings', async () => {
    const { queryClient, wrapper: accessWrapper } = createAccessHarness()
    queryClient.setQueryData(['agents', 'agt_1'], {
      data: { id: 'agt_1', name: 'Agent' },
      meta: { permission: 'editor', skillBindingScope: 'all-visible' },
    })

    const { unmount } = renderHook(() => useAgent('agt_1'), { wrapper: accessWrapper })

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/agents/agt_1'))
    getMock.mockClear()

    act(() => focusManager.setFocused(false))
    act(() => focusManager.setFocused(true))

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/agents/agt_1'))
    unmount()
    act(() => focusManager.setFocused(undefined))
  })
})
