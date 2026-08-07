import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const postMock = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api', () => ({ api: { post: (p: string, b: unknown) => postMock(p, b) } }))

import { useLogout } from '../use-auth'

const ACTIVE_KEY = 'a2wave:onboarding:active'
const realLocation = window.location

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('useLogout', () => {
  beforeEach(() => {
    localStorage.clear()
    postMock.mockClear()
    // jsdom 给 location.href 赋值会报 navigation Not implemented；替换成普通对象。
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
      configurable: true,
    })
  })
  afterAll(() => {
    Object.defineProperty(window, 'location', { value: realLocation, configurable: true })
  })

  // 回归：active 是全局 localStorage key，登出不清会让同浏览器换账号的下个用户被强制重进 tour。
  it('clears the onboarding active flag on logout', async () => {
    localStorage.setItem(ACTIVE_KEY, '1')
    const { result } = renderHook(() => useLogout(), { wrapper: wrapper() })
    await act(async () => {
      await result.current()
    })
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull()
    expect(window.location.href).toBe('/login')
  })

  it('still logs out locally even if the backend call fails', async () => {
    postMock.mockRejectedValueOnce(new Error('network'))
    localStorage.setItem(ACTIVE_KEY, '1')
    const { result } = renderHook(() => useLogout(), { wrapper: wrapper() })
    await act(async () => {
      await result.current()
    })
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull()
    expect(window.location.href).toBe('/login')
  })
})
