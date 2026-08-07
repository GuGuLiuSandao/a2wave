/**
 * Pure parser for OpenCode CLI's `opencode run --format json` stream output lines.
 *
 * Mirrors the shape of `cursor-stream-parser.ts` / `codex-stream-parser.ts`:
 * side-effect free, takes a single NDJSON line and returns a normalized event
 * list. The caller (opencode-agent.ts) owns logging, callback invocation, and
 * mutable state.
 *
 * OpenCode（1.18.x 实测）的事件为 `{ type, timestamp, sessionID, part }`：
 *
 *   - step_start  → part.type='step-start'，一个推理步开始
 *   - text        → part.type='text'，assistant 文本（完整段落，非增量 token）
 *   - tool_use    → part.type='tool'，工具调用；input/output/status/耗时
 *                   自包含在 part.state 里（无需 callID 关联起止两条事件）
 *   - step_finish → part.type='step-finish'，携带 reason + tokens + cost
 *   - error       → 流级错误 `{ error: { name, data: { message } } }`，进程随即退出
 *
 * ⚠️ 终态判定：`step_finish` 不等于 run 结束——工具调用回合会先发一次
 * `reason='tool-calls'` 的 step_finish 再继续下一步。只有 `reason='stop'`
 * 才是最终完成（`final: true`）；caller 仍应以进程退出作最终兜底。
 */

/** step_finish 携带的 token 用量（OpenCode 原生提供，无需自算）。 */
export interface OpencodeUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Normalized event types emitted by the parser. */
export type ParsedOpencodeEvent =
  /** Non-JSON line — caller should ignore but may want to log. */
  | { kind: 'non_json' }
  /** Unrecognized JSON message type — caller may debug-log. */
  | { kind: 'unknown'; msgType: string; subtype?: string }
  /** A reasoning step started. */
  | { kind: 'step_started' }
  /** A reasoning step finished; `final` is true only for reason='stop'. */
  | {
      kind: 'step_finished'
      reason?: string
      final: boolean
      usage?: OpencodeUsage
      cost?: number
    }
  /** Assistant text (complete paragraph). */
  | { kind: 'assistant_text'; text: string }
  /** Self-contained tool call (input + status + optional error in one event). */
  | {
      kind: 'tool_call'
      toolName: string
      callId: string
      subtype: 'started' | 'completed' | 'failed'
      input?: Record<string, unknown>
      error?: string
    }
  /** Stream-level error — the CLI process exits right after. */
  | { kind: 'error'; message: string }

export interface ParsedOpencodeLine {
  events: ParsedOpencodeEvent[]
  /** Raw top-level `type` field value (e.g. 'step_finish'). */
  msgType?: string
  /** Top-level sessionID — present on every event line; caller uses it for `--session` resume. */
  sessionId?: string
}

/** Map OpenCode tool state.status to the normalized tool_call subtype. */
function toolSubtype(status: unknown): 'started' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed'
  if (status === 'error') return 'failed'
  // pending / running / 其他未知状态一律视为进行中
  return 'started'
}

/** Extract usage from a step-finish part's `tokens` field. */
function extractUsage(part: Record<string, unknown>): OpencodeUsage | undefined {
  const tokens = part.tokens as Record<string, unknown> | undefined
  if (!tokens || typeof tokens !== 'object') return undefined
  const usage: OpencodeUsage = {}
  if (typeof tokens.input === 'number') usage.inputTokens = tokens.input
  if (typeof tokens.output === 'number') usage.outputTokens = tokens.output
  if (typeof tokens.reasoning === 'number') usage.reasoningTokens = tokens.reasoning
  if (typeof tokens.total === 'number') usage.totalTokens = tokens.total
  const cache = tokens.cache as Record<string, unknown> | undefined
  if (cache && typeof cache === 'object') {
    if (typeof cache.read === 'number') usage.cacheReadTokens = cache.read
    if (typeof cache.write === 'number') usage.cacheWriteTokens = cache.write
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/** Extract a human-readable message from the stream-level `error` payload. */
function extractErrorMessage(raw: unknown): string {
  if (typeof raw === 'string' && raw) return raw
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const data = obj.data as Record<string, unknown> | undefined
    if (data && typeof data.message === 'string' && data.message) return data.message
    if (typeof obj.message === 'string' && obj.message) return obj.message
    if (typeof obj.name === 'string' && obj.name) return obj.name
  }
  return 'Unknown opencode error'
}

/** Decode a tool_use line's part into a tool_call event. */
function parseToolPart(part: Record<string, unknown>): ParsedOpencodeEvent {
  const state = (part.state as Record<string, unknown>) || {}
  const subtype = toolSubtype(state.status)
  const input =
    state.input && typeof state.input === 'object'
      ? (state.input as Record<string, unknown>)
      : undefined
  const error = typeof state.error === 'string' && state.error ? state.error : undefined
  return {
    kind: 'tool_call',
    toolName: (part.tool as string) || 'unknown',
    callId: (part.callID as string) || '',
    subtype,
    ...(input ? { input } : {}),
    ...(error ? { error } : {}),
  }
}

/**
 * Parse one stdout line from `opencode run --format json`.
 *
 * Returns `{ events, msgType?, sessionId? }`:
 * - `events` — normalized events; non-JSON lines yield `[{kind: 'non_json'}]`.
 * - `msgType` — raw top-level `type` (e.g. 'step_finish').
 * - `sessionId` — top-level sessionID (present on every well-formed line);
 *   caller stores it as the chat id for `--session` resume.
 */
export function parseOpencodeStreamLine(line: string): ParsedOpencodeLine {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(line)
    if (!data || typeof data !== 'object') return { events: [{ kind: 'non_json' }] }
  } catch {
    return { events: [{ kind: 'non_json' }] }
  }

  const msgType = data.type as string | undefined
  const sessionId = typeof data.sessionID === 'string' ? data.sessionID : undefined
  const part = (data.part as Record<string, unknown>) || {}
  const events: ParsedOpencodeEvent[] = []

  switch (msgType) {
    case 'step_start':
      events.push({ kind: 'step_started' })
      break
    case 'step_finish': {
      const reason = typeof part.reason === 'string' ? part.reason : undefined
      const usage = extractUsage(part)
      const cost = typeof part.cost === 'number' ? part.cost : undefined
      events.push({
        kind: 'step_finished',
        reason,
        // ⚠️ 只有 reason='stop' 是最终完成；'tool-calls' 表示还会继续下一步。
        final: reason === 'stop',
        ...(usage ? { usage } : {}),
        ...(cost !== undefined ? { cost } : {}),
      })
      break
    }
    case 'text': {
      const text = typeof part.text === 'string' ? part.text : ''
      if (text) events.push({ kind: 'assistant_text', text })
      break
    }
    case 'tool_use':
      events.push(parseToolPart(part))
      break
    case 'error':
      events.push({ kind: 'error', message: extractErrorMessage(data.error) })
      break
    default:
      if (msgType) events.push({ kind: 'unknown', msgType })
      break
  }

  return { events, msgType, ...(sessionId ? { sessionId } : {}) }
}
