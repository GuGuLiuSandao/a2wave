import type { AgentPermission } from '@a2wave/shared'
/**
 * Agent permission helpers — single source of truth for agent visibility & write rules.
 *
 * Permission model:
 *   - admin → 'owner' for every agent (matches owner-filter.ts behavior)
 *   - agents.userId === currentUserId → 'owner'
 *   - row in agent_members → 'editor' | 'viewer'
 *   - else → null (caller cannot see this agent at all → 404 in routes)
 *
 * Edge case: agents.userId IS NULL (legacy/system agents) — only admin can access them.
 * Even if a row exists in agent_members for a NULL-owner agent, non-admin callers see null;
 * we therefore skip the membership query for null-owner agents to keep the contract tight.
 */
import { type SQL, and, eq, or, sql } from 'drizzle-orm'
import { type SQLiteColumn, alias } from 'drizzle-orm/sqlite-core'
import type { Context } from 'hono'
import { db } from '../db/client.js'
import { agentMembers, agents, artifacts, runs } from '../db/schema.js'
import { ForbiddenError, NotFoundError } from './errors.js'

export type AgentWithPermission = {
  agent: typeof agents.$inferSelect
  permission: AgentPermission
}

function getRole(c: Context): string {
  return c.get('userRole' as never) as string
}

function getUserId(c: Context): string {
  return c.get('userId' as never) as string
}

/**
 * Pure permission derivation from an already-loaded agent row.
 * Does NOT issue any DB query.
 *
 * Returns null for the "needs membership lookup" case — callers should use
 * loadAgentWithPerm() when they need full resolution.
 */
export function getAgentPermission(
  c: Context,
  agent: typeof agents.$inferSelect,
): AgentPermission | null {
  const role = getRole(c)
  if (role === 'admin') return 'owner'

  // Non-admin caller, agent has no owner → invisible regardless of agent_members rows.
  if (agent.userId === null) return null

  const me = getUserId(c)
  if (agent.userId === me) return 'owner'

  // Caller is non-admin and not the agent's owner — needs membership lookup.
  return null
}

/**
 * Load an agent + resolve caller permission in at most 2 DB queries.
 * Returns null if the agent does not exist OR the caller has no permission at all.
 */
export async function loadAgentWithPerm(
  c: Context,
  agentId: string,
): Promise<AgentWithPermission | null> {
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent) return null

  const fast = getAgentPermission(c, agent)
  if (fast !== null) return { agent, permission: fast }

  // At this point: caller is non-admin, agent.userId is not the caller's id.
  // null-owner agents are already handled by getAgentPermission (returns null) — short-circuit.
  if (agent.userId === null) return null

  const me = getUserId(c)
  const member = (
    await db
      .select({ role: agentMembers.role })
      .from(agentMembers)
      .where(and(eq(agentMembers.agentId, agentId), eq(agentMembers.userId, me)))
      .limit(1)
  )[0]
  if (!member) return null
  return { agent, permission: member.role as AgentPermission }
}

/**
 * `<agentIdColumn> IN (agents readable by me)` — the ONE SQL rendering of the
 * permission model. Every read filter below routes through it so the predicates
 * cannot drift apart from each other or from loadAgentWithPerm.
 *
 * Both arms exclude null-owner (legacy / system) agents, matching
 * getAgentPermission's "only admin sees them" rule:
 *   - the owner arm for free (`agents.user_id = :me` is never true for NULL);
 *   - the membership arm only because it joins `agents` and requires a non-null
 *     owner. Without that join a stale `agent_members` row would resurrect a
 *     legacy agent — a reachable state, since requireAgentOwner treats admin as
 *     owner of every agent and so lets an admin add members to one.
 *
 * A raw subquery (instead of drizzle's `inArray(col, db.select(...))`) keeps the
 * helper free of any runtime DB handle — pure, and trivially unit-testable.
 * `me` is bound as a parameter; never string-concatenated.
 *
 * The tables are ALIASED because callers embed this filter in queries that already
 * join `agents` — `/runs/leaderboard` and `/runs/stats` both do. Reusing the bare
 * name works today only because every arm carries its own FROM/JOIN and so binds to
 * the inner scope; drop one of those in a future edit and the name would silently
 * resolve to the OUTER row, turning the predicate into a tautology that leaks every
 * run. The alias removes that failure mode instead of relying on scoping luck.
 */
function readableAgentSubquery(agentIdColumn: SQLiteColumn, me: string): SQL<unknown> {
  // Aliased inside the function, not at module scope: a top-level `alias(agents, …)`
  // would touch the schema module the moment this file is imported, breaking every
  // test that mocks `db/schema.js` without re-exporting `agents`. `alias()` renders
  // only the alias name in a raw sql template, so the `AS` binding is written as
  // static template text; column references still come from these objects, so a
  // rename in schema.ts keeps propagating instead of drifting from a literal string.
  const readableAgents = alias(agents, 'readable_agents')
  const readableMembers = alias(agentMembers, 'readable_agent_members')

  return sql`${agentIdColumn} IN (
    SELECT ${readableAgents.id} FROM ${agents} AS readable_agents
     WHERE ${readableAgents.userId} = ${me}
    UNION
    SELECT ${readableMembers.agentId} FROM ${agentMembers} AS readable_agent_members
      JOIN ${agents} AS readable_agents
        ON ${readableAgents.id} = ${readableMembers.agentId}
     WHERE ${readableMembers.userId} = ${me} AND ${readableAgents.userId} IS NOT NULL
  )`
}

