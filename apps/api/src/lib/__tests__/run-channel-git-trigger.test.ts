/**
 * Run attribution for the git repository trigger channels (`glab` / `gh`).
 *
 * A poll has no logged-in caller, so everything the run record can ever say
 * about *why* it started comes from this builder: the channel context the
 * Agent reads, and the `display_name` the run list renders in front of the
 * intent. When it under-reports, the run appears in the list as an
 * unattributed line of prompt text with no way back to the merge request that
 * caused it — the one thing an operator looks for when a poll misfires.
 */
import { runChannelContextSchema } from '@a2wave/shared'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../middleware/gateway-auth.js', () => ({
  normalizeAuthType: (v: string | null | undefined) =>
    v === 'none' || v === 'oauth' ? v : 'api_key',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { buildGitTriggerChannel } from '../run-channel.js'

const baseOpts = {
  provider: 'glab' as const,
  event: 'opened',
  project: 'group/sub/repo',
  host: 'gitlab.example.com',
  number: 42,
  url: 'https://gitlab.example.com/group/sub/repo/-/merge_requests/42',
  sha: 'abc1234',
  authorName: 'Zhang Li',
}

describe('buildGitTriggerChannel', () => {
  it('produces a context the shared schema accepts', () => {
    for (const provider of ['glab', 'gh'] as const) {
      const { ctx } = buildGitTriggerChannel({ ...baseOpts, provider })
      expect(() => runChannelContextSchema.parse(ctx)).not.toThrow()
    }
  })

  it('carries every field needed to identify the request that fired', () => {
    const { ctx } = buildGitTriggerChannel(baseOpts)
    expect(ctx.channel_type).toBe('glab')
    expect(ctx.channel_info).toMatchObject({
      provider: 'glab',
      event: 'opened',
      project: 'group/sub/repo',
      host: 'gitlab.example.com',
      number: 42,
      url: baseOpts.url,
      sha: 'abc1234',
    })
  })

  it('sets channel_type from the provider so the run list labels it correctly', () => {
    // `triggerSource` and `channel_type` must agree: the run row renders the
    // source pill from one and the Agent branches on the other.
    expect(buildGitTriggerChannel({ ...baseOpts, provider: 'gh' }).ctx.channel_type).toBe('gh')
  })

  it('surfaces the forge author as the run display name', () => {
    // This is what `RunCallerPrefix` shows as ⟨Zhang Li·GitLab 触发⟩.
    const { ctx, displayName } = buildGitTriggerChannel(baseOpts)
    expect(displayName).toBe('Zhang Li')
    expect(ctx.display_name).toBe('Zhang Li')
  })

  it('never promotes the forge author into user_info', () => {
    // A forge username is an unrelated identity namespace from a2wave/IDaaS.
    // Promoting it would let repository metadata name any platform user it
    // liked, and the run list would attribute the run to a real colleague who
    // never triggered anything.
    const { ctx } = buildGitTriggerChannel(baseOpts)
    expect(ctx.user_info).toBeNull()
  })

  it('omits display_name when the forge reports no author', () => {
    for (const authorName of [null, undefined, '   ']) {
      const { ctx, displayName } = buildGitTriggerChannel({ ...baseOpts, authorName })
      expect(displayName).toBeNull()
      expect(ctx.display_name).toBeUndefined()
      // The channel still identifies itself, so the run is labelled by source
      // even when it cannot be labelled by person.
      expect(ctx.channel_type).toBe('glab')
      expect(() => runChannelContextSchema.parse(ctx)).not.toThrow()
    }
  })

  it('omits optional forge fields rather than emitting empty strings', () => {
    // `closed` events are inferred from absence, so url/sha may genuinely be
    // unknown. Empty strings would render as blank links in the UI.
    const { ctx } = buildGitTriggerChannel({
      provider: 'gh',
      event: 'closed',
      project: 'owner/repo',
      number: 7,
    })
    const info = ctx.channel_info as Record<string, unknown>
    expect(info).not.toHaveProperty('url')
    expect(info).not.toHaveProperty('sha')
    expect(info).not.toHaveProperty('host')
    expect(info.number).toBe(7)
  })
})
