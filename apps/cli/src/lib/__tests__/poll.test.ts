import { describe, expect, it, vi } from 'vitest'
import { pollUntilTerminal } from '../poll.js'

const TERMINAL = new Set(['completed', 'failed'])
const isTerminal = (r: { status: string }) => TERMINAL.has(r.status)
const describeTimeout = (r: { status: string }, ms: number) =>
  `timed out after ${ms}ms at ${r.status}`

/** Explicit cadence, as every real caller now supplies. */
const CADENCE = { intervalMs: 2000, timeoutMs: 30 * 60_000 }

describe('pollUntilTerminal', () => {
  it('returns as soon as the record is terminal', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'queued' } })
      .mockResolvedValueOnce({ data: { status: 'running' } })
      .mockResolvedValueOnce({ data: { status: 'completed' } })

    const out = await pollUntilTerminal({ get }, '/p', isTerminal, describeTimeout, CADENCE, {
      sleep: async () => {},
    })

    expect(out.status).toBe('completed')
    expect(get).toHaveBeenCalledTimes(3)
    expect(get).toHaveBeenCalledWith('/p')
  })

  it('always fetches at least once, even with a zero timeout', async () => {
    // Checking the deadline before the first fetch would fail without looking.
    const get = vi.fn().mockResolvedValue({ data: { status: 'completed' } })

    const out = await pollUntilTerminal({ get }, '/p', isTerminal, describeTimeout, CADENCE, {
      timeoutMs: 0,
      sleep: async () => {},
    })

    expect(out.status).toBe('completed')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('throws the caller-supplied message on timeout', async () => {
    const get = vi.fn().mockResolvedValue({ data: { status: 'running' } })

    await expect(
      pollUntilTerminal({ get }, '/p', isTerminal, describeTimeout, CADENCE, {
        timeoutMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/timed out after 0ms at running/)
  })

  it('waits the interval an override specifies', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'running' } })
      .mockResolvedValueOnce({ data: { status: 'failed' } })

    await pollUntilTerminal({ get }, '/p', isTerminal, describeTimeout, CADENCE, {
      intervalMs: 1234,
      sleep,
    })

    expect(sleep).toHaveBeenCalledWith(1234)
  })

  it('falls back to the caller cadence when no override is given', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'running' } })
      .mockResolvedValueOnce({ data: { status: 'completed' } })

    await pollUntilTerminal(
      { get },
      '/p',
      isTerminal,
      describeTimeout,
      { intervalMs: 5000, timeoutMs: 60 * 60_000 },
      { sleep },
    )

    expect(sleep).toHaveBeenCalledWith(5000)
  })

  it('treats an explicit undefined as "use the caller cadence", not as blank', async () => {
    // The foot-gun this signature exists to remove: with `{...cadence, ...opts}`
    // an explicit `undefined` OVERWROTE the caller's value and fell through to a
    // generic default, halving a 60-minute evaluation budget to 30. A caller
    // building opts from config (`{ timeoutMs: cfg.evalTimeout }` with the key
    // unset) type-checks fine, so this must not depend on the key being absent.
    const sleep = vi.fn().mockResolvedValue(undefined)
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'running' } })
      .mockResolvedValueOnce({ data: { status: 'completed' } })

    await pollUntilTerminal(
      { get },
      '/p',
      isTerminal,
      describeTimeout,
      { intervalMs: 5000, timeoutMs: 60 * 60_000 },
      { intervalMs: undefined, timeoutMs: undefined, sleep },
    )

    expect(sleep).toHaveBeenCalledWith(5000)
  })

  it('keeps the caller timeoutMs against an explicit undefined', async () => {
    // `timeoutMs` is the field that actually caused the 60min → 30min halving;
    // asserting only on intervalMs would let a regression to
    // `timeoutMs ?? <generic default>` slip through.
    //
    // Asserted through the MESSAGE, which carries the effective timeout, rather
    // than by letting a wrong budget elapse. A wall-clock proof is not possible
    // here: under the regression the budget becomes 30 minutes with `sleep`
    // stubbed to resolve instantly, so the loop spins millions of times and
    // vitest kills the worker — a hang, not a readable failure. `bumpClock`
    // advances time past whichever deadline was chosen, so the throw is
    // immediate either way and only the number in the message differs.
    const get = vi.fn().mockResolvedValue({ data: { status: 'running' } })
    const bumpClock = async () => {
      vi.setSystemTime(Date.now() + 10_000)
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await expect(
        pollUntilTerminal(
          { get },
          '/p',
          isTerminal,
          describeTimeout,
          { intervalMs: 5000, timeoutMs: 777 },
          { timeoutMs: undefined, sleep: bumpClock },
        ),
      ).rejects.toThrow(/timed out after 777ms/)
    } finally {
      vi.useRealTimers()
    }
  })
})
