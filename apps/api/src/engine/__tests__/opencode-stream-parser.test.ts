import { describe, expect, it } from 'vitest'
import { type ParsedOpencodeEvent, parseOpencodeStreamLine } from '../opencode-stream-parser.js'

const events = (line: string): ParsedOpencodeEvent[] => parseOpencodeStreamLine(line).events

// ---------------------------------------------------------------------------
// 真实 fixture：均来自本机 opencode 1.18.2 `opencode run --format json` 实测输出
// ---------------------------------------------------------------------------

/** 简单文本回答的三行输出 */
const FIXTURE_STEP_START = JSON.stringify({
  type: 'step_start',
  timestamp: 1784197779206,
  sessionID: 'ses_0958684fcffeZxsAWmZ8f6NUrM',
  part: {
    id: 'prt_f6a798f03001DpYPO2YcKVwZ0U',
    messageID: 'msg_f6a797baa001JZ1V5J3tI2MhBW',
    sessionID: 'ses_0958684fcffeZxsAWmZ8f6NUrM',
    type: 'step-start',
  },
})

const FIXTURE_TEXT = JSON.stringify({
  type: 'text',
  timestamp: 1784197779410,
  sessionID: 'ses_0958684fcffeZxsAWmZ8f6NUrM',
  part: {
    id: 'prt_f6a798f0400153hBGROQTEdYiM',
    messageID: 'msg_f6a797baa001JZ1V5J3tI2MhBW',
    sessionID: 'ses_0958684fcffeZxsAWmZ8f6NUrM',
    type: 'text',
    text: '1+1等于2。',
    time: { start: 1784197779204, end: 1784197779401 },
  },
})

const FIXTURE_STEP_FINISH_STOP = JSON.stringify({
  type: 'step_finish',
  timestamp: 1784197779410,
  sessionID: 'ses_0958684fcffeZxsAWmZ8f6NUrM',
  part: {
    id: 'prt_f6a798fcc0018gm4dmViDcFSFv',
    reason: 'stop',
    messageID: 'msg_f6a797baa001JZ1V5J3tI2MhBW',
    sessionID: 'ses_0958684fcffeZxsAWmZ8f6NUrM',
    type: 'step-finish',
    tokens: {
      total: 11069,
      input: 11058,
      output: 11,
      reasoning: 0,
      cache: { write: 0, read: 0 },
    },
    cost: 0,
  },
})

/** 工具调用中场的 step_finish —— reason=tool-calls，不是终态 */
const FIXTURE_STEP_FINISH_TOOL_CALLS = JSON.stringify({
  type: 'step_finish',
  timestamp: 1784197805721,
  sessionID: 'ses_095861ce7ffeGjedx5GQ7emGoU',
  part: {
    id: 'prt_x',
    reason: 'tool-calls',
    messageID: 'msg_x',
    sessionID: 'ses_095861ce7ffeGjedx5GQ7emGoU',
    type: 'step-finish',
    tokens: {
      total: 11156,
      input: 11068,
      output: 67,
      reasoning: 21,
      cache: { write: 0, read: 0 },
    },
    cost: 0,
  },
})

/** 成功的工具调用：input+output+状态+耗时在同一事件中自包含 */
const FIXTURE_TOOL_USE_COMPLETED = JSON.stringify({
  type: 'tool_use',
  timestamp: 1784197805720,
  sessionID: 'ses_095861ce7ffeGjedx5GQ7emGoU',
  part: {
    type: 'tool',
    tool: 'read',
    callID: 'call_RnuqVPtTaAS0syrBvT0IzksS',
    state: {
      status: 'completed',
      input: { filePath: '/tmp/sample.txt', limit: 1 },
      output: '<content>hello</content>',
      metadata: { preview: 'hello' },
      title: 'tmp/sample.txt',
      time: { start: 1784197805710, end: 1784197805719 },
    },
    id: 'prt_f6a79f2d6001JENgsAdM32KE4v',
    sessionID: 'ses_095861ce7ffeGjedx5GQ7emGoU',
    messageID: 'msg_f6a79e3c6001HrlcH3gdrEwOxE',
  },
})

/** 失败的工具调用（权限被拒）：state.status = 'error' */
const FIXTURE_TOOL_USE_ERROR = JSON.stringify({
  type: 'tool_use',
  timestamp: 1784198900000,
  sessionID: 'ses_err',
  part: {
    type: 'tool',
    tool: 'read',
    callID: 'call_rejected',
    state: {
      status: 'error',
      input: { filePath: '/nonexistent/xyz.txt' },
      error: 'The user rejected permission to use this specific tool call.',
      time: { start: 1, end: 2 },
    },
    id: 'prt_err',
    sessionID: 'ses_err',
    messageID: 'msg_err',
  },
})

/** 流级错误（如模型不存在），进程随即 exit=1 */
const FIXTURE_ERROR = JSON.stringify({
  type: 'error',
  timestamp: 1784198832305,
  sessionID: 'ses_095765fedffeLQbmOLh3XPxR8U',
  error: {
    name: 'UnknownError',
    data: {
      message: 'Unexpected server error. Check server logs for details.',
      ref: 'err_3f32e2b1',
    },
  },
})

// ---------------------------------------------------------------------------

