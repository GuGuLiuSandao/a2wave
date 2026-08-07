import { describe, expect, it } from 'vitest'
import { agentSchema, publishChannelEnum } from '../schemas/agent.js'
import {
  GIT_TRIGGER_DEFAULT_INTERVAL_SECONDS,
  GIT_TRIGGER_MAX_INTERVAL_SECONDS,
  GIT_TRIGGER_MAX_REPOS,
  GIT_TRIGGER_MIN_INTERVAL_SECONDS,
  ghTriggerConfigSchema,
  gitTriggerConfigSchema,
  gitTriggerConfigSchemaFor,
  glabTriggerConfigSchema,
} from '../schemas/git-trigger.js'
import { runChannelContextSchema } from '../schemas/run-channel.js'
import { runTriggerSourceEnum } from '../schemas/run.js'

const validConfig = {
  provider: 'glab' as const,
  repos: [{ project: 'group/repo' }],
  events: ['opened' as const],
  intent: 'review {{url}}',
}

describe('gitTriggerConfigSchema', () => {
  it('applies defaults for the optional fields', () => {
    const parsed = gitTriggerConfigSchema.parse(validConfig)
    expect(parsed.intervalSeconds).toBe(GIT_TRIGGER_DEFAULT_INTERVAL_SECONDS)
    expect(parsed.targetBranches).toEqual([])
    expect(parsed.ignoreDrafts).toBe(true)
  })

  it('accepts a self-hosted host per repository', () => {
    const parsed = gitTriggerConfigSchema.parse({
      ...validConfig,
      repos: [{ project: 'a/b', host: 'gitlab.example.com' }, { project: 'c/d' }],
    })
    expect(parsed.repos[0].host).toBe('gitlab.example.com')
    expect(parsed.repos[1].host).toBeUndefined()
  })

  it('rejects an interval below the forge-protection floor', () => {
    expect(
      gitTriggerConfigSchema.safeParse({
        ...validConfig,
        intervalSeconds: GIT_TRIGGER_MIN_INTERVAL_SECONDS - 1,
      }).success,
    ).toBe(false)
  })

  it('rejects an interval above the ceiling', () => {
    expect(
      gitTriggerConfigSchema.safeParse({
        ...validConfig,
        intervalSeconds: GIT_TRIGGER_MAX_INTERVAL_SECONDS + 1,
      }).success,
    ).toBe(false)
  })

  it('accepts both bounds inclusively', () => {
    for (const seconds of [GIT_TRIGGER_MIN_INTERVAL_SECONDS, GIT_TRIGGER_MAX_INTERVAL_SECONDS]) {
      expect(
        gitTriggerConfigSchema.safeParse({ ...validConfig, intervalSeconds: seconds }).success,
      ).toBe(true)
    }
  })

  it('rejects an empty event list', () => {
    // A config with no events would poll forever and never fire — a silent
    // misconfiguration that looks healthy in the UI.
    expect(gitTriggerConfigSchema.safeParse({ ...validConfig, events: [] }).success).toBe(false)
  })

  it('rejects an empty repository list', () => {
    expect(gitTriggerConfigSchema.safeParse({ ...validConfig, repos: [] }).success).toBe(false)
  })

  it('rejects more repositories than the per-tick API budget allows', () => {
    const repos = Array.from({ length: GIT_TRIGGER_MAX_REPOS + 1 }, (_, i) => ({
      project: `g/r${i}`,
    }))
    expect(gitTriggerConfigSchema.safeParse({ ...validConfig, repos }).success).toBe(false)
  })

  it('rejects a blank intent', () => {
    expect(gitTriggerConfigSchema.safeParse({ ...validConfig, intent: '   ' }).success).toBe(false)
  })

  it('rejects an unknown provider', () => {
    expect(gitTriggerConfigSchema.safeParse({ ...validConfig, provider: 'gitea' }).success).toBe(
      false,
    )
  })

  it('rejects an unknown event', () => {
    expect(
      gitTriggerConfigSchema.safeParse({ ...validConfig, events: ['pipeline_failed'] }).success,
    ).toBe(false)
  })

  it('trims the project path', () => {
    const parsed = gitTriggerConfigSchema.parse({
      ...validConfig,
      repos: [{ project: '  group/repo  ' }],
    })
    expect(parsed.repos[0].project).toBe('group/repo')
  })
})

describe('provider-bound variants', () => {
  it('rejects a glab config offered as a gh config', () => {
    // The structural half of a defect that was fixed three times by hand, at
    // three separate write paths: the shared shape accepted either provider, so
    // a mismatched config validated, saved, and then silently never polled.
    // Binding each column to its own literal makes that a validation failure
    // everywhere at once, including paths written in the future.
    expect(ghTriggerConfigSchema.safeParse(validConfig).success).toBe(false)
    expect(glabTriggerConfigSchema.safeParse(validConfig).success).toBe(true)
  })

  it('rejects a gh config offered as a glab config', () => {
    const ghConfig = { ...validConfig, provider: 'gh' as const }
    expect(glabTriggerConfigSchema.safeParse(ghConfig).success).toBe(false)
    expect(ghTriggerConfigSchema.safeParse(ghConfig).success).toBe(true)
  })

  it('selects the matching schema by provider', () => {
    expect(gitTriggerConfigSchemaFor('glab').safeParse(validConfig).success).toBe(true)
    expect(gitTriggerConfigSchemaFor('gh').safeParse(validConfig).success).toBe(false)
  })

  it('keeps every other rule of the shared schema', () => {
    // The variants must narrow the provider and nothing else.
    expect(glabTriggerConfigSchema.safeParse({ ...validConfig, intervalSeconds: 5 }).success).toBe(
      false,
    )
    expect(glabTriggerConfigSchema.safeParse({ ...validConfig, events: [] }).success).toBe(false)
  })
})

describe('channel contract wiring', () => {
  it('exposes glab and gh as publish channels', () => {
    expect(publishChannelEnum.options).toContain('glab')
    expect(publishChannelEnum.options).toContain('gh')
  })

  it('exposes glab and gh as run trigger sources', () => {
    // Without this the Run row could not record which channel started it.
    expect(runTriggerSourceEnum.options).toContain('glab')
    expect(runTriggerSourceEnum.options).toContain('gh')
  })

  it('accepts the two configs on the agent schema', () => {
    const parsed = agentSchema.partial().parse({
      glabConfig: validConfig,
      ghConfig: { ...validConfig, provider: 'gh' },
    })
    expect(parsed.glabConfig?.provider).toBe('glab')
    expect(parsed.ghConfig?.provider).toBe('gh')
  })

  it('validates a git trigger run channel context', () => {
    const parsed = runChannelContextSchema.safeParse({
      channel_type: 'glab',
      channel_info: {
        provider: 'glab',
        event: 'commented',
        project: 'group/repo',
        host: 'gitlab.example.com',
        number: 50,
        url: 'https://gitlab.example.com/group/repo/-/merge_requests/50',
        sha: 'abc123',
      },
      user_info: null,
      display_name: 'Octocat',
    })
    expect(parsed.success).toBe(true)
  })

  it('requires a merge request number in the channel context', () => {
    // The number is what makes a poll-triggered run traceable back to its cause.
    const parsed = runChannelContextSchema.safeParse({
      channel_type: 'gh',
      channel_info: { provider: 'gh', event: 'opened', project: 'o/r' },
      user_info: null,
    })
    expect(parsed.success).toBe(false)
  })
})
