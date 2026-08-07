import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACTIVE_KEY = 'a2wave:onboarding:active'

const getMock = vi.fn()
const patchMock = vi.fn().mockResolvedValue({ data: { onboarding: { newbie: 'completed' } } })
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => getMock(path),
    patch: (path: string, body: unknown) => patchMock(path, body),
  },
}))

import { useOnboarding } from '../use-onboarding'

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

function mockUser(onboarding: Record<string, string>) {
  getMock.mockResolvedValue({ data: { id: 'u1', username: 'x', onboarding } })
}

describe('useOnboarding', () => {
  beforeEach(() => {
    localStorage.clear()
    getMock.mockReset()
    patchMock.mockClear()
  })

  it('done=false when guide status absent', async () => {
    mockUser({})
    const { result } = renderHook(() => useOnboarding(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.done).toBe(false)
  })

  it('done=true when guide completed', async () => {
    mockUser({ newbie: 'completed' })
    const { result } = renderHook(() => useOnboarding(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.done).toBe(true))
    expect(result.current.status).toBe('completed')
  })

  it('done=true when guide dismissed', async () => {
    mockUser({ newbie: 'dismissed' })
    const { result } = renderHook(() => useOnboarding(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.done).toBe(true))
  })

  it('start() / pause() toggle active (persisted to localStorage)', async () => {
    mockUser({})
    const { result } = renderHook(() => useOnboarding(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => result.current.start())
    expect(result.current.active).toBe(true)
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('1')
    act(() => result.current.pause())
    expect(result.current.active).toBe(false)
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull()
  })

  it('complete() clears active and PATCHes status=completed', async () => {
    mockUser({})
    const { result } = renderHook(() => useOnboarding(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => result.current.start())
    act(() => result.current.complete())
    expect(result.current.active).toBe(false)
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/auth/onboarding', {
        guide: 'newbie',
        status: 'completed',
      }),
    )
  })

  it('dismiss() PATCHes status=dismissed', async () => {
    mockUser({})
    const { result } = renderHook(() => useOnboarding(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => result.current.dismiss())
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/auth/onboarding', {
        guide: 'newbie',
        status: 'dismissed',
      }),
    )
  })
})
