import { z } from 'zod'
import { authHeaderStyleEnum, authModeEnum } from './agent.js'
import { type ProviderKind, providerKindSchema } from './provider.js'

// The transport schema is provider-agnostic. Provider-specific auth and
// credential rules are owned by ProviderCatalog so adding a provider does not
// require another shared discriminated union.
export const probeModelsRequestSchema = z
  .object({
    kind: providerKindSchema.optional(),
    engineType: providerKindSchema.optional(),
    authMode: authModeEnum,
    authHeaderStyle: authHeaderStyleEnum.optional(),
    apiKey: z.string().min(1, 'apiKey cannot be empty').optional(),
    oauthToken: z.string().min(1, 'oauthToken cannot be empty').optional(),
    baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  })
  .superRefine((request, ctx) => {
    if (!request.kind && !request.engineType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'kind is required',
      })
    }
    if (request.kind && request.engineType && request.kind !== request.engineType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engineType'],
        message: 'kind and engineType must match',
      })
    }
  })
  .transform((request) => ({
    kind: (request.kind ?? request.engineType) as ProviderKind,
    authMode: request.authMode,
    ...(request.authHeaderStyle ? { authHeaderStyle: request.authHeaderStyle } : {}),
    ...(request.apiKey ? { apiKey: request.apiKey } : {}),
    ...(request.oauthToken ? { oauthToken: request.oauthToken } : {}),
    ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
  }))

/** Request body accepted from clients, including the legacy `engineType` alias. */
export type ProbeModelsRequest = z.input<typeof probeModelsRequestSchema>

/** Normalized request used by the API and ProviderAdapter. */
export type ResolvedProbeModelsRequest = z.output<typeof probeModelsRequestSchema>

export const probeModelsResponseSchema = z.object({
  models: z.array(z.string()),
  error: z.string().optional(),
  code: z.string().optional(),
  details: z.record(z.unknown()).optional(),
})

export type ProbeModelsResponse = z.infer<typeof probeModelsResponseSchema>

/** Compatibility alias for clients that still call the field `engineType`. */
export type ProbeEngineType = ProviderKind
