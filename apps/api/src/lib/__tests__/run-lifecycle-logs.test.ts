import { describe, expect, it } from 'vitest'
import type { StreamLogEntry } from '../../engine/types.js'
import { createLogCollector, sanitizeLogsForStorage } from '../run-lifecycle.js'

describe('createLogCollector', () => {
  it('collects log entries up to the limit', async () => {
    const { logs, onLogEntry } = createLogCollector()

    for (let i = 0; i < 10; i++) {
      onLogEntry({ type: 'assistant', text: `msg ${i}`, ts: Date.now() })
    }

    expect(logs).toHaveLength(10)
  })

  it('adds truncation marker when limit is exceeded', async () => {
    const { logs, onLogEntry } = createLogCollector()

    // Fill to capacity (1000) + 1 extra
    for (let i = 0; i < 1002; i++) {
      onLogEntry({ type: 'assistant', text: `msg ${i}`, ts: Date.now() })
    }

    // 1000 entries + 1 truncation marker = 1001
    expect(logs).toHaveLength(1001)
    const last = logs[logs.length - 1]
    expect(last.type).toBe('system')
    expect((last as { subtype: string }).subtype).toBe('truncated')
  })

  it('only adds one truncation marker regardless of overflow count', async () => {
    const { logs, onLogEntry } = createLogCollector()

    for (let i = 0; i < 1100; i++) {
      onLogEntry({ type: 'assistant', text: `msg ${i}`, ts: Date.now() })
    }

    expect(logs).toHaveLength(1001)
    const truncatedEntries = logs.filter(
      (e) => e.type === 'system' && (e as { subtype: string }).subtype === 'truncated',
    )
    expect(truncatedEntries).toHaveLength(1)
  })
})

describe('sanitizeLogsForStorage', () => {
  it('passes through small tool_call inputs', async () => {
    const logs: StreamLogEntry[] = [
      {
        type: 'tool_call',
        subtype: 'started',
        callId: '1',
        toolName: 'read',
        input: { path: '/tmp/x' },
        ts: 1,
      },
    ]
    const result = sanitizeLogsForStorage(logs)
    expect(result[0]).toEqual(logs[0])
  })

  it('truncates large tool_call inputs', async () => {
    const largeInput: Record<string, unknown> = { data: 'x'.repeat(3000) }
    const logs: StreamLogEntry[] = [
      {
        type: 'tool_call',
        subtype: 'completed',
        callId: '2',
        toolName: 'shell',
        input: largeInput,
        ts: 1,
      },
    ]
    const result = sanitizeLogsForStorage(logs)
    const entry = result[0] as { input?: Record<string, unknown> }
    expect(entry.input).toHaveProperty('_truncated', true)
    expect(entry.input).toHaveProperty('_length')
  })

  it('does not modify non-tool_call entries', async () => {
    const logs: StreamLogEntry[] = [
      { type: 'assistant', text: 'hello', ts: 1 },
      { type: 'result', subtype: 'success', durationMs: 100, ts: 2 },
    ]
    const result = sanitizeLogsForStorage(logs)
    expect(result).toEqual(logs)
  })
})
