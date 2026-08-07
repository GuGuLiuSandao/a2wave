import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useKbBatch } from '../use-kb-batch'

vi.mock('@/lib/antd-static', () => ({ message: { warning: vi.fn() }, notification: {}, modal: {} }))

describe('useKbBatch under StrictMode', () => {
  it('still runs a batch after the double-invoked mount effect', async () => {
    const { result } = renderHook(() => useKbBatch(), { wrapper: StrictMode })
    let out: Awaited<ReturnType<typeof result.current.run>> | undefined
    await act(async () => {
      out = await result.current.run('url', ['a', 'b'], async (l) => ({ id: `id_${l}` }))
    })
    expect(out?.succeeded).toBe(2)
    expect(out?.abandoned).toBe(false)
  })

  it('reports abandoned and stops early when unmounted mid-batch', async () => {
    const { result, unmount } = renderHook(() => useKbBatch(), { wrapper: StrictMode })
    let out: Awaited<ReturnType<typeof result.current.run>> | undefined
    await act(async () => {
      const p = result.current.run('url', ['a', 'b', 'c'], async (l) => {
        if (l === 'a') unmount()
        return { id: `id_${l}` }
      })
      out = await p
    })
    expect(out?.abandoned).toBe(true)
    expect(out?.succeeded).toBe(1)
  })
})
