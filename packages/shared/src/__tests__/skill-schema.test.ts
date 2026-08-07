import { describe, expect, it } from 'vitest'
import {
  createSkillInput,
  installRemoteSkillsInput,
  skillSchema,
  skillVisibilityEnum,
} from '../schemas/skill.js'

describe('Skill visibility contract', () => {
  it('defaults new Skills to private', () => {
    expect(createSkillInput.parse({ name: 'Private Skill' }).visibility).toBe('private')
  })

  it('accepts the two persisted visibility values', () => {
    expect(skillVisibilityEnum.options).toEqual(['private', 'all-users'])
    expect(
      skillSchema.parse({
        id: 'skl_1',
        name: 'Shared Skill',
        visibility: 'all-users',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).visibility,
    ).toBe('all-users')
  })

  it('defaults remote installations to private', () => {
    expect(
      installRemoteSkillsInput.parse({
        url: 'https://github.com/acme/skills',
        requestedRef: 'main',
        revision: 'a'.repeat(40),
        selections: [{ path: 'review', digest: `sha256:${'b'.repeat(64)}` }],
      }).visibility,
    ).toBe('private')
  })
})
