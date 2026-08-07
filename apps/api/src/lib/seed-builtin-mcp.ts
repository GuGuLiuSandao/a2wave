import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { mcpServers } from '../db/schema.js'
import { env } from '../env.js'
import { createId } from './id.js'
import { logger } from './logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER_MCP_NAME = 'a2wave-agent-router'
const PLATFORM_ADMIN_MCP_NAME = 'a2wave-platform-admin'

/**
 * Names of platform-seeded stdio builtins that are safe for ANY agent owner
 * (their command/args are platform-controlled, so the runtime non-admin stdio
 * guard must not drop them — else A2A routing breaks for non-admin agents).
 *
 * `platform-admin` is deliberately NOT here: it exposes global MCP, Provider,
 * Settings, user, and audit data, so it is classified separately as a
 * control-plane-only builtin.
 */
const OWNER_SAFE_BUILTIN_MCP_NAMES: ReadonlySet<string> = new Set([ROUTER_MCP_NAME])
const CONTROL_PLANE_ONLY_BUILTIN_MCP_NAMES: ReadonlySet<string> = new Set([PLATFORM_ADMIN_MCP_NAME])

/**
 * True only for a genuine platform builtin that any agent owner may run. The
 * name alone is NOT trusted — `mcp_servers.name` has no UNIQUE constraint, so an
 * admin could seed a same-named stdio row and, after demotion, have it wrongly
 * treated as the safe router. Real builtins are seeded with `userId === null`
 * (user-created rows always carry a userId), which is not forgeable through the
 * API, so we require BOTH the builtin name AND system ownership.
 */
export function isOwnerSafeBuiltinMcp(name: string, userId: string | null): boolean {
  return userId === null && OWNER_SAFE_BUILTIN_MCP_NAMES.has(name)
}

/** True only for a system-owned builtin that requires the current backend requester to be admin. */
export function isControlPlaneOnlyBuiltinMcp(name: string, userId: string | null): boolean {
  return userId === null && CONTROL_PLANE_ONLY_BUILTIN_MCP_NAMES.has(name)
}

function resolveStdioCommand(command: string): string {
  const base = command.trim().toLowerCase()
  if (base !== 'npx' && base !== 'node') return command
  const nodeDir = dirname(process.execPath)
  const name = process.platform === 'win32' ? (base === 'npx' ? 'npx.cmd' : 'node.exe') : base
  return join(nodeDir, name)
}

export interface BuiltinMcpConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

interface BuiltinMcpDefinition {
  name: string
  description: string
  config: BuiltinMcpConfig
  /** Persisted usage scope. Defaults to 'admin-only' like every stdio server. */
  usageScope?: 'admin-only' | 'all-users'
}

export function resolveBuiltinMcpConfig(name: string = ROUTER_MCP_NAME): BuiltinMcpConfig {
  const isDev = env.NODE_ENV !== 'production'
  const extension = isDev ? 'ts' : 'js'
  const runtimeCommand = isDev ? 'npx' : 'node'
  const runtimeArgs = isDev ? ['tsx'] : []
  // Dev: __dirname = src/lib/ → resolve('..', 'mcp-servers') = src/mcp-servers/
  // Prod: __dirname = dist/   → resolve('mcp-servers')       = dist/mcp-servers/
  const scriptPath = isDev
    ? resolve(__dirname, '..', 'mcp-servers', `${name}.${extension}`)
    : resolve(__dirname, 'mcp-servers', `${name}.${extension}`)

  return {
    command: resolveStdioCommand(runtimeCommand),
    args: [...runtimeArgs, scriptPath],
    env: {
      A2WAVE_API_URL: `http://127.0.0.1:${env.PORT}`,
      // The spawned router receives only this declared env. Always propagate
      // the policy so an explicit public-only setting cannot be mistaken for
      // the router's private-network-friendly default.
      ...(name === ROUTER_MCP_NAME
        ? { A2WAVE_ALLOW_PRIVATE_ROUTE_TARGETS: env.ALLOW_PRIVATE_ROUTE_TARGETS ? '1' : '0' }
        : {}),
      ...(name === ROUTER_MCP_NAME && env.TRUSTED_A2A_ROUTE_HOSTS
        ? { A2WAVE_TRUSTED_A2A_ROUTE_HOSTS: env.TRUSTED_A2A_ROUTE_HOSTS }
        : {}),
      ...(name === 'a2wave-mcp-group-proxy' && env.TRUSTED_MCP_HOSTS
        ? { A2WAVE_TRUSTED_MCP_HOSTS: env.TRUSTED_MCP_HOSTS }
        : {}),
    },
  }
}

function getBuiltinDefinitions(): BuiltinMcpDefinition[] {
  return [
    {
      name: ROUTER_MCP_NAME,
      description:
        '内置 MCP Server，通过 A2A 协议路由请求到其他 Agent。提供 list_agents、get_agent_card 和 invoke_agent 工具。',
      config: resolveBuiltinMcpConfig(ROUTER_MCP_NAME),
      // Router is platform-controlled and usable by any agent (also exempted at
      // runtime via isOwnerSafeBuiltinMcp).
      usageScope: 'all-users',
    },
    {
      name: PLATFORM_ADMIN_MCP_NAME,
      description:
        'a2wave 平台管理内置 MCP Server。提供只读工具，用于管理 Agent、Run、MCP Server、Skill、Provider、设置、用户和审计日志。仅管理员可用。',
      config: resolveBuiltinMcpConfig(PLATFORM_ADMIN_MCP_NAME),
      usageScope: 'admin-only',
    },
  ]
}

export async function seedBuiltinMcpServers(): Promise<void> {
  for (const builtin of getBuiltinDefinitions()) {
    // Match ONLY the real system row (userId IS NULL). A builtin name is not unique,
    // so a non-admin could have created a same-named row; if we matched by name alone
    // we would (a) promote that user row's usageScope on every restart, and (b) treat
    // the user row as "the builtin exists" and never create the real system one.
    const existing = (
      await db
        .select()
        .from(mcpServers)
        .where(and(eq(mcpServers.name, builtin.name), isNull(mcpServers.userId)))
        .limit(1)
    )[0]

    if (!existing) {
      const id = createId('mcp')
      await db.insert(mcpServers).values({
        id,
        name: builtin.name,
        description: builtin.description,
        type: 'stdio',
        command: builtin.config.command,
        args: builtin.config.args,
        env: builtin.config.env,
        isEnabled: true,
        usageScope: builtin.usageScope ?? 'admin-only',
        userId: null,
      })
      logger.info(`Seeded built-in MCP Server: ${builtin.name} (${id})`)
      continue
    }

    // Update by PRIMARY KEY of the real system row so a same-named user row is never
    // touched. Re-assert type/command/args/env/scope (migration 0087 only backfilled
    // sse/http, so a pre-existing stdio builtin would otherwise diverge from intent).
    await db
      .update(mcpServers)
      .set({
        type: 'stdio',
        command: builtin.config.command,
        args: builtin.config.args,
        env: builtin.config.env,
        description: builtin.description,
        isEnabled: true,
        usageScope: builtin.usageScope ?? 'admin-only',
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, existing.id))
    logger.info(`Updated built-in MCP Server: ${builtin.name}`)
  }
}
