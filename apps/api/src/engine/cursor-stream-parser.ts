import type { TokenUsage } from './types.js'
import { extractClaudeStyleUsage } from './usage.js'

/**
 * Pure parser for cursor-agent CLI's stream-json output lines.
 *
 * Extracted from CursorAgentEngine.executeStreamWithModel for testability.
 * The parser is side-effect free: it takes a single JSON line of stdout and
 * returns a list of normalized events. The caller (cursor-agent.ts) owns
 * logging, callback invocation, and mutable state (textBuffer, dedup set).
 *
 * Returning an array (instead of one event) handles the `assistant` message
 * type that may carry multiple content blocks per JSON line.
 */

/** Normalized event types emitted by the parser. */
export type ParsedCursorEvent =
  /** Non-JSON line — caller should ignore but may want to log. */
  | { kind: 'non_json' }
  /** Unrecognized JSON message type — caller may debug-log. */
  | { kind: 'unknown'; msgType: string; subtype?: string }
  /** Session id surfaced from session_id / chat_id field. */
  | { kind: 'session'; chatId: string }
  /** system:init — agent boot. */
  | { kind: 'system_init'; model?: string }
  /** Plain user echo (no payload of interest). */
  | { kind: 'user' }
  /** Assistant text block — caller should append to textBuffer + onUpdate. */
  | { kind: 'assistant_text'; text: string; blockIndex: number }
  /** Assistant tool_use block. */
  | {
      kind: 'assistant_tool_use'
      toolName: string
      callId: string
      input?: Record<string, unknown>
      subtype: 'started' | 'completed' | 'failed'
      error?: string
      blockIndex: number
    }
  /** Final successful result with full text. */
  | { kind: 'result_success'; text: string; durationMs?: number; usage?: TokenUsage }
  /**
   * Non-success result (error, cancelled, etc.).
   *
   * `subtype` is the RAW subtype from the JSON line — may be `undefined`
   * when the line had no `subtype` field. Original cursor-agent.ts uses the
   * raw value in the `[RESULT] Non-success result: ${subtype}` log message
   * (which renders "Non-success result: undefined" if missing) but applies
   * `subtype || 'error'` only at the onLogEntry call site. The engine
   * preserves this asymmetry; the parser does NOT pre-fallback here.
   */
  | { kind: 'result_other'; subtype?: string; error?: string; usage?: TokenUsage }
  /** Thinking block — currently no observable effect. */
  | { kind: 'thinking' }
  /** Top-level tool_call event (not nested in assistant block). */
  | {
      kind: 'tool_call'
      toolName: string
      callId: string
      input?: Record<string, unknown>
      subtype: 'started' | 'completed' | 'failed'
      error?: string
    }
  /**
   * Top-level tool_result event.
   *
   * `isError` is intentionally `boolean | undefined` (NOT coerced to `false`)
   * to preserve the original cursor-agent.ts behavior of passing
   * `data.is_error as boolean | undefined` straight through to the logger
   * tag. The engine still treats undefined as "not error" when picking the
   * onLogEntry subtype (`ev.isError ? 'failed' : 'completed'` — falsy →
   * completed).
   */
  | { kind: 'tool_result'; toolName: string; callId: string; isError?: boolean }
  /** Stream-level error. */
  | { kind: 'error'; message: string }

/** Stat key in the format used by the engine's messageStats map. */
export function statKeyFor(msgType: string, subtype?: string): string {
  return subtype ? `${msgType}:${subtype}` : msgType
}

/**
 * Result returned by {@link parseCursorStreamLine}.
 *
 * `events` is the dispatch list. `msgType` / `subtype` carry the raw values
 * read off the JSON line (before any failure-detection rewriting that the
 * parser may apply to event subtypes — e.g. a tool_call whose inner result
 * carries `error` is emitted with `subtype: 'failed'` even though the JSON's
 * own `subtype` was `completed`).
 *
 * Engines should use the raw `msgType` / `subtype` for stat counting so a
 * single JSON line maps to a single stat increment, regardless of how many
 * dispatch events that line produces (e.g. an `assistant` line with N
 * content blocks emits N events but is still one logical message).
 */
export interface ParsedCursorLine {
  events: ParsedCursorEvent[]
  msgType?: string
  subtype?: string
}

