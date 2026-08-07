/**
 * Heartbeat tracker for in-flight tool calls.
 *
 * Provider parsers emit `tool_call:started` as soon as an LLM tool_use block
 * arrives, and `tool_call:completed|failed` only after the tool result lands.
 * Between those two events the step can sit "running" for minutes with no
 * output — so the UI has nothing to show and can't distinguish "LLM is
 * thinking" from "the tool is hanging".
 *
 * This helper attaches a single interval timer per provider invocation that,
 * every `intervalMs`, emits a `tool_heartbeat` entry for every call that has
 * started but not settled. It is NOT a generic "still alive" probe — it
 * specifically marks *which tool* is the currently-stuck one, with elapsed
 * time since it started.
 *
 * Providers must call `stop()` when the child process exits (success, error,
 * kill, or timeout). Otherwise the interval leaks.
 */
import type { StreamLogCallback, StreamLogEntry } from './types.js'

export interface HeartbeatTracker {
  onStarted(callId: string, toolName: string): void
  onSettled(callId: string): void
  stop(): void
}

export interface HeartbeatOptions {
  intervalMs: number
  emit: StreamLogCallback
}

export function createHeartbeatTracker(opts: HeartbeatOptions): HeartbeatTracker {
  const { intervalMs, emit } = opts
  const open = new Map<string, { toolName: string; startedAt: number }>()
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const ensureTimer = () => {
    if (timer || stopped) return
    timer = setInterval(() => {
      const now = Date.now()
      for (const [callId, entry] of open) {
        const elapsedMs = now - entry.startedAt
        // Skip heartbeats for calls that settled within the same tick (race).
        if (elapsedMs < intervalMs / 2) continue
        emit({
          type: 'tool_heartbeat',
          callId,
          toolName: entry.toolName,
          elapsedMs,
          ts: now,
        } satisfies StreamLogEntry)
      }
    }, intervalMs)
    // Don't keep the Node.js process alive just for heartbeats — the child
    // process lifetime dictates the parser's lifetime.
    if (typeof timer.unref === 'function') timer.unref()
  }

  const clearIfIdle = () => {
    if (!timer) return
    if (open.size > 0) return
    clearInterval(timer)
    timer = null
  }

  return {
    onStarted(callId, toolName) {
      if (stopped) return
      open.set(callId, { toolName, startedAt: Date.now() })
      ensureTimer()
    },
    onSettled(callId) {
      open.delete(callId)
      clearIfIdle()
    },
    stop() {
      stopped = true
      open.clear()
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
