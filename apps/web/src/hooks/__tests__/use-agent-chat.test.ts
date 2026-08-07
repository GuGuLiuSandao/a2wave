/**
 * Unit tests for the chat hook's transcript-adoption decision.
 *
 * This gate sits between two failure modes that pull in opposite directions:
 * adopt too eagerly and a snapshot wipes bubbles the client is currently
 * rendering (including a poll for an OLDER run landing mid-turn); adopt too
 * reluctantly and a queued or resumed turn's reply never lands, leaving the
 * conversation frozen with no reply, spinner or error.
 */
import { describe, expect, it } from 'vitest'

import { type TranscriptSource, shouldAdoptServerTranscript } from '../use-agent-chat'

const IDLE: TranscriptSource = { kind: 'idle' }
const RESTORE_1: TranscriptSource = { kind: 'restore', runId: 'run_1' }
const AWAIT_1: TranscriptSource = { kind: 'awaitRun', runId: 'run_1' }

describe('shouldAdoptServerTranscript', () => {
  it('refuses when idle, so a live transcript is never clobbered', () => {
    // The chat page after a completed streaming turn: nothing is being followed,
    // so the in-memory bubbles (and their blob-URL thumbnails) stay authoritative.
    expect(shouldAdoptServerTranscript(IDLE, 'run_1')).toBe(false)
  })

  it('adopts the followed run, which is how a queued reply arrives', () => {
    expect(shouldAdoptServerTranscript(AWAIT_1, 'run_1')).toBe(true)
  })

  it('adopts the restored run, which is how a resumed conversation renders', () => {
    expect(shouldAdoptServerTranscript(RESTORE_1, 'run_1')).toBe(true)
  })

  it.each([
    ['awaitRun', AWAIT_1],
    ['restore', RESTORE_1],
  ])('refuses a different run than the one %s is scoped to', (_kind, source) => {
    // Regression: `restore` used to adopt unconditionally. Because it now stays
    // armed across polls (its run may still be executing), an unscoped adopt let a
    // poll for the restored run overwrite the live bubbles of a NEW turn the user
    // had just sent, merging two runs' messages into one transcript.
    expect(shouldAdoptServerTranscript(source, 'run_2')).toBe(false)
  })

  it.each([
    ['awaitRun', AWAIT_1],
    ['restore', RESTORE_1],
  ])('refuses when the fetched transcript carries no run id (%s)', (_kind, source) => {
    expect(shouldAdoptServerTranscript(source, undefined)).toBe(false)
  })

  it('refusal is the path that must release the follow state', () => {
    // Twice now a refused adoption left `followedRunId` set and froze the composer,
    // because the release only ran after a successful adopt. Pinning the refusal
    // here so the caller's release-on-refusal branch stays load-bearing.
    expect(shouldAdoptServerTranscript(AWAIT_1, 'run_9')).toBe(false)
  })
})