/** Extract `chat_id` / `session_id` from a parsed JSON object, or undefined. */
function extractChatId(data: Record<string, unknown>): string | undefined {
  if (typeof data.session_id === 'string' && data.session_id) return data.session_id
  if (typeof data.chat_id === 'string' && data.chat_id) return data.chat_id
  return undefined
}

/** Unwrap nested `{error: {error: "..."}}` shapes into a single string. */
function normalizeToolError(raw: unknown): string | undefined {
  if (raw == null) return undefined
  let unwrapped: unknown = raw
  if (typeof unwrapped === 'object' && 'error' in (unwrapped as Record<string, unknown>)) {
    unwrapped = (unwrapped as Record<string, unknown>).error
  }
  if (unwrapped == null) return undefined
  return typeof unwrapped === 'string' ? unwrapped : JSON.stringify(unwrapped)
}

/** Decode an `assistant` message into one or more events (text + tool_use blocks). */
function parseAssistantMessage(data: Record<string, unknown>): ParsedCursorEvent[] {
  const events: ParsedCursorEvent[] = []
  const message = data.message as Record<string, unknown> | undefined
  if (!message) return events
  const contentArr = message.content as unknown[] | undefined
  if (!contentArr || contentArr.length === 0) return events

  for (let i = 0; i < contentArr.length; i++) {
    const block = contentArr[i] as Record<string, unknown>
    const blockType = (block.type as string) || 'unknown'

    if (typeof block.text === 'string' && block.text) {
      events.push({ kind: 'assistant_text', text: block.text, blockIndex: i })
      continue
    }

    if (blockType === 'tool_use') {
      const rawInput = block.input
      const fullInput =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : undefined
      // Cursor puts result inside the tool_use input when complete
      const hasResult = !!fullInput && 'result' in fullInput
      const innerResult = hasResult
        ? (fullInput?.result as Record<string, unknown> | undefined)
        : undefined
      const hasFailed =
        !!innerResult &&
        typeof innerResult === 'object' &&
        'error' in (innerResult as Record<string, unknown>)
      const subtype: 'started' | 'completed' | 'failed' = hasResult
        ? hasFailed
          ? 'failed'
          : 'completed'
        : 'started'

      // Strip 'result' key — keep only actual call parameters
      let input: Record<string, unknown> | undefined
      if (fullInput) {
        const { result: _r, ...params } = fullInput
        input = Object.keys(params).length > 0 ? params : undefined
      }

      const toolError = hasFailed ? normalizeToolError(innerResult?.error) : undefined

      events.push({
        kind: 'assistant_tool_use',
        toolName: (block.name as string) || 'unknown',
        callId: (block.id as string) || '',
        input,
        subtype,
        ...(toolError ? { error: toolError } : {}),
        blockIndex: i,
      })
    }
  }
  return events
}

/** Decode a top-level `tool_call` message. */
function parseToolCall(data: Record<string, unknown>, msgSubtype?: string): ParsedCursorEvent {
  const callId = (data.call_id as string) ?? (data.tool_call_id as string) ?? ''
  let toolName = (data.tool_name as string) ?? (data.name as string) ?? ''
  // Cursor nests tool data under data.tool_call.<toolName>ToolCall
  const toolCallObj = data.tool_call as Record<string, unknown> | undefined
  let toolCallInner: Record<string, unknown> | undefined
  if (toolCallObj && typeof toolCallObj === 'object') {
    const keys = Object.keys(toolCallObj)
    if (keys.length > 0) {
      if (!toolName) toolName = keys[0].replace(/ToolCall$/, '')
      toolCallInner = toolCallObj[keys[0]] as Record<string, unknown> | undefined
    }
  }
  toolName = toolName || 'unknown'

  // Extract input: prefer data.input, fallback to tool_call inner args
  let rawInput = data.input
  if (!rawInput && toolCallInner?.args && typeof toolCallInner.args === 'object') {
    rawInput = toolCallInner.args
  }
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined

  // Detect completed/failed from tool_call inner result OR input.result.error
  const innerResult = toolCallInner?.result as Record<string, unknown> | undefined
  const hasError =
    (msgSubtype === 'completed' && innerResult && 'error' in innerResult) ||
    (msgSubtype === 'completed' &&
      input &&
      'result' in input &&
      input.result &&
      typeof input.result === 'object' &&
      'error' in (input.result as Record<string, unknown>))

  const subtype: 'started' | 'completed' | 'failed' = hasError
    ? 'failed'
    : msgSubtype === 'started' || msgSubtype === 'completed'
      ? msgSubtype
      : 'started'

  const rawErr = innerResult?.error ?? (input?.result as Record<string, unknown> | undefined)?.error
  const error = hasError ? normalizeToolError(rawErr) : undefined

  return {
    kind: 'tool_call',
    toolName,
    callId,
    input,
    subtype,
    ...(error ? { error } : {}),
  }
}

