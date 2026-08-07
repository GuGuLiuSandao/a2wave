import { CliError } from '../errors.js'

/** Minimal client surface a poll needs — keeps callers easy to stub in tests. */
interface Fetcher {
  get: <T>(path: string) => Promise<T>
}

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  /** Injected in tests so a poll loop runs without real delays. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Cadence for one poll loop. REQUIRED, so each caller owns its own numbers and
 * there is no generic fallback to silently land on.
 *
 * The previous shape — a default here plus `{...defaults, ...opts}` at the call
 * site — meant an explicit `intervalMs: undefined` OVERWROTE the caller's value
 * and fell through to the generic default. A caller building opts from config
 * (`{ timeoutMs: cfg.evalTimeout }` with the key unset) type-checks fine and
 * would have had a 60-minute evaluation cut off at 30.
 */
export interface PollCadence {
  intervalMs: number
  timeoutMs: number
}

/**
 * Poll `path` until the fetched record reaches a terminal state.
 *
 * Shared by `runs rerun --wait` and `eval run --wait`, which differ only in the
 * path, the terminal set, and the default interval — everything else (deadline
 * arithmetic, the check-before-sleep ordering that guarantees at least one
 * fetch, the timeout message) was duplicated verbatim.
 *
 * The deadline is checked AFTER the fetch and BEFORE the sleep, so a zero
 * timeout still performs one poll rather than failing without ever looking.
 */
export async function pollUntilTerminal<T extends { status: string }>(
  client: Fetcher,
  path: string,
  isTerminal: (record: T) => boolean,
  describe: (record: T, elapsedMs: number) => string,
  cadence: PollCadence,
  opts: PollOptions = {},
): Promise<T> {
  // `??` per field, never a spread: an explicit `undefined` must fall back to
  // the caller's cadence, not silently blank it.
  const intervalMs = opts.intervalMs ?? cadence.intervalMs
  const timeoutMs = opts.timeoutMs ?? cadence.timeoutMs
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const deadline = Date.now() + timeoutMs

  while (true) {
    const { data } = await client.get<{ data: T }>(path)
    if (isTerminal(data)) return data
    if (Date.now() >= deadline) throw new CliError(describe(data, timeoutMs))
    await sleep(intervalMs)
  }
}
