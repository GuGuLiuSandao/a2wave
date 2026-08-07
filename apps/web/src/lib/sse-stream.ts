/**
 * SSE stream integrity helpers for the chat/run debug stream.
 *
 * The chat stream is consumed with a raw `fetch` + `ReadableStreamReader`. Two
 * failure modes are otherwise invisible to the user:
 *   1. The server dies mid-stream → the reader returns `{done:true}` cleanly
 *      WITHOUT ever sending a `done` event, so a half-finished reply looks
 *      "complete".
 *   2. The server sends headers then hangs → `reader.read()` blocks forever and
 *      the spinner never stops.
 * These helpers make both observable.
 */

export type StreamEndVerdict = 'ok' | 'incomplete'

/** One fully-parsed SSE event: its `event:` type and the raw `data:` payload. */
export interface SseEvent {
  event: string
  data: string
}

/**
 * Incremental SSE line parser for the chat stream.
 *
 * A raw `fetch` reader hands us arbitrary byte chunks: TCP can split a single
 * `event: done\n` line from its following `data: {...}\n` into two separate
 * reads. The `event:` type must therefore PERSIST across chunks and only reset
 * at the blank line that terminates an SSE event — resetting per chunk (the bug
 * this guards against) drops a split terminal event and misreports it as a lost
 * connection.
 *
 * Feed each decoded chunk to `push()`; it returns the events completed by that
 * chunk. A trailing partial line is buffered until the next `push()`.
 */
export class SseEventAccumulator {
  private buffer = ''
  private eventType = ''

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // The last element is an incomplete line (no trailing '\n' yet); keep it.
    this.buffer = lines.pop() ?? ''

    const events: SseEvent[] = []
    for (const line of lines) {
      if (line === '') {
        // Blank line ends the current SSE event: reset the persisted type.
        this.eventType = ''
      } else if (line.startsWith('event: ')) {
        this.eventType = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        events.push({ event: this.eventType, data: line.slice(6) })
      }
    }
    return events
  }
}

/**
 * Decide whether a finished stream ended cleanly. A stream is only "ok" if it
 * delivered an explicit `done` event; a reader that reached EOF without one was
 * truncated (dropped connection), even if partial content arrived.
 */
export function interpretStreamEnd(sawDoneEvent: boolean): StreamEndVerdict {
  return sawDoneEvent ? 'ok' : 'incomplete'
}

export interface IdleWatchdog {
  /** Call on every received chunk to reset the idle timer. */
  kick: () => void
  /** Stop the watchdog (in a finally). */
  clear: () => void
}

/**
 * Fire `onIdle` when no `kick()` arrives within `idleMs`. Used to abort a stream
 * that produced headers but then went silent, so the UI can surface a timeout
 * instead of spinning forever. `setTimer`/`clearTimer` are injected for testing.
 */
export function createIdleWatchdog(
  idleMs: number,
  onIdle: () => void,
  timers: {
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  } = {},
): IdleWatchdog {
  const setTimer = timers.setTimer ?? setTimeout
  const clearTimer = timers.clearTimer ?? clearTimeout
  let handle: ReturnType<typeof setTimeout> | null = null

  const arm = () => {
    handle = setTimer(() => {
      handle = null
      onIdle()
    }, idleMs)
  }

  arm()

  return {
    kick() {
      if (handle !== null) clearTimer(handle)
      arm()
    },
    clear() {
      if (handle !== null) {
        clearTimer(handle)
        handle = null
      }
    },
  }
}