/**
 * SQL filter for `GET /agents` listing.
 * - admin → undefined (no filter)
 * - non-admin → agents readable by me (owner or member; never a null-owner agent)
 */
export function getAgentReadFilter(c: Context): SQL<unknown> | undefined {
  const role = getRole(c)
  if (role === 'admin') return undefined

  return readableAgentSubquery(agents.id, getUserId(c))
}

/**
 * SQL filter for run reads (`GET /runs`, `/runs/:id`, `/runs/stats`, ...).
 *
 * A Run carries no ownership of its own: `runs.user_id` records *who triggered
 * it*, and the channels without a logged-in a2wave user do not agree on what to
 * put there — Feishu, gateway API key and OAuth leave it NULL, while A2A,
 * schedule and Slack/Discord stamp the agent owner. Gating reads on that column
 * therefore hid an agent's entire production traffic from its own non-admin
 * owner (the NULL cases), and hid every run from editor/viewer members (all of
 * them). Visibility is derived from the **agent** instead,
 * which is the resource the permission model actually governs — the same
 * contract `GET /agents/:id/stats` and `/agents/:id/chats` already apply.
 *
 * - admin → undefined (no filter)
 * - non-admin → runs.user_id = me
 *               OR runs.initiator_agent_id IN (agents readable by me)
 *
 * The `runs.user_id = me` arm is not redundant: it keeps agent-less REST runs
 * (`POST /runs` with no initiatorAgentId) and runs on an agent that was later
 * un-shared visible to the person who triggered them.
 */
export function getRunReadFilter(c: Context): SQL<unknown> | undefined {
  const role = getRole(c)
  if (role === 'admin') return undefined

  const me = getUserId(c)
  return or(eq(runs.userId, me), readableAgentSubquery(runs.initiatorAgentId, me))
}

/**
 * SQL filter for artifact listing (`GET /artifacts?runId=|agentId=`).
 *
 * Same defect class as runs, one hop further: `artifacts.user_id` is inherited
 * from the run that produced the artifact, so it is NULL for exactly the same
 * channels. The run-detail drawer only renders its "运行产物" block when this
 * list is non-empty, so the entire block used to vanish for the agent's own
 * non-admin owner — while the download link inside the agent's reply kept
 * working, leaving one page asserting both that the file exists and that it
 * does not.
 */
export function getArtifactReadFilter(c: Context): SQL<unknown> | undefined {
  const role = getRole(c)
  if (role === 'admin') return undefined

  const me = getUserId(c)
  return or(eq(artifacts.userId, me), readableAgentSubquery(artifacts.agentId, me))
}

/**
 * Row-level counterpart of the two filters above, for endpoints that already
 * hold the row (artifact download / delete, run cancel).
 *
 * `read` mirrors the SQL filter exactly. `write` is deliberately stricter than
 * read: a viewer member may list an agent's runs and artifacts but must not
 * cancel or delete what other people produced — while still being able to act
 * on what they triggered themselves (`viewer can read + chat debug`), which is
 * why the row's own trigger identity is checked before the agent permission.
 *
 * A row with neither a trigger identity nor an agent has nothing to authorize
 * against and is denied to everyone but admin.
 */
export async function hasAgentScopedAccess(
  c: Context,
  row: { userId: string | null; agentId: string | null },
  need: 'read' | 'write',
): Promise<boolean> {
  if (getRole(c) === 'admin') return true
  if (row.userId && row.userId === getUserId(c)) return true
  if (!row.agentId) return false
  const access = await loadAgentWithPerm(c, row.agentId)
  if (!access) return false
  return need === 'read' || access.permission !== 'viewer'
}

/** Guard: requires at least read permission. 404 on miss. */
export async function requireAgentRead(c: Context, agentId: string): Promise<AgentWithPermission> {
  const result = await loadAgentWithPerm(c, agentId)
  if (!result) throw new NotFoundError('Agent')
  return result
}

/** Guard: requires write permission (owner | editor). 404 on miss, 403 on viewer. */
export async function requireAgentWrite(c: Context, agentId: string): Promise<AgentWithPermission> {
  const result = await loadAgentWithPerm(c, agentId)
  if (!result) throw new NotFoundError('Agent')
  if (result.permission === 'viewer') {
    throw new ForbiddenError('Write access required')
  }
  return result
}

/** Guard: requires owner (admin counts as owner). 404 on miss, 403 on non-owner. */
export async function requireAgentOwner(c: Context, agentId: string): Promise<AgentWithPermission> {
  const result = await loadAgentWithPerm(c, agentId)
  if (!result) throw new NotFoundError('Agent')
  if (result.permission !== 'owner') {
    throw new ForbiddenError('Owner access required')
  }
  return result
}
