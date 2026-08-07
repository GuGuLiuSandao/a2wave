import { z } from 'zod'

// ============================================================
// Environment variable schema — general purpose, still used by Agent
// ============================================================

export const envEntrySchema = z.object({
  value: z.string(),
  sensitive: z.boolean().default(false),
})

export type EnvEntry = z.infer<typeof envEntrySchema>

/** Agent environment variables: key -> { value, sensitive } */
export type AgentEnv = Record<string, { value: string; sensitive: boolean }>
