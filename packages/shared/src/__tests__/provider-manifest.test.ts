import { describe, expect, it } from 'vitest'
import {
  providerCapabilitiesSchema,
  providerManifestSchema,
  providerModelDiscoverySchema,
} from '../schemas/provider.js'

const cursorManifest = {
  kind: 'cursor',
  displayName: 'Cursor CLI',
  capabilities: {
    authModes: ['apiKey', 'localSession'],
    defaultAuthMode: 'apiKey',
    modelDiscovery: {
      apiKey: 'manual',
      localSession: 'automatic',
    },
    credentialFields: {
      apiKey: [{ field: 'apiKey', required: true }],
    },
    mcpDelivery: { mode: 'workspace-file', defaultPath: '.cursor/mcp.json' },
    executionOptions: ['readOnly', 'force'],
    sessionResume: true,
    sandbox: 'cli-controlled',
    localSessionLoginCommand: 'cursor-agent login',
    apiKeyEnvVar: 'CURSOR_API_KEY',
  },
  minVersion: null,
} as const

describe('provider manifest schema', () => {
  it('parses a complete manifest and exposes capabilities independently', () => {
    const parsed = providerManifestSchema.parse(cursorManifest)

    expect(parsed.kind).toBe('cursor')
    expect(providerCapabilitiesSchema.parse(parsed.capabilities)).toEqual(parsed.capabilities)
  })

  it('rejects unknown model discovery strategies', () => {
    expect(providerModelDiscoverySchema.safeParse('on-demand')).toMatchObject({ success: false })
  })

  it('rejects manual model entry because every Provider must enumerate its catalog', () => {
    expect(providerModelDiscoverySchema.safeParse('manual-entry')).toMatchObject({ success: false })
  })

  it('requires every advertised auth mode to define a discovery strategy', () => {
    const invalid = {
      ...cursorManifest,
      capabilities: {
        ...cursorManifest.capabilities,
        modelDiscovery: { apiKey: 'manual' },
      },
    }

    expect(providerManifestSchema.safeParse(invalid)).toMatchObject({ success: false })
  })

  it('supports optional credentials and a minimum CLI version', () => {
    const trae = {
      ...cursorManifest,
      kind: 'trae',
      minVersion: '0.120.0',
      capabilities: {
        ...cursorManifest.capabilities,
        credentialFields: {
          apiKey: [
            { field: 'apiKey', required: true },
            { field: 'baseUrl', required: false },
          ],
        },
      },
    } as const

    const parsed = providerManifestSchema.parse(trae)
    expect(parsed.minVersion).toBe('0.120.0')
    expect(parsed.capabilities.credentialFields.apiKey).toEqual([
      { field: 'apiKey', required: true },
      { field: 'baseUrl', required: false },
    ])
  })

  it('rejects capability data for unadvertised auth modes', () => {
    const invalid = {
      ...cursorManifest,
      capabilities: {
        ...cursorManifest.capabilities,
        modelDiscovery: {
          ...cursorManifest.capabilities.modelDiscovery,
          oauth: 'manual',
        },
        credentialFields: {
          ...cursorManifest.capabilities.credentialFields,
          oauth: [{ field: 'oauthToken', required: true }],
        },
      },
    } as const

    expect(providerManifestSchema.safeParse(invalid)).toMatchObject({ success: false })
  })

  it('rejects duplicate credential descriptors within one auth mode', () => {
    const invalid = {
      ...cursorManifest,
      capabilities: {
        ...cursorManifest.capabilities,
        credentialFields: {
          apiKey: [
            { field: 'apiKey', required: true },
            { field: 'apiKey', required: false },
          ],
        },
      },
    } as const

    expect(providerManifestSchema.safeParse(invalid)).toMatchObject({ success: false })
  })
})
