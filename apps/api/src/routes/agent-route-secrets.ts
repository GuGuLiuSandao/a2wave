import type { A2ARouteTarget } from '@a2wave/shared'

const MASKED_SECRET = '********'

type RemoteA2ARouteTarget = Extract<A2ARouteTarget, { type: 'remote' }>

interface AgentEnvEntry {
  value: string
  sensitive: boolean
}

export function maskSensitiveEnv<T extends { env: Record<string, AgentEnvEntry> | null }>(
  agent: T,
): T {
  if (!agent.env) return agent
  const maskedEnv = Object.fromEntries(
    Object.entries(agent.env).map(([key, value]) => [
      key,
      value.sensitive ? { ...value, value: MASKED_SECRET } : value,
    ]),
  )
  return { ...agent, env: maskedEnv }
}

export function maskProviderChainConfig<T>(
  config: T,
  replacement: string | null = MASKED_SECRET,
  opts?: { revealOauth?: boolean },
): T {
  if (!config || typeof config !== 'object') return config
  const raw = config as Record<string, unknown>
  if (!Array.isArray(raw.providerChain)) return config
  const providerChain = (raw.providerChain as Array<Record<string, unknown>>).map((item) => ({
    ...item,
    ...(item.providerApiKey ? { providerApiKey: replacement } : {}),
    ...(item.providerBaseUrl ? { providerBaseUrl: replacement } : {}),
    ...(item.providerOauthToken && !opts?.revealOauth ? { providerOauthToken: replacement } : {}),
  }))
  return { ...raw, providerChain } as T
}

export function maskA2ARouteTargetSecrets(
  targets: A2ARouteTarget[] | null | undefined,
): A2ARouteTarget[] | null | undefined {
  if (!targets) return targets
  return targets.map((target) =>
    target.type === 'remote' && target.apiKey ? { ...target, apiKey: MASKED_SECRET } : target,
  )
}

function remoteA2ATargetEndpointIdentity(target: RemoteA2ARouteTarget): string {
  const connectionMode = target.connectionMode ?? 'direct'
  const protocolVersion = connectionMode === 'direct' ? (target.protocolVersion ?? '0.3') : ''
  return JSON.stringify([target.url, connectionMode, protocolVersion])
}

export function preserveA2ARouteTargetSecrets(
  nextTargets: A2ARouteTarget[] | null | undefined,
  existingTargets: A2ARouteTarget[] | null | undefined,
): { ok: true; value: A2ARouteTarget[] | null | undefined } | { ok: false; targetName: string } {
  if (!nextTargets) return { ok: true, value: nextTargets }

  const existingRemoteTargets = new Map<
    string,
    Array<{ index: number; target: RemoteA2ARouteTarget }>
  >()
  for (const [index, target] of (existingTargets ?? []).entries()) {
    if (target.type !== 'remote') continue
    const identity = remoteA2ATargetEndpointIdentity(target)
    const matches = existingRemoteTargets.get(identity) ?? []
    matches.push({ index, target })
    existingRemoteTargets.set(identity, matches)
  }

  const maskedTargets = nextTargets.flatMap((target, index) =>
    target.type === 'remote' && target.apiKey === MASKED_SECRET ? [{ index, target }] : [],
  )
  const assigned = new Map<number, RemoteA2ARouteTarget>()
  const consumedExistingIndexes = new Set<number>()

  // Prefer stable-name matches when multiple routes intentionally share one endpoint.
  for (const { index, target } of maskedTargets) {
    const candidates = existingRemoteTargets
      .get(remoteA2ATargetEndpointIdentity(target))
      ?.filter(
        (candidate) =>
          !consumedExistingIndexes.has(candidate.index) && candidate.target.name === target.name,
      )
    if (candidates?.length !== 1) continue
    assigned.set(index, candidates[0].target)
    consumedExistingIndexes.add(candidates[0].index)
  }

  // A display name may change, but one stored credential may never be cloned.
  for (const { index, target } of maskedTargets) {
    if (assigned.has(index)) continue
    const candidates = existingRemoteTargets
      .get(remoteA2ATargetEndpointIdentity(target))
      ?.filter((candidate) => !consumedExistingIndexes.has(candidate.index))
    if (candidates?.length !== 1) return { ok: false, targetName: target.name }
    assigned.set(index, candidates[0].target)
    consumedExistingIndexes.add(candidates[0].index)
  }

  const restored: A2ARouteTarget[] = []
  for (const [index, target] of nextTargets.entries()) {
    if (target.type !== 'remote' || target.apiKey !== MASKED_SECRET) {
      restored.push(target)
      continue
    }

    const stored = assigned.get(index)?.apiKey
    if (!stored || stored === MASKED_SECRET) return { ok: false, targetName: target.name }
    restored.push({ ...target, apiKey: stored })
  }
  return { ok: true, value: restored }
}
