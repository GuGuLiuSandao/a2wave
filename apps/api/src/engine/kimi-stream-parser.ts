/**
 * Kimi Code CLI NDJSON event stream parser.
 *
 * Unlike qoder/trae (which mirror Claude Code's `type`-tagged envelope and can
 * share cc-stream-parser), `kimi -p --output-format stream-json` emits
 * OpenAI-chat-completion-shaped rows keyed by `role` (observed on 0.30.0):
 *
 *   {"role":"assistant","tool_calls":[{"type":"function","id":"tool_x",
 *     "function":{"name":"Bash","arguments":"{\"command\":\"ls -la\"}"}}]}
 *   {"role":"tool","tool_call_id":"tool_x","content":"total 8\n"}
 *   {"role":"assistant","content":"Files in the current directory: ..."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_...",
 *     "command":"kimi -r session_..."}
 *
 * Consequences that shape this parser:
 * - There is no `system`/`init` row and no `result` row. Success is therefore
 *   decided by the engine from the exit code, not from an in-stream verdict —
 *   so `resultReceived` is not modelled here at all.
 * - Each assistant row is a COMPLETE message, not a token delta: the CLI's
 *   PromptJsonWriter buffers the text of one message and flushes it as a
 *   single JSON row (verified against the published 0.30.0 package). A run
 *   with tool calls therefore produces several assistant rows (prose before
 *   the call, the final answer after it), and the output buffer joins them
 *   with '\n' — the same message-boundary semantics as the copilot parser.
 * - Tool results carry no error marker: 0.30.0's writeToolResult() emits only
 *   `{role, tool_call_id, content}` and drops the internal isError flag at
 *   dispatch. A failed tool is therefore indistinguishable from a successful
 *   one in-stream and settles as `completed`; failures surface via stderr and
 *   the exit code in the engine's settle. The `is_error` branch below is a
 *   forward-compat guard only, in case upstream starts emitting the marker.
 * - Tool arguments arrive as a JSON *string* (OpenAI convention), not an
 *   object, so they are parsed leniently: malformed arguments still yield a
 *   `started` entry rather than dropping the tool call from the log.
 * - The session id only appears in the terminal `session.resume_hint` meta row,
 *   which is also the only carrier for `--resume`.
 * - Per the docs, thinking content is never written to stdout JSONL (it goes to
 *   stderr), so there is no reasoning branch to handle.
 * - No usage/token row exists in this format, so token accounting stays NULL
 *   (the untracked sentinel) rather than a misleading zero.
 */

import type { HeartbeatTracker } from './heartbeat.js'
import type { StreamCallback, StreamLogCallback } from './types.js'

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Flatten Kimi's `content`, which is either a plain string or content blocks.
 *
 * Only `type: 'text'` blocks are collected. The format is OpenAI-chat shaped,
 * where a content array may also carry `reasoning` / `refusal` blocks that
 * happen to have a `.text` field — accepting those would splice internal
 * deliberation into the run output, chat reply and A2A response. Same guard as
 * cc-stream-parser.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const typed = block as Record<string, unknown>
      if (typed.type !== 'text') return ''
      return typeof typed.text === 'string' ? typed.text : ''
    })
    .join('')
}

export interface KimiStreamParserOptions {
  onUpdate?: StreamCallback
  onLogEntry?: StreamLogCallback
  heartbeat: HeartbeatTracker
  /** Session ID from a resume request; the in-stream hint overrides it. */
  initialSessionId?: string
}

export interface KimiStreamParserState {
  sessionId?: string
  outputBuffer: string
  resultIsError: boolean
  resultErrorText: string
}

export interface KimiStreamParser {
  parseLine(line: string): void
  readonly state: KimiStreamParserState
}

