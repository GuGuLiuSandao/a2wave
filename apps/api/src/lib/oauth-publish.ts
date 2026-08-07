/**
 * OAuth access-scope rules applied when publishing an Agent.
 *
 * Extracted from the publish route so the two rules that must agree — what gets persisted, and
 * what is rejected — sit next to each other rather than 20 lines apart in a 3000-line handler.
 */

export type OauthAccessMode = 'all_idaas_users' | 'specified_users'

/**
 * The allowlist column value to persist, or `undefined` to leave the stored one untouched.
 *
 * Under `specified_users` the client's list is written when supplied, so an owner can edit the
 * roster without re-selecting the mode. Under `all_idaas_users` the column is **nulled**:
 * leaving a stale list behind would silently re-restrict the Agent the moment someone switched
 * the mode back, using addresses nobody had reviewed since.
 */
export function resolveOauthAllowedEmailsUpdate(
  mode: OauthAccessMode,
  submitted: string[] | null | undefined,
): string[] | null | undefined {
  if (mode !== 'specified_users') return null
  return submitted === undefined ? undefined : submitted
}

/**
 * Is this publish about to create an OAuth channel that denies every caller?
 *
 * `specified_users` with an empty effective list is a live channel that 403s everyone — a
 * broken Agent rather than a deliberate setting. The frontend blocks it too, but that gate is
 * the friendly early warning: CLI and API clients reach the route directly, as do the Agents
 * migration 0100 landed on an empty list.
 */
export function isOauthAllowlistMissing(input: {
  channels: string[]
  mode: OauthAccessMode
  /** The value headed for the column: `undefined` means "keep what is stored". */
  update: string[] | null | undefined
  stored: string[] | null | undefined
}): boolean {
  if (!input.channels.includes('oauth') || input.mode !== 'specified_users') return false
  const effective = (input.update === undefined ? input.stored : input.update) ?? []
  return effective.length === 0
}

export const OAUTH_ALLOWED_EMAILS_REQUIRED = {
  error:
    'OAuth channel with the "specified users" access scope requires at least one allowed email.',
  code: 'OAUTH_ALLOWED_EMAILS_REQUIRED',
} as const