/** Decode a top-level `tool_result` message. */
function parseToolResult(data: Record<string, unknown>): ParsedCursorEvent {
  let toolName = (data.tool_name as string) ?? (data.name as string) ?? ''
  if (!toolName && data.tool_call && typeof data.tool_call === 'object') {
    const keys = Object.keys(data.tool_call as Record<string, unknown>)
    if (keys.length > 0) {
      toolName = keys[0].replace(/ToolCall$/, '')
    }
  }
  toolName = toolName || 'unknown'
  // isError preserved as boolean | undefined to match original logger tag
  // (Boolean coercion would change `undefined` → `false`, drifting the tag).
  const isError = data.is_error as boolean | undefined
  const callId = (data.call_id as string) ?? (data.tool_call_id as string) ?? ''
  return { kind: 'tool_result', toolName, callId, ...(isError !== undefined ? { isError } : {}) }
}

/**
 * Parse one stdout line from cursor-agent stream-json mode.
 *
 * Returns `{ events, msgType?, subtype? }`:
 * - `events` — list of normalized events (always at least one; non-JSON lines
 *   yield `[{kind: 'non_json'}]`).
 * - `msgType` / `subtype` — raw values from the JSON line, exposed so callers
 *   can do per-line bookkeeping (e.g. stats counting) without mistakenly
 *   double-counting an `assistant` line that produced multiple events.
 *
 * The optional `session` event for `session_id` / `chat_id` is emitted before
 * the message-type event so the caller can update its chat id state first.
 */
export function parseCursorStreamLine(line: string): ParsedCursorLine {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(line)
  } catch {
    return { events: [{ kind: 'non_json' }] }
  }

  const msgType = data.type as string | undefined
  const subtype = data.subtype as string | undefined
  const events: ParsedCursorEvent[] = []

  const chatId = extractChatId(data)
  if (chatId) events.push({ kind: 'session', chatId })

  switch (msgType) {
    case 'system':
      if (subtype === 'init') {
        events.push({ kind: 'system_init', model: data.model as string | undefined })
      }
      break

    case 'user':
      events.push({ kind: 'user' })
      break

    case 'assistant':
      events.push(...parseAssistantMessage(data))
      break

    case 'result':
      if (subtype === 'success') {
        const resultText = (data.result as string) || ''
        const usage = extractClaudeStyleUsage(data)
        events.push({
          kind: 'result_success',
          text: resultText.trim(),
          durationMs: data.duration_ms as number | undefined,
          ...(usage ? { usage } : {}),
        })
      } else {
        const errorText = (data.error as string) ?? (data.result as string) ?? ''
        // Error results still represent real token consumption.
        const usage = extractClaudeStyleUsage(data)
        // subtype passed through raw (may be undefined) — engine applies its
        // own fallback only at the onLogEntry call site to match original.
        events.push({
          kind: 'result_other',
          ...(subtype !== undefined ? { subtype } : {}),
          ...(errorText ? { error: String(errorText) } : {}),
          ...(usage ? { usage } : {}),
        })
      }
      break

    case 'thinking':
      events.push({ kind: 'thinking' })
      break

    case 'tool_call':
      events.push(parseToolCall(data, subtype))
      break

    case 'tool_result':
      events.push(parseToolResult(data))
      break

    case 'error':
      events.push({
        kind: 'error',
        message: (data.error as string) ?? (data.message as string) ?? 'Unknown error',
      })
      break

    default:
      if (msgType) events.push({ kind: 'unknown', msgType, subtype })
      break
  }

  return { events, msgType, subtype }
}