export function createKimiStreamParser(options: KimiStreamParserOptions): KimiStreamParser {
  const { onUpdate, onLogEntry, heartbeat } = options
  const state: KimiStreamParserState = {
    sessionId: options.initialSessionId,
    outputBuffer: '',
    resultIsError: false,
    resultErrorText: '',
  }
  // callId → toolName: `role:"tool"` rows don't repeat the name, so terminal
  // entries need it backfilled to stay readable in the run log.
  const toolNameByCallId = new Map<string, string>()

  const handleToolCalls = (rawToolCalls: unknown) => {
    if (!Array.isArray(rawToolCalls)) return
    for (const toolCall of rawToolCalls) {
      if (!toolCall || typeof toolCall !== 'object') continue
      const typed = toolCall as Record<string, unknown>
      const fn = (typed.function as Record<string, unknown> | undefined) ?? {}
      const callId = typeof typed.id === 'string' ? typed.id : ''
      const toolName = typeof fn.name === 'string' && fn.name ? fn.name : 'unknown'
      // OpenAI convention: arguments is a JSON string. Keep the tool call
      // visible even when it fails to parse, or when it decodes to something
      // that is not an object (the log entry's `input` is object-shaped, so a
      // scalar/array payload is dropped rather than coerced).
      const input =
        typeof fn.arguments === 'string'
          ? (tryParseJsonObject(fn.arguments) ?? undefined)
          : fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)
            ? (fn.arguments as Record<string, unknown>)
            : undefined

      if (callId) toolNameByCallId.set(callId, toolName)
      onLogEntry?.({
        type: 'tool_call',
        subtype: 'started',
        callId,
        toolName,
        ...(input ? { input } : {}),
        ts: Date.now(),
      })
      if (callId) heartbeat.onStarted(callId, toolName)
    }
  }

  const handleToolResult = (data: Record<string, unknown>) => {
    const callId = typeof data.tool_call_id === 'string' ? data.tool_call_id : ''
    if (!callId) return
    // Forward-compat guard: the real 0.30.0 protocol never emits `is_error`
    // (writeToolResult drops it), so in practice every result lands on the
    // `completed` branch — see the file header. Kept so a future CLI that
    // grows an error marker maps to `failed` instead of silently passing.
    const isError = data.is_error === true || data.is_error === 'true'
    const errorText = isError ? extractTextContent(data.content) : ''

    heartbeat.onSettled(callId)
    const toolName = toolNameByCallId.get(callId) ?? ''
    toolNameByCallId.delete(callId)
    onLogEntry?.({
      type: 'tool_call',
      subtype: isError ? 'failed' : 'completed',
      callId,
      toolName,
      ...(errorText ? { error: errorText } : {}),
      ts: Date.now(),
    })
  }

  const parseLine = (line: string) => {
    if (!line.trim()) return
    const data = tryParseJsonObject(line)
    if (!data) return

    const role = typeof data.role === 'string' ? data.role : undefined
    if (!role) return

    switch (role) {
      case 'assistant': {
        if (data.tool_calls) handleToolCalls(data.tool_calls)
        const text = extractTextContent(data.content)
        if (text) {
          // Each row is a complete message (see header), so distinct messages
          // must be joined with a separator — bare concatenation would fuse
          // "Let me check." + "Found ..." into one unreadable sentence.
          state.outputBuffer = state.outputBuffer ? `${state.outputBuffer}\n${text}` : text
          onUpdate?.(state.outputBuffer)
          onLogEntry?.({ type: 'assistant', text, ts: Date.now() })
        }
        break
      }
      case 'tool': {
        handleToolResult(data)
        break
      }
      case 'meta': {
        // Currently only `session.resume_hint`, the sole carrier of the session
        // id needed for `--resume`. Deliberately not appended to the output
        // buffer — it is bookkeeping, not assistant prose.
        if (typeof data.session_id === 'string' && data.session_id) {
          state.sessionId = data.session_id
        }
        break
      }
      // Not observed on 0.30.0 — the CLI writes failures to stderr as prose and
      // stdout only ever carries assistant/tool/meta rows. Kept because every
      // sibling parser documents this flag as load-bearing (a CLI that emits an
      // error yet still exits 0 would otherwise persist a failed run as a
      // success), so the guard should already exist if Kimi grows one.
      case 'error': {
        const message =
          extractTextContent(data.content) ||
          (typeof data.message === 'string' ? data.message : '') ||
          (typeof data.error === 'string' ? data.error : '') ||
          'Unknown error'
        state.resultIsError = true
        state.resultErrorText = message
        onLogEntry?.({ type: 'error', message, ts: Date.now() })
        break
      }
      default:
        // `user` echoes and any future role are ignored: the buffer must hold
        // assistant prose only.
        break
    }
  }

  return { parseLine, state }
}
