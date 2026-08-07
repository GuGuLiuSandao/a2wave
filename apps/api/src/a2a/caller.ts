/**
 * A2A caller-identity HTTP headers + helpers.
 *
 * The legacy `extractA2ACallerInfo` / `A2ACallerInfo` / `A2ACallerIdaasUser`
 * exports were retired in favour of the unified `RunChannelContext` shape (see
 * `apps/api/src/lib/run-channel.ts`). This file now only exposes:
 *
 *   - The 3 wire-protocol header constants used between a2wave-agent-router
 *     (sub-agent caller) and the gateway/A2A receiver.
 *   - `encodeCallerAgentNameHeader`: base64url helper used by the sub-agent
 *     caller to safely encode unicode agent names.
 *   - `extractCallerAgentFromHeaders`: small Hono `Context` helper that returns
 *     `{ agentId?, agentName? }` or undefined; consumed by the gateway-channel
 *     builder.
 */
import type { Context } from 'hono'

export const A2WAVE_CALLER_AGENT_ID_HEADER = 'X-A2WAVE-Caller-Agent-Id'
export const A2WAVE_CALLER_AGENT_NAME_HEADER = 'X-A2WAVE-Caller-Agent-Name'
export const A2WAVE_CALLER_AGENT_NAME_B64_HEADER = 'X-A2WAVE-Caller-Agent-Name-B64'

/**
 * Forward the upstream RunChannelContext (base64url JSON) so downstream agents
 * can preserve the original user identity across a2a hops.
 */
export const X_A2WAVE_CHANNEL_B64_HEADER = 'X-A2WAVE-Channel-B64'

export function encodeCallerAgentNameHeader(agentName: string): string {
  return Buffer.from(agentName, 'utf8').toString('base64url')
}

function decodeCallerAgentNameHeader(encoded?: string): string | undefined {
  if (!encoded) return undefined
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Pull the caller-agent identity from the inbound HTTP headers.
 *
 * Returns undefined when neither id nor name is present. Note: this helper is
 * deliberately neutral about authentication — it just reads what's on the wire.
 * It is the *caller's* job (see `buildGatewayChannel`) to refuse to honor these
 * headers when the request was authenticated via OAuth (anti-spoof: an end-user
 * token must not be allowed to impersonate an internal a2wave agent).
 */
export function extractCallerAgentFromHeaders(
  c: Context,
): { agentId?: string; agentName?: string } | undefined {
  const agentId = c.req.header(A2WAVE_CALLER_AGENT_ID_HEADER) || undefined
  const agentName =
    c.req.header(A2WAVE_CALLER_AGENT_NAME_HEADER) ||
    decodeCallerAgentNameHeader(c.req.header(A2WAVE_CALLER_AGENT_NAME_B64_HEADER))

  if (!agentId && !agentName) return undefined
  return {
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
  }
}
