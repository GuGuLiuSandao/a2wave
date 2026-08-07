import { describe, expect, it, vi } from 'vitest'
import { SseEventAccumulator, createIdleWatchdog, interpretStreamEnd } from '../sse-stream'

describe('interpretStreamEnd', () => {
  it('is ok only when a done event was seen', () => {
    expect(interpretStreamEnd(true)).toBe('ok')
  })

  it('is incomplete when the stream ended without a done event (dropped connection)', () => {
    // The core bug: server dies mid-stream, reader returns done:true cleanly,
    // no `done` event was ever delivered → the reply is truncated, not complete.
    expect(interpretStreamEnd(false)).toBe('incomplete')
  })
})

describe('SseEventAccumulator', () => {
  /** Collect every event produced by feeding `chunks` in order. */
  function drain(chunks: string[]) {
    const acc = new SseEventAccumulator()
    return chunks.flatMap((c) => acc.push(c))
  }

  it('parses a whole event delivered in one chunk', () => {
    expect(drain(['event: update\ndata: {"content":"hi"}\n\n'])).toEqual([
      { event: 'update', data: '{"content":"hi"}' },
    ])
  })

  it('keeps the terminal `done` event when TCP splits `event:` from `data:` (regression)', () => {
    // The bug: the parser reset eventType per chunk. A read boundary between the
    // `event: done` line and its `data:` line meant `data:` was parsed with an
    // empty eventType → the done event was dropped and the stream misreported as
    // a lost connection. The type must persist across the chunk boundary.
    const events = drain(['event: done\n', 'data: {"runId":"run_1"}\n\n'])
    expect(events).toEqual([{ event: 'done', data: '{"runId":"run_1"}' }])
  })

  it('handles a split in the MIDDLE of a line', () => {
    // A chunk boundary can fall inside a single line too — the partial line is
    // buffered until the newline arrives.
    const events = drain(['event: up', 'date\ndata: {"content":"x"}\n\n'])
    expect(events).toEqual([{ event: 'update', data: '{"content":"x"}' }])
  })

  it('resets the event type at the blank line so events do not bleed into each other', () => {
    const events = drain([
      'event: update\ndata: {"content":"a"}\n\n',
      // No `event:` line here — a per-event reset means this data has an EMPTY
      // type, NOT the stale `update` from the previous event.
      'data: {"orphan":true}\n\n',
    ])
    expect(events).toEqual([
      { event: 'update', data: '{"content":"a"}' },
      { event: '', data: '{"orphan":true}' },
    ])
  })

  it('emits multiple events across several chunks in order', () => {
    const events = drain([
      'event: update\ndata: {"content":"a"}\n\n',
      'event: log\ndata: {"line":"1"}\n\n',
      'event: done\ndata: {"runId":"r"}\n\n',
    ])
    expect(events.map((e) => e.event)).toEqual(['update', 'log', 'done'])
  })

  it('surfaces server heartbeat events with empty data (keepalive, ignored downstream)', () => {
    // The server sends `event: heartbeat\ndata: \n\n` every 30s so the client
    // idle watchdog does not trip on a quiet-but-alive run. The accumulator emits
    // it like any event; the consumer ignores unknown types (and empty data fails
    // JSON.parse → skipped), while reading the chunk already reset the watchdog.
    const events = drain(['event: heartbeat\ndata: \n\n', 'event: done\ndata: {"runId":"r"}\n\n'])
    expect(events).toEqual([
      { event: 'heartbeat', data: '' },
      { event: 'done', data: '{"runId":"r"}' },
    ])
  })
})

describe('createIdleWatchdog', () => {
  function fakeTimers() {
    let seq = 0
    const scheduled = new Map<number, { fn: () => void; ms: number }>()
    return {
      scheduled,
      setTimer: (fn: () => void, ms: number) => {
        const id = ++seq
        scheduled.set(id, { fn, ms })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (handle: ReturnType<typeof setTimeout>) => {
        scheduled.delete(handle as unknown as number)
      },
      fire: (id: number) => scheduled.get(id)?.fn(),
    }
  }

  it('calls onIdle when no kick arrives within idleMs', () => {
    const timers = fakeTimers()
    const onIdle = vi.fn()
    createIdleWatchdog(5000, onIdle, timers)

    // One timer armed on construction; fire it (simulates idleMs elapsed).
    expect(timers.scheduled.size).toBe(1)
    timers.fire(1)
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('kick() resets the timer so a live stream never trips the watchdog', () => {
    const timers = fakeTimers()
    const onIdle = vi.fn()
    const wd = createIdleWatchdog(5000, onIdle, timers)

    // Original timer (id 1) should be cleared and a fresh one armed on kick.
    wd.kick()
    expect(timers.scheduled.has(1)).toBe(false)
    // Firing the stale timer must do nothing (it was cleared).
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('clear() disarms the watchdog (finally path)', () => {
    const timers = fakeTimers()
    const onIdle = vi.fn()
    const wd = createIdleWatchdog(5000, onIdle, timers)
    wd.clear()
    expect(timers.scheduled.size).toBe(0)
  })
})