describe('parseOpencodeStreamLine — 基础', () => {
  it('非 JSON 行返回 non_json', async () => {
    expect(events('not json')).toEqual([{ kind: 'non_json' }])
    expect(events('')).toEqual([{ kind: 'non_json' }])
  })

  it('未知事件类型返回 unknown 并带 msgType', async () => {
    const evs = events(JSON.stringify({ type: 'future_event', sessionID: 'ses_x' }))
    expect(evs).toEqual([{ kind: 'unknown', msgType: 'future_event' }])
  })

  it('每行提取顶层 sessionID 供 caller 续接会话', async () => {
    const parsed = parseOpencodeStreamLine(FIXTURE_STEP_START)
    expect(parsed.sessionId).toBe('ses_0958684fcffeZxsAWmZ8f6NUrM')
  })

  it('无 sessionID 的行 sessionId 为 undefined', async () => {
    const parsed = parseOpencodeStreamLine(JSON.stringify({ type: 'step_start', part: {} }))
    expect(parsed.sessionId).toBeUndefined()
  })
})

describe('parseOpencodeStreamLine — step 生命周期', () => {
  it('解析 step_start', async () => {
    expect(events(FIXTURE_STEP_START)).toEqual([{ kind: 'step_started' }])
  })

  it('step_finish(reason=stop) 是终态，携带 usage + cost', async () => {
    const evs = events(FIXTURE_STEP_FINISH_STOP)
    expect(evs).toEqual([
      {
        kind: 'step_finished',
        reason: 'stop',
        final: true,
        usage: {
          inputTokens: 11058,
          outputTokens: 11,
          reasoningTokens: 0,
          totalTokens: 11069,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        cost: 0,
      },
    ])
  })

  it('step_finish(reason=tool-calls) 不是终态 —— final 必须为 false', async () => {
    const evs = events(FIXTURE_STEP_FINISH_TOOL_CALLS)
    expect(evs).toHaveLength(1)
    const ev = evs[0]
    expect(ev.kind).toBe('step_finished')
    if (ev.kind === 'step_finished') {
      expect(ev.reason).toBe('tool-calls')
      expect(ev.final).toBe(false)
      expect(ev.usage?.reasoningTokens).toBe(21)
    }
  })

  it('step_finish 缺 tokens 时 usage 为 undefined，不抛错', async () => {
    const evs = events(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_x',
        part: { type: 'step-finish', reason: 'stop' },
      }),
    )
    expect(evs).toEqual([{ kind: 'step_finished', reason: 'stop', final: true }])
  })
})

describe('parseOpencodeStreamLine — 文本', () => {
  it('解析 assistant 文本', async () => {
    expect(events(FIXTURE_TEXT)).toEqual([{ kind: 'assistant_text', text: '1+1等于2。' }])
  })

  it('空文本不产生事件', async () => {
    const evs = events(
      JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { type: 'text', text: '' } }),
    )
    expect(evs).toEqual([])
  })
})

describe('parseOpencodeStreamLine — 工具调用', () => {
  it('completed 工具调用：自包含 input/callId/toolName', async () => {
    const evs = events(FIXTURE_TOOL_USE_COMPLETED)
    expect(evs).toEqual([
      {
        kind: 'tool_call',
        toolName: 'read',
        callId: 'call_RnuqVPtTaAS0syrBvT0IzksS',
        subtype: 'completed',
        input: { filePath: '/tmp/sample.txt', limit: 1 },
      },
    ])
  })

  it('error 状态映射为 failed 并携带 error 信息', async () => {
    const evs = events(FIXTURE_TOOL_USE_ERROR)
    expect(evs).toEqual([
      {
        kind: 'tool_call',
        toolName: 'read',
        callId: 'call_rejected',
        subtype: 'failed',
        input: { filePath: '/nonexistent/xyz.txt' },
        error: 'The user rejected permission to use this specific tool call.',
      },
    ])
  })

  it('running/pending 状态映射为 started', async () => {
    for (const status of ['running', 'pending']) {
      const evs = events(
        JSON.stringify({
          type: 'tool_use',
          sessionID: 'ses_x',
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call_1',
            state: { status, input: { command: 'ls' } },
          },
        }),
      )
      expect(evs).toEqual([
        {
          kind: 'tool_call',
          toolName: 'bash',
          callId: 'call_1',
          subtype: 'started',
          input: { command: 'ls' },
        },
      ])
    }
  })
})

describe('parseOpencodeStreamLine — 错误', () => {
  it('流级 error 事件提取 error.data.message', async () => {
    expect(events(FIXTURE_ERROR)).toEqual([
      { kind: 'error', message: 'Unexpected server error. Check server logs for details.' },
    ])
  })

  it('error 缺 data.message 时回退到 name，再回退到默认文案', async () => {
    expect(
      events(JSON.stringify({ type: 'error', sessionID: 'ses_x', error: { name: 'AbortError' } })),
    ).toEqual([{ kind: 'error', message: 'AbortError' }])
    expect(events(JSON.stringify({ type: 'error', sessionID: 'ses_x' }))).toEqual([
      { kind: 'error', message: 'Unknown opencode error' },
    ])
  })
})

describe('parseOpencodeStreamLine — 完整会话回放', () => {
  it('工具调用会话:两次 step_finish 只有最后一次是 final', async () => {
    const lines = [
      FIXTURE_STEP_START,
      FIXTURE_TOOL_USE_COMPLETED,
      FIXTURE_STEP_FINISH_TOOL_CALLS,
      FIXTURE_STEP_START,
      FIXTURE_TEXT,
      FIXTURE_STEP_FINISH_STOP,
    ]
    const all = lines.flatMap((l) => events(l))
    const finals = all.filter((e) => e.kind === 'step_finished' && e.final)
    expect(finals).toHaveLength(1)
    const texts = all.filter((e) => e.kind === 'assistant_text')
    expect(texts).toHaveLength(1)
  })
})
