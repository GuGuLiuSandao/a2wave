import { z } from 'zod'

export const userRoleEnum = z.enum(['admin', 'user'])
export type UserRole = z.infer<typeof userRoleEnum>

export const passwordPolicySchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/\d/, 'Password must contain at least one digit')

export const setupInput = z
  .object({
    password: passwordPolicySchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
export type SetupInput = z.infer<typeof setupInput>

export const loginInput = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})
export type LoginInput = z.infer<typeof loginInput>

export const createUserInput = z.object({
  username: z.string().min(1),
  displayName: z.string().optional(),
  password: passwordPolicySchema,
})
export type CreateUserInput = z.infer<typeof createUserInput>

export const changePasswordInput = z.object({
  oldPassword: z.string().min(1),
  newPassword: passwordPolicySchema,
})
export type ChangePasswordInput = z.infer<typeof changePasswordInput>

export interface User {
  id: string
  username: string
  displayName: string | null
  role: UserRole
  isActive: boolean
  /** First-time user experience (FTUE) state, keyed by guide id. A reset deletes the key, so only these two values ever occur. */
  onboarding?: Record<string, 'completed' | 'dismissed'>
  createdAt: Date
  updatedAt: Date
}

export interface AuditLog {
  id: string
  userId: string | null
  action: string
  resource: string | null
  resourceId: string | null
  details: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: Date
}
