import { describe, expect, it } from 'vitest'
import { withKeyedLock } from '../keyed-mutex.js'

describe('withKeyedLock', () => {
  it('serializes tasks sharing a key (no overlap)', async () => {
    const events: string[] = []
    const task = (id: string) => async () => {
      events.push(`start:${id}`)
      await new Promise((r) => setTimeout(r, 5))
      events.push(`end:${id}`)
      return id
    }

    const [a, b] = await Promise.all([withKeyedLock('k', task('A')), withKeyedLock('k', task('B'))])

    expect([a, b]).toEqual(['A', 'B'])
    // 同 key 串行：A 完整结束后 B 才开始，不交错
    expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
  })

  it('runs different keys concurrently (may overlap)', async () => {
    const order: string[] = []
    const task = (id: string) => async () => {
      order.push(`start:${id}`)
      await new Promise((r) => setTimeout(r, 5))
      order.push(`end:${id}`)
    }
    await Promise.all([withKeyedLock('k1', task('A')), withKeyedLock('k2', task('B'))])
    // 不同 key 不互斥：两个 start 都先于任一 end（交错）
    expect(order.slice(0, 2).sort()).toEqual(['start:A', 'start:B'])
  })

  it('a rejecting task does not block the next waiter on the same key', async () => {
    const ran: string[] = []
    const fail = withKeyedLock('k', async () => {
      ran.push('fail')
      throw new Error('boom')
    })
    const ok = withKeyedLock('k', async () => {
      ran.push('ok')
      return 'ok'
    })

    await expect(fail).rejects.toThrow('boom')
    await expect(ok).resolves.toBe('ok')
    expect(ran).toEqual(['fail', 'ok'])
  })
})
