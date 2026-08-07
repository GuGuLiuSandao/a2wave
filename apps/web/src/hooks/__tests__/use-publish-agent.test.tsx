import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the api client so we can inspect the exact POST body usePublishAgent sends.
const postMock = vi.fn().mockResolvedValue({ data: { id: 'agt_1' } })
vi.mock('@/lib/api', () => ({
  api: {
    post: (path: string, body: unknown) => postMock(path, body),
    get: vi.fn(),
  },
}))

import { type PublishConfig, usePublishAgent } from '../use-agents'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('usePublishAgent POST body', () => {
  beforeEach(() => {
    postMock.mockClear()
  })

  it('forwards scheduleRunAsOwner so the schedule gateway identity actually persists', async () => {
    const { result } = renderHook(() => usePublishAgent(), { wrapper })

    const config: PublishConfig = {
      authType: 'api_key',
      ipWhitelist: [],
      description: '',
      channels: ['api', 'schedule'],
      scheduleConfig: { cron: '0 9 * * *', intent: 'daily', timezone: 'Asia/Shanghai' },
      scheduleRunAsOwner: true,
    }

    await result.current.mutateAsync({ id: 'agt_1', config })

    await waitFor(() => expect(postMock).toHaveBeenCalled())
    const [path, body] = postMock.mock.calls[0]
    expect(path).toBe('/agents/agt_1/publish')
    // The whitelist in usePublishAgent must include scheduleRunAsOwner — omitting it
    // silently dropped the value so the column always stayed false (regression guard).
    expect(body).toMatchObject({ scheduleRunAsOwner: true })
  })

  it('omits scheduleRunAsOwner from the body when the config did not set it', async () => {
    const { result } = renderHook(() => usePublishAgent(), { wrapper })

    const config: PublishConfig = {
      authType: 'api_key',
      ipWhitelist: [],
      description: '',
      channels: ['api'],
    }

    await result.current.mutateAsync({ id: 'agt_1', config })

    await waitFor(() => expect(postMock).toHaveBeenCalled())
    const [, body] = postMock.mock.calls[0]
    expect(body).not.toHaveProperty('scheduleRunAsOwner')
  })
})
