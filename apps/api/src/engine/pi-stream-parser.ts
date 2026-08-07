/**
 * Pi CLI JSONL event stream parser.
 *
 * `pi --mode json` emits the session header followed by AgentSession events:
 * assistant text deltas, structured tool lifecycle events, retry events and a
 * terminal `agent_settled`. Unlike Claude-compatible streams, there is no
 * synthetic `result` row; `agent_settled` is the definitive end marker because
 * `agent_end` can occur before Pi performs an automatic retry or compaction.
 * Each assistant `message_end` carries usage for one provider request, not a
 * cumulative session total. A `compaction_end` carries the separate summary
 * request's usage and is not mirrored by an assistant `message_end`, so both
 * event types are accumulated into the run total.
 */

import type { HeartbeatTracker } from './heartbeat.js'
import type { StreamCallback, StreamLogCallback, TokenUsage } from './types.js'
import { accumulateUsage } from './usage.js'

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function extractTextContent(message: unknown): string {
  const content = asObject(message)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const typed = asObject(block)
      return typed?.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
    })
    .join('')
}

function extractToolResultText(result: unknown): string {
  const content = asObject(result)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const typed = asObject(block)
      return typed?.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Normalize Pi's provider-independent Usage shape into a2wave's disjoint
 * buckets. Pi documents `reasoning` as a subset of `output`, while a2wave sums
 * the two columns, so reasoning must be subtracted from output to avoid double
 * counting. Pi has already split cache reads/writes from uncached input.
 */
function mapPiUsage(source: unknown): TokenUsage | undefined {
  const usage = asObject(asObject(source)?.usage)
  if (!usage) return undefined

  const input = typeof usage.input === 'number' ? usage.input : undefined
  const output = typeof usage.output === 'number' ? usage.output : undefined
  const reasoning = typeof usage.reasoning === 'number' ? usage.reasoning : undefined
  const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : undefined
  const cacheWrite = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : undefined
  const normalized: TokenUsage = {}
  if (input !== undefined) normalized.inputTokens = input
  if (output !== undefined) {
    normalized.outputTokens = reasoning === undefined ? output : Math.max(0, output - reasoning)
  }
  if (reasoning !== undefined) normalized.reasoningTokens = reasoning
  if (cacheRead !== undefined) normalized.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) normalized.cacheWriteTokens = cacheWrite
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function messageError(message: unknown): string {
  const typed = asObject(message)
  return typeof typed?.errorMessage === 'string' && typed.errorMessage
    ? typed.errorMessage
    : typeof typed?.stopReason === 'string'
      ? `Pi request ${typed.stopReason}`
      : 'Pi request failed'
}

export interface PiStreamParserOptions {
  onUpdate?: StreamCallback
  onLogEntry?: StreamLogCallback
  heartbeat: HeartbeatTracker
  initialSessionId?: string
}

export interface PiStreamParserState {
  sessionId?: string
  outputBuffer: string
  resultReceived: boolean
  resultIsError: boolean
  resultErrorText: string
  lastErrorText: string
  usage?: TokenUsage
}

export interface PiStreamParser {
  parseLine(line: string): void
  readonly state: PiStreamParserState
}

export function createPiStreamParser(options: PiStreamParserOptions): PiStreamParser {
  const { heartbeat, onLogEntry, onUpdate } = options
  const state: PiStreamParserState = {
    sessionId: options.initialSessionId,
    outputBuffer: '',
    resultReceived: false,
    resultIsError: false,
    resultErrorText: '',
    lastErrorText: '',
  }
  const completedAssistantTexts: string[] = []
  const toolNameByCallId = new Map<string, string>()
  let currentAssistantText = ''
  let currentHadDeltas = false
  let retryInFlight = false
  let overflowRecoveryInFlight = false

  const publishOutput = () => {
    state.outputBuffer = [...completedAssistantTexts, currentAssistantText]
      .filter((text) => text.length > 0)
      .join('\n')
    onUpdate?.(state.outputBuffer)
  }

  const discardCurrentAssistant = () => {
    currentAssistantText = ''
    currentHadDeltas = false
    publishOutput()
  }

  const finalizeCurrentAssistant = () => {
    if (currentAssistantText) completedAssistantTexts.push(currentAssistantText)
    currentAssistantText = ''
    currentHadDeltas = false
    state.outputBuffer = completedAssistantTexts.join('\n')
  }

  const handleAssistantEnd = (message: unknown) => {
    const typed = asObject(message)
    if (!typed || typed.role !== 'assistant') return

    const usage = mapPiUsage(typed)
    if (usage) state.usage = accumulateUsage(state.usage, usage)

    const stopReason = typeof typed.stopReason === 'string' ? typed.stopReason : ''
    if (stopReason === 'error' || stopReason === 'aborted') {
      overflowRecoveryInFlight = false
      state.resultIsError = true
      state.resultErrorText = messageError(typed)
      state.lastErrorText = state.resultErrorText
      discardCurrentAssistant()
      onLogEntry?.({ type: 'error', message: state.resultErrorText, ts: Date.now() })
      return
    }

    if (overflowRecoveryInFlight) {
      overflowRecoveryInFlight = false
      state.resultIsError = false
      state.resultErrorText = ''
    }
    const finalText = extractTextContent(typed)
    if (finalText !== currentAssistantText) {
      currentAssistantText = finalText
      publishOutput()
    }
    // Some providers do not stream deltas. Preserve a useful assistant log in
    // that case without duplicating a normally streamed response.
    if (finalText && !currentHadDeltas) {
      onLogEntry?.({ type: 'assistant', text: finalText, ts: Date.now() })
    }
    finalizeCurrentAssistant()
  }

  const parseLine = (line: string) => {
    if (!line.trim()) return
    const data = tryParseObject(line)
    if (!data) return
    const type = typeof data.type === 'string' ? data.type : ''
    if (!type) return

    switch (type) {
      case 'session': {
        if (typeof data.id === 'string' && data.id) state.sessionId = data.id
        break
      }
      case 'message_start': {
        if (asObject(data.message)?.role === 'assistant') {
          // Defensive recovery for a malformed/missing prior message_end.
          finalizeCurrentAssistant()
        }
        break
      }
      case 'message_update': {
        const event = asObject(data.assistantMessageEvent)
        if (!event) break
        if (event.type === 'text_delta' && typeof event.delta === 'string') {
          currentAssistantText += event.delta
          currentHadDeltas = true
          publishOutput()
          onLogEntry?.({ type: 'assistant', text: event.delta, ts: Date.now() })
        } else if (event.type === 'error') {
          state.resultIsError = true
          state.resultErrorText = messageError(event.error)
          state.lastErrorText = state.resultErrorText
        }
        break
      }
      case 'message_end': {
        handleAssistantEnd(data.message)
        break
      }
      case 'compaction_end': {
        const usage = mapPiUsage(data.result)
        if (usage) state.usage = accumulateUsage(state.usage, usage)
        overflowRecoveryInFlight = data.willRetry === true
        break
      }
      case 'tool_execution_start': {
        const callId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
        const toolName =
          typeof data.toolName === 'string' && data.toolName ? data.toolName : 'unknown'
        const input = asObject(data.args)
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
        break
      }
      case 'tool_execution_end': {
        const callId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
        const toolName =
          (typeof data.toolName === 'string' && data.toolName) ||
          toolNameByCallId.get(callId) ||
          'unknown'
        const isError = data.isError === true
        const errorText = isError ? extractToolResultText(data.result) : ''
        if (callId) {
          heartbeat.onSettled(callId)
          toolNameByCallId.delete(callId)
        }
        onLogEntry?.({
          type: 'tool_call',
          subtype: isError ? 'failed' : 'completed',
          callId,
          toolName,
          ...(errorText ? { error: errorText } : {}),
          ts: Date.now(),
        })
        break
      }
      case 'auto_retry_start': {
        retryInFlight = true
        onLogEntry?.({
          type: 'retry',
          attempt: typeof data.attempt === 'number' ? data.attempt : 1,
          nextAttemptIn: typeof data.delayMs === 'number' ? data.delayMs : 0,
          ts: Date.now(),
        })
        break
      }
      case 'auto_retry_end': {
        if (!retryInFlight) break
        retryInFlight = false
        if (data.success === true) {
          state.resultIsError = false
          state.resultErrorText = ''
        } else if (typeof data.finalError === 'string' && data.finalError) {
          state.resultIsError = true
          state.resultErrorText = data.finalError
          state.lastErrorText = state.resultErrorText
        }
        break
      }
      case 'agent_settled': {
        state.resultReceived = true
        onLogEntry?.({
          type: 'result',
          subtype: state.resultIsError ? 'error' : 'success',
          ...(state.usage ? { usage: state.usage } : {}),
          ts: Date.now(),
        })
        break
      }
      default:
        break
    }
  }

  return { parseLine, state }
}
