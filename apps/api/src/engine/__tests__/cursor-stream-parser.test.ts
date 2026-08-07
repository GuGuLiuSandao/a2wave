import { describe, expect, it } from 'vitest'
import {
  type ParsedCursorEvent,
  parseCursorStreamLine,
  statKeyFor,
} from '../cursor-stream-parser.js'

/** Convenience wrapper: many tests only care about the events list. */
const events = (line: string): ParsedCursorEvent[] => parseCursorStreamLine(line).events

describe('parseCursorStreamLine — events', () => {
  it('returns non_json for invalid JSON', async () => {
    expect(events('not json')).toEqual([{ kind: 'non_json' }])
    expect(events('')).toEqual([{ kind: 'non_json' }])
  })

  it('emits session event when session_id present', async () => {
    const evs = events(JSON.stringify({ session_id: 'sess_1', type: 'system', subtype: 'init' }))
    expect(evs[0]).toEqual({ kind: 'session', chatId: 'sess_1' })
    expect(evs[1]).toEqual({ kind: 'system_init', model: undefined })
  })

  it('emits session event when chat_id present (alternative key)', async () => {
    const evs = events(JSON.stringify({ chat_id: 'chat_2', type: 'user' }))
    expect(evs[0]).toEqual({ kind: 'session', chatId: 'chat_2' })
  })

  it('parses system:init with model', async () => {
    expect(
      events(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet' })),
    ).toEqual([{ kind: 'system_init', model: 'claude-sonnet' }])
  })

  it('parses user message', async () => {
    expect(events(JSON.stringify({ type: 'user' }))).toEqual([{ kind: 'user' }])
  })

  it('parses assistant text block', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello world' }] },
        }),
      ),
    ).toEqual([{ kind: 'assistant_text', text: 'Hello world', blockIndex: 0 }])
  })

  it('parses assistant tool_use (started — no result yet)', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/a' } }],
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'assistant_tool_use',
        toolName: 'read_file',
        callId: 'call_1',
        input: { path: '/a' },
        subtype: 'started',
        blockIndex: 0,
      },
    ])
  })

  it('parses assistant tool_use (completed — result present, no error)', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'call_2',
                name: 'read_file',
                input: { path: '/a', result: { content: 'file body' } },
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'assistant_tool_use',
        toolName: 'read_file',
        callId: 'call_2',
        input: { path: '/a' }, // result stripped
        subtype: 'completed',
        blockIndex: 0,
      },
    ])
  })

  it('parses assistant tool_use (failed — result.error string)', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'call_3',
                name: 'run_cmd',
                input: { cmd: 'ls', result: { error: 'permission denied' } },
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'assistant_tool_use',
        toolName: 'run_cmd',
        callId: 'call_3',
        input: { cmd: 'ls' },
        subtype: 'failed',
        error: 'permission denied',
        blockIndex: 0,
      },
    ])
  })

  it('unwraps nested {error: {error: "..."}} on tool_use failed', async () => {
    const evs = events(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_4',
              name: 'x',
              input: { result: { error: { error: 'inner msg' } } },
            },
          ],
        },
      }),
    )
    expect((evs[0] as Extract<ParsedCursorEvent, { kind: 'assistant_tool_use' }>).error).toBe(
      'inner msg',
    )
  })

  it('parses multiple content blocks in one assistant message', async () => {
    const evs = events(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking out loud' },
            { type: 'tool_use', id: 'call_5', name: 'tool_a', input: {} },
          ],
        },
      }),
    )
    expect(evs).toHaveLength(2)
    expect(evs[0]).toEqual({ kind: 'assistant_text', text: 'thinking out loud', blockIndex: 0 })
    expect(evs[1]).toEqual({
      kind: 'assistant_tool_use',
      toolName: 'tool_a',
      callId: 'call_5',
      input: undefined,
      subtype: 'started',
      blockIndex: 1,
    })
  })

  it('parses result:success and trims trailing whitespace', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: '  done  \n',
          duration_ms: 1234,
        }),
      ),
    ).toEqual([{ kind: 'result_success', text: 'done', durationMs: 1234 }])
  })

  it('passes result usage through to the result_success event', async () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56 },
    })
    const { events: evs } = parseCursorStreamLine(line)
    const success = evs.find((e) => e.kind === 'result_success')
    expect(success).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 56 },
    })
  })

  it('leaves result_success usage undefined when the result omits it', async () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })
    const { events: evs } = parseCursorStreamLine(line)
    const success = evs.find((e) => e.kind === 'result_success')
    expect(success && 'usage' in success ? success.usage : undefined).toBeUndefined()
  })

  it('parses result:error', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'result',
          subtype: 'error',
          error: 'cursor crashed',
        }),
      ),
    ).toEqual([{ kind: 'result_other', subtype: 'error', error: 'cursor crashed' }])
  })

  it('extracts usage from error results', async () => {
    const evs = events(
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        error: 'rate limited',
        usage: { input_tokens: 50000, output_tokens: 120 },
      }),
    )
    expect(evs).toEqual([
      {
        kind: 'result_other',
        subtype: 'error',
        error: 'rate limited',
        usage: { inputTokens: 50000, outputTokens: 120 },
      },
    ])
  })

  it('result with missing subtype is passed through as undefined (engine applies fallback)', async () => {
    // Original cursor-agent.ts uses raw subtype in logger.warn template
    // (renders "undefined") but applies `subtype || 'error'` only at the
    // onLogEntry call site. Parser must NOT pre-fallback so engine can mirror
    // that asymmetry.
    expect(events(JSON.stringify({ type: 'result' }))).toEqual([{ kind: 'result_other' }])
  })

  it('parses thinking block (no payload)', async () => {
    expect(events(JSON.stringify({ type: 'thinking' }))).toEqual([{ kind: 'thinking' }])
  })

  it('parses top-level tool_call with nested cursor shape (started)', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'tc_1',
          tool_call: { ReadFileToolCall: { args: { path: '/x' } } },
        }),
      ),
    ).toEqual([
      {
        kind: 'tool_call',
        toolName: 'ReadFile',
        callId: 'tc_1',
        input: { path: '/x' },
        subtype: 'started',
      },
    ])
  })

  it('parses tool_call completed with inner error → marked failed', async () => {
    const evs = events(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tc_2',
        tool_call: {
          RunCmdToolCall: { args: { cmd: 'ls' }, result: { error: 'permission denied' } },
        },
      }),
    )
    expect(evs[0]).toMatchObject({
      kind: 'tool_call',
      toolName: 'RunCmd',
      callId: 'tc_2',
      input: { cmd: 'ls' },
      subtype: 'failed',
      error: 'permission denied',
    })
  })

  it('parses tool_result with toolName from data.tool_call key', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'tool_result',
          call_id: 'tr_1',
          is_error: false,
          tool_call: { ReadFileToolCall: {} },
        }),
      ),
    ).toEqual([{ kind: 'tool_result', toolName: 'ReadFile', callId: 'tr_1', isError: false }])
  })

  it('parses tool_result error', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'tool_result',
          tool_name: 'broken',
          call_id: 'tr_2',
          is_error: true,
        }),
      ),
    ).toEqual([{ kind: 'tool_result', toolName: 'broken', callId: 'tr_2', isError: true }])
  })

  it('tool_result without is_error field has isError undefined (NOT coerced to false)', async () => {
    // Original cursor-agent.ts logged `isError: data.is_error as boolean | undefined`,
    // so missing field landed as undefined. Boolean(data.is_error) would silently
    // change the logger tag value from absent → false.
    const evs = events(
      JSON.stringify({
        type: 'tool_result',
        tool_name: 'noflag',
        call_id: 'tr_3',
      }),
    )
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'tool_result', toolName: 'noflag', callId: 'tr_3' })
    expect((evs[0] as Extract<ParsedCursorEvent, { kind: 'tool_result' }>).isError).toBeUndefined()
  })

  it('parses error message from data.error', async () => {
    expect(events(JSON.stringify({ type: 'error', error: 'boom' }))).toEqual([
      { kind: 'error', message: 'boom' },
    ])
  })

  it('parses error message from data.message fallback', async () => {
    expect(events(JSON.stringify({ type: 'error', message: 'boom2' }))).toEqual([
      { kind: 'error', message: 'boom2' },
    ])
  })

  it('emits unknown for unrecognized message type', async () => {
    expect(events(JSON.stringify({ type: 'mystery', subtype: 'foo' }))).toEqual([
      { kind: 'unknown', msgType: 'mystery', subtype: 'foo' },
    ])
  })

  it('full sequence: init → assistant text → tool_use completed → result success', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'on it' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'c1', name: 'read', input: { path: '/a', result: { ok: 1 } } },
          ],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'all done', duration_ms: 100 }),
    ]
    const evs = lines.flatMap((l) => events(l))
    expect(evs.map((e) => e.kind)).toEqual([
      'system_init',
      'assistant_text',
      'assistant_tool_use',
      'result_success',
    ])
  })
})

