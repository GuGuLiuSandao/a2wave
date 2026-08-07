import { describe, expect, it, vi } from 'vitest'
import { createPiStreamParser } from '../pi-stream-parser.js'
import type { StreamLogEntry } from '../types.js'

function setup() {
  const entries: StreamLogEntry[] = []
  const updates: string[] = []
  const heartbeatCalls: string[] = []
  const parser = createPiStreamParser({
    onUpdate: (text) => updates.push(text),
    onLogEntry: (entry) => entries.push(entry),
    heartbeat: {
      onStarted: (id) => heartbeatCalls.push(`start:${id}`),
      onSettled: (id) => heartbeatCalls.push(`settle:${id}`),
      stop: vi.fn(),
    },
  })
  return { parser, entries, updates, heartbeatCalls }
}

function row(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function assistantMessage(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: { input: 10, output: 7, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
    stopReason: 'stop',
    ...overrides,
  }
}

describe('createPiStreamParser', () => {
  it('replays session, assistant, tool and terminal events', async () => {
    const { parser, entries, heartbeatCalls, updates } = setup()

    parser.parseLine(row({ type: 'session', version: 3, id: 'pi-session-1', cwd: '/work' }))
    parser.parseLine(row({ type: 'message_start', message: assistantMessage('') }))
    parser.parseLine(
      row({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
      }),
    )
    parser.parseLine(
      row({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read',
        args: { path: 'README.md' },
      }),
    )
    parser.parseLine(
      row({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'contents' }] },
        isError: false,
      }),
    )
    parser.parseLine(row({ type: 'message_end', message: assistantMessage('Hello') }))
    // `agent_end` is not terminal: Pi can still retry or compact after it.
    parser.parseLine(row({ type: 'agent_end', messages: [], willRetry: false }))
    expect(parser.state.resultReceived).toBe(false)
    parser.parseLine(row({ type: 'agent_settled' }))

    expect(parser.state).toMatchObject({
      sessionId: 'pi-session-1',
      outputBuffer: 'Hello',
      resultReceived: true,
      resultIsError: false,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
    })
    expect(updates.at(-1)).toBe('Hello')
    expect(heartbeatCalls).toEqual(['start:tool-1', 'settle:tool-1'])
    expect(entries.filter((entry) => entry.type === 'tool_call')).toMatchObject([
      { subtype: 'started', callId: 'tool-1', toolName: 'read', input: { path: 'README.md' } },
      { subtype: 'completed', callId: 'tool-1', toolName: 'read' },
    ])
    expect(entries.at(-1)).toMatchObject({ type: 'result', subtype: 'success' })
  })

  it('accumulates usage across tool turns without double-counting reasoning', async () => {
    const { parser } = setup()

    parser.parseLine(row({ type: 'message_end', message: assistantMessage('First') }))
    parser.parseLine(
      row({
        type: 'message_end',
        message: assistantMessage('Second', {
          usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0 },
        }),
      }),
    )
    parser.parseLine(row({ type: 'agent_settled' }))

    expect(parser.state.outputBuffer).toBe('First\nSecond')
    expect(parser.state.usage).toEqual({
      inputTokens: 14,
      outputTokens: 8,
      reasoningTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    })
  })

  it('includes automatic compaction model usage in the run total', async () => {
    const { parser } = setup()

    parser.parseLine(row({ type: 'message_end', message: assistantMessage('Before compaction') }))
    parser.parseLine(
      row({
        type: 'compaction_end',
        result: {
          summary: 'Condensed context',
          firstKeptEntryId: 'entry-1',
          tokensBefore: 120_000,
          usage: { input: 20, output: 8, reasoning: 3, cacheRead: 4, cacheWrite: 2 },
        },
      }),
    )
    parser.parseLine(row({ type: 'agent_settled' }))

    expect(parser.state.usage).toEqual({
      inputTokens: 30,
      outputTokens: 10,
      reasoningTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
    })
  })

  it('drops a failed partial response and accepts Pi automatic retry recovery', async () => {
    const { parser, entries } = setup()

    parser.parseLine(
      row({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'partial secret' },
      }),
    )
    parser.parseLine(
      row({
        type: 'message_end',
        message: assistantMessage('partial secret', {
          stopReason: 'error',
          errorMessage: 'rate limited',
        }),
      }),
    )
    parser.parseLine(row({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 250 }))
    parser.parseLine(row({ type: 'message_end', message: assistantMessage('Recovered') }))
    // Pi emits the successful message before its explicit retry completion.
    expect(parser.state.resultIsError).toBe(true)
    parser.parseLine(row({ type: 'auto_retry_end', success: true, attempt: 1 }))
    parser.parseLine(row({ type: 'agent_settled' }))

    expect(parser.state.resultIsError).toBe(false)
    expect(parser.state.resultErrorText).toBe('')
    expect(parser.state.outputBuffer).toBe('Recovered')
    expect(entries).toContainEqual(
      expect.objectContaining({ type: 'retry', attempt: 1, nextAttemptIn: 250 }),
    )
  })

  it('keeps a final assistant error fatal even without a non-zero process exit', async () => {
    const { parser, entries } = setup()

    parser.parseLine(
      row({
        type: 'message_end',
        message: assistantMessage('', {
          stopReason: 'error',
          errorMessage: 'invalid credentials',
        }),
      }),
    )
    parser.parseLine(row({ type: 'agent_settled' }))

    expect(parser.state).toMatchObject({
      resultReceived: true,
      resultIsError: true,
      resultErrorText: 'invalid credentials',
    })
    expect(entries.at(-1)).toMatchObject({ type: 'result', subtype: 'error' })
  })

  it('does not let an unrelated successful assistant message hide a fatal error', async () => {
    const { parser } = setup()

    parser.parseLine(
      row({
        type: 'message_end',
        message: assistantMessage('', {
          stopReason: 'error',
          errorMessage: 'auth failed',
        }),
      }),
    )
    parser.parseLine(row({ type: 'message_end', message: assistantMessage('bye') }))
    parser.parseLine(row({ type: 'agent_settled' }))

    expect(parser.state).toMatchObject({
      outputBuffer: 'bye',
      resultReceived: true,
      resultIsError: true,
      resultErrorText: 'auth failed',
    })
  })

  it('requires an active automatic retry before a success event can clear an error', async () => {
    const { parser } = setup()

    parser.parseLine(
      row({
        type: 'message_end',
        message: assistantMessage('', {
          stopReason: 'error',
          errorMessage: 'auth failed',
        }),
      }),
    )
    parser.parseLine(row({ type: 'auto_retry_end', success: true, attempt: 1 }))
    parser.parseLine(row({ type: 'agent_settled' }))

    expect(parser.state).toMatchObject({
      resultReceived: true,
      resultIsError: true,
      resultErrorText: 'auth failed',
    })
  })

  it('accepts a successful assistant response after explicit overflow compaction recovery', async () => {
    const { parser } = setup()

    parser.parseLine(
      row({
        type: 'message_end',
        message: assistantMessage('', {
          stopReason: 'error',
          errorMessage: 'context_length_exceeded',
        }),
      }),
    )
    parser.parseLine(
      row({
        type: 'compaction_end',
        reason: 'overflow',
        result: { usage: { input: 20, output: 8 } },
        aborted: false,
        willRetry: true,
      }),
    )
    parser.parseLine(row({ type: 'message_end', message: assistantMessage('Recovered') }))
    parser.parseLine(row({ type: 'agent_settled' }))

    expect(parser.state).toMatchObject({
      outputBuffer: 'Recovered',
      resultReceived: true,
      resultIsError: false,
      resultErrorText: '',
    })
  })

  it('excludes thinking blocks and ignores malformed rows', async () => {
    const { parser } = setup()

    parser.parseLine('not json')
    parser.parseLine('[]')
    parser.parseLine(
      row({
        type: 'message_end',
        message: assistantMessage('', {
          content: [
            { type: 'thinking', thinking: 'private reasoning' },
            { type: 'text', text: 'public answer' },
          ],
        }),
      }),
    )

    expect(parser.state.outputBuffer).toBe('public answer')
  })

  it('marks failed tools in logs without making a recoverable tool error fatal', async () => {
    const { parser, entries } = setup()

    parser.parseLine(
      row({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'grep', args: {} }),
    )
    parser.parseLine(
      row({
        type: 'tool_execution_end',
        toolCallId: 't2',
        toolName: 'grep',
        result: { content: [{ type: 'text', text: 'file not found' }] },
        isError: true,
      }),
    )

    expect(parser.state.resultIsError).toBe(false)
    expect(entries.at(-1)).toMatchObject({
      type: 'tool_call',
      subtype: 'failed',
      callId: 't2',
      error: 'file not found',
    })
  })
})
