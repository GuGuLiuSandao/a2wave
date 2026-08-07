import type { GroupConfig, McpUsageScope } from '@a2wave/shared'

/**
 * True when an MCP server would introduce stdio command execution (host RCE):
 * a top-level `stdio` server, or a group with any inline `stdio` backend.
 *
 * Single source of truth shared by the create/update/clone/probe gates
 * (mcp-servers route) and the agent binding check (agents route), so "stdio =
 * admin-only" is enforced identically everywhere and can't drift.
 */
export function introducesStdioExecution(
  type: string | undefined,
  groupConfig: GroupConfig | null | undefined,
): boolean {
  if (type === 'stdio') return true
  if (type === 'group' && groupConfig) {
    for (const backends of Object.values(groupConfig.backends)) {
      for (const b of backends) {
        if (b.mode === 'inline' && b.type === 'stdio') return true
      }
    }
  }
  return false
}

/** The minimal shape needed to decide MCP access. */
export interface McpAccessRow {
  type: string | undefined
  groupConfig: GroupConfig | null | undefined
  usageScope: McpUsageScope
  userId: string | null
}

/**
 * Resolve the usage scope to PERSIST when creating/updating an MCP server.
 * stdio-capable servers are ALWAYS 'admin-only' regardless of the submitted
 * value — they execute host commands. For non-stdio servers an admin may pick a
 * scope; anyone else (and any absent value) gets the schema default.
 *
 * `requested` is what the caller submitted; `isAdmin` gates whether a non-default
 * scope is honored; `fallback` is the current/default scope for non-admins.
 */
export function resolveUsageScope(params: {
  type: string | undefined
  groupConfig: GroupConfig | null | undefined
  requested: McpUsageScope | undefined
  isAdmin: boolean
  /**
   * Scope to keep when nothing else applies. For a fresh create pass 'private' —
   * a non-admin's own non-stdio server is owner-only by default (its URL/headers/
   * env are private credentials; it is NOT shared implicitly). For an update, pass
   * the existing scope.
   */
  fallback: McpUsageScope
}): McpUsageScope {
  // stdio-capable executes host commands → always admin-only, no matter what was
  // submitted (a non-admin can't even create one; an admin can't widen it).
  if (introducesStdioExecution(params.type, params.groupConfig)) return 'admin-only'
  if (params.isAdmin && params.requested) {
    // Admins may set any scope, including sharing to all-users.
    return params.requested
  }
  if (!params.isAdmin && params.requested) {
    // A non-admin may pick 'private' but NEVER 'all-users' (only admins share) and
    // never 'admin-only' (nonsensical for a self-owned server) — clamp both to the
    // fallback ('private' on create).
    return params.requested === 'private' ? 'private' : params.fallback
  }
  return params.fallback
}

/**
 * The SINGLE predicate for "may a non-admin caller bind/run this MCP on their own
 * agent". Reads ONLY the persisted usage_scope + ownership — never the owner's
 * current role — so this is the true single source of truth (promoting/demoting an
 * owner never changes who can use a server). Admins bypass this (checked by the
 * caller). Pure and unit-testable.
 *
 * Allowed iff:
 *   - 'all-users': explicitly shared to everyone (only an admin can set this at
 *     write time) → any non-admin may bind it; OR
 *   - 'private': the caller OWNS it (userId === callerId) → self-service.
 *   - 'admin-only': admins only → a non-admin is always denied (this includes every
 *     stdio server, which is forced admin-only at write time).
 * A builtin (userId === null) is bindable when its scope is 'all-users'.
 */
export function canNonAdminUseMcp(row: McpAccessRow, callerId: string | null | undefined): boolean {
  if (row.usageScope === 'all-users') return true
  if (row.usageScope === 'private') return row.userId != null && row.userId === callerId
  return false // 'admin-only'
}