// ---------------------------------------------------------------------------
// Raw msgType / subtype exposure — load-bearing for engine stat counting.
// (Without these, an `assistant` line with N content blocks would be counted
// N times and a `tool_call:completed` whose inner result has `error` would
// silently shift to `tool_call:failed` in stats.)
// ---------------------------------------------------------------------------
describe('parseCursorStreamLine — raw line metadata for stat counting', () => {
  it('exposes msgType and subtype from the raw JSON line', async () => {
    const r = parseCursorStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))
    expect(r.msgType).toBe('system')
    expect(r.subtype).toBe('init')
  })

  it('msgType only when subtype absent', async () => {
    const r = parseCursorStreamLine(JSON.stringify({ type: 'user' }))
    expect(r.msgType).toBe('user')
    expect(r.subtype).toBeUndefined()
  })

  it('non-JSON line has no msgType / subtype', async () => {
    const r = parseCursorStreamLine('not json')
    expect(r.msgType).toBeUndefined()
    expect(r.subtype).toBeUndefined()
    expect(r.events).toEqual([{ kind: 'non_json' }])
  })

  it('assistant line with multiple blocks still reports msgType=assistant once (single line = single stat)', async () => {
    const r = parseCursorStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
            { type: 'tool_use', id: 'c', name: 'x', input: {} },
          ],
        },
      }),
    )
    expect(r.msgType).toBe('assistant')
    expect(r.subtype).toBeUndefined()
    expect(r.events).toHaveLength(3) // events expand per-block
  })

  it('tool_call with hasError reports raw subtype="completed" (NOT the failure-rewritten event subtype)', async () => {
    // Stat key must match the original semantics: this line increments
    // tool_call:completed even though the dispatched event is subtype=failed.
    const r = parseCursorStreamLine(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tc_x',
        tool_call: { RunCmdToolCall: { args: {}, result: { error: 'boom' } } },
      }),
    )
    expect(r.msgType).toBe('tool_call')
    expect(r.subtype).toBe('completed')
    // Dispatched event is failed — verify the parser correctly separates the two
    expect((r.events[0] as Extract<ParsedCursorEvent, { kind: 'tool_call' }>).subtype).toBe(
      'failed',
    )
  })

  it('result line without subtype reports msgType=result, subtype=undefined (engine renders "result", not "result:error")', async () => {
    // Original cursor-agent.ts: messageStats[subtype ? `${msgType}:${subtype}` : msgType]
    // → bare `result` key when raw subtype is missing. Must NOT pre-fallback.
    const r = parseCursorStreamLine(JSON.stringify({ type: 'result' }))
    expect(r.msgType).toBe('result')
    expect(r.subtype).toBeUndefined()
  })

  it('system line with non-init subtype still reports msgType=system, subtype=<value> (events may be empty)', async () => {
    // Even when the parser switch produces no event (because parser only emits
    // system_init for subtype === 'init'), the raw msgType/subtype must be
    // returned so the engine still increments messageStats[`system:${subtype}`].
    const r = parseCursorStreamLine(JSON.stringify({ type: 'system', subtype: 'shutdown' }))
    expect(r.msgType).toBe('system')
    expect(r.subtype).toBe('shutdown')
    // Engine sees no dispatch event for this line — only the stat tag survives
    expect(r.events).toEqual([])
  })
})

describe('statKeyFor', () => {
  it('returns msgType when no subtype', async () => {
    expect(statKeyFor('assistant')).toBe('assistant')
  })
  it('joins msgType:subtype when subtype present', async () => {
    expect(statKeyFor('result', 'success')).toBe('result:success')
  })
  it('treats undefined subtype as no subtype', async () => {
    expect(statKeyFor('thinking', undefined)).toBe('thinking')
  })
})
