import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHeartbeatTracker } from '../heartbeat.js'
import type { StreamLogEntry } from '../types.js'

describe('createHeartbeatTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits a heartbeat per interval for each open call', async () => {
    const entries: StreamLogEntry[] = []
    const tracker = createHeartbeatTracker({
      intervalMs: 10_000,
      emit: (e) => entries.push(e),
    })

    tracker.onStarted('call_1', 'Bash')
    tracker.onStarted('call_2', 'Read')

    vi.advanceTimersByTime(10_000)
    expect(entries.filter((e) => e.type === 'tool_heartbeat')).toHaveLength(2)

    vi.advanceTimersByTime(10_000)
    expect(entries.filter((e) => e.type === 'tool_heartbeat')).toHaveLength(4)
  })

  it('stops heartbeats for a settled call', async () => {
    const entries: StreamLogEntry[] = []
    const tracker = createHeartbeatTracker({
      intervalMs: 5_000,
      emit: (e) => entries.push(e),
    })

    tracker.onStarted('call_1', 'Bash')
    vi.advanceTimersByTime(5_000)
    expect(entries).toHaveLength(1)

    tracker.onSettled('call_1')
    vi.advanceTimersByTime(20_000)
    expect(entries).toHaveLength(1)
  })

  it('stop() clears the timer and discards pending state', async () => {
    const entries: StreamLogEntry[] = []
    const tracker = createHeartbeatTracker({
      intervalMs: 1_000,
      emit: (e) => entries.push(e),
    })

    tracker.onStarted('call_1', 'Bash')
    tracker.stop()
    vi.advanceTimersByTime(10_000)
    expect(entries).toHaveLength(0)
  })

  it('reports elapsed time that grows monotonically', async () => {
    const entries: StreamLogEntry[] = []
    const tracker = createHeartbeatTracker({
      intervalMs: 3_000,
      emit: (e) => entries.push(e),
    })

    tracker.onStarted('call_1', 'Bash')
    vi.advanceTimersByTime(3_000)
    vi.advanceTimersByTime(3_000)
    vi.advanceTimersByTime(3_000)

    const heartbeats = entries.filter((e) => e.type === 'tool_heartbeat') as Array<
      Extract<StreamLogEntry, { type: 'tool_heartbeat' }>
    >
    expect(heartbeats).toHaveLength(3)
    expect(heartbeats[0].elapsedMs).toBeGreaterThanOrEqual(3_000)
    expect(heartbeats[1].elapsedMs).toBeGreaterThan(heartbeats[0].elapsedMs)
    expect(heartbeats[2].elapsedMs).toBeGreaterThan(heartbeats[1].elapsedMs)
  })
})
