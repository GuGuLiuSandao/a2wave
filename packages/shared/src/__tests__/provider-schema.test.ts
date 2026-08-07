import { describe, expect, it } from 'vitest'
import {
  PRESET_PROVIDERS,
  providerKindSchema,
  providerListItemSchema,
  providerModelDiscoverySchema,
  providerSchema,
} from '../schemas/provider.js'

describe('provider schema', () => {
  it('defines one unique stable kind for every built-in provider', () => {
    const kinds = PRESET_PROVIDERS.map((provider) => provider.kind)

    expect(kinds).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'kimi',
      'opencode',
      'pi',
      'qoder',
      'trae',
    ])
    expect(new Set(kinds).size).toBe(PRESET_PROVIDERS.length)
    for (const kind of kinds) expect(providerKindSchema.parse(kind)).toBe(kind)
  })

  it('admits no model-discovery strategy that cannot enumerate models', () => {
    // Being able to list the models a credential may run is a hard onboarding
    // requirement, so the enum must never regain a "static"/"unsupported" escape
    // hatch — that is how a hand-maintained catalog drifts back in.
    expect(providerModelDiscoverySchema.options).toEqual(['automatic', 'manual'])
  })

  it('requires kind independently from the display name', () => {
    const provider = {
      id: 'prv_test',
      kind: 'cursor',
      name: 'Renamed Coding Engine',
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    expect(providerSchema.parse(provider).kind).toBe('cursor')
    expect(providerSchema.safeParse({ ...provider, kind: undefined }).success).toBe(false)
  })

  it('represents an unsupported persisted kind as a diagnostic list item', () => {
    const item = providerListItemSchema.parse({
      id: 'prv_gemini',
      kind: 'legacy:prv_gemini',
      name: 'Gemini CLI',
      isPreset: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'unsupported',
      diagnostic: {
        code: 'PROVIDER_KIND_UNSUPPORTED',
        message: 'No runtime adapter is registered for Provider kind "legacy:prv_gemini"',
      },
    })

    expect(item).toMatchObject({
      id: 'prv_gemini',
      kind: 'legacy:prv_gemini',
      status: 'unsupported',
      diagnostic: { code: 'PROVIDER_KIND_UNSUPPORTED' },
    })
  })
})
