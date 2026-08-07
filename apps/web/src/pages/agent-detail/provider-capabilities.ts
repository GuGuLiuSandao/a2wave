import type {
  AuthHeaderStyle,
  AuthMode,
  ProbeModelsRequest,
  ProviderCapabilities,
  ProviderCredentialField,
  ProviderDto,
} from '@a2wave/shared'

const MASKED_SECRET = '********'

export type ModelProbePolicy = 'autoOnMount' | 'manualButton'

export interface ProviderCredentialValues {
  authMode: AuthMode
  authHeaderStyle?: AuthHeaderStyle
  providerApiKey?: string
  providerBaseUrl?: string
  providerOauthToken?: string
}

export interface ModelProbeErrorTranslation {
  key:
    | 'agentDetail.probeNoAccountHint'
    | 'agentDetail.probeLocalSessionNotLoggedIn'
    | 'agentDetail.probeLocalSessionInvalidFormat'
    | 'agentDetail.probeLocalSessionReadFailed'
    | 'agentDetail.probeModelsError'
  values: Record<string, string>
}

/**
 * A2A routing is enabled exactly when it has targets — there is no separate
 * persisted flag, and the save path drops `a2aRouteTargets` to null when the
 * list is empty. Shared by `RouteSection` (which reports it upward) and the
 * Provider/MCP compatibility warning, so the warning cannot disagree with what
 * actually gets saved. The remote predicate requires BOTH fields, matching
 * `use-agent-form`'s save filter.
 */
export function hasConfiguredRouteTargets(input: {
  localAgentIds: readonly string[]
  remoteEntries: ReadonlyArray<{ name: string; url: string }>
}): boolean {
  return (
    input.localAgentIds.length > 0 ||
    input.remoteEntries.some((entry) => Boolean(entry.name.trim() && entry.url.trim()))
  )
}

export function hasConfiguredMcpBackedCapabilities(input: {
  mcpServerIds: readonly string[]
  routeEnabled: boolean
  localAgentIds: readonly string[]
  remoteEntries: ReadonlyArray<{ name: string; url: string }>
}): boolean {
  if (input.mcpServerIds.length > 0) return true
  if (!input.routeEnabled) return false
  return (
    input.localAgentIds.length > 0 ||
    input.remoteEntries.some((entry) => Boolean(entry.name.trim() && entry.url.trim()))
  )
}

export function providersWithoutMcpDelivery(
  chainEntries: ReadonlyArray<{ providerId: string | null; enabled: boolean }>,
  providers: ReadonlyArray<Pick<ProviderDto, 'id' | 'name' | 'capabilities'>> | undefined,
  hasMcpBackedCapabilities: boolean,
): string[] {
  if (!hasMcpBackedCapabilities || !providers) return []

  const providersById = new Map(providers.map((provider) => [provider.id, provider]))
  const names = new Set<string>()
  for (const entry of chainEntries) {
    if (!entry.enabled || !entry.providerId) continue
    const provider = providersById.get(entry.providerId)
    if (provider?.capabilities.mcpDelivery.mode === 'none') {
      names.add(provider.name)
    }
  }
  return [...names]
}

export function resolveModelProbeErrorTranslation(input: {
  providerName: string
  capabilities: ProviderCapabilities | undefined
  authMode: AuthMode
  code: string | undefined
  error: string
}): ModelProbeErrorTranslation {
  const command = input.capabilities?.localSessionLoginCommand ?? ''

  if (input.code === 'no_account_models') {
    return {
      key: 'agentDetail.probeNoAccountHint',
      values: { cli: command },
    }
  }

  if (input.authMode === 'localSession') {
    const values = {
      provider: input.providerName,
      command,
      error: input.error,
    }
    if (input.code === 'local_session_not_logged_in') {
      return { key: 'agentDetail.probeLocalSessionNotLoggedIn', values }
    }
    if (input.code === 'local_session_invalid_format') {
      return { key: 'agentDetail.probeLocalSessionInvalidFormat', values }
    }
    if (input.code === 'local_session_read_failed') {
      return { key: 'agentDetail.probeLocalSessionReadFailed', values }
    }
  }

  return {
    key: 'agentDetail.probeModelsError',
    values: { error: input.error },
  }
}

/**
 * Every Provider can enumerate models — that is a hard onboarding requirement —
 * so the only question is whether the probe runs on mount or waits for the
 * operator to supply credentials. An auth mode with no declared strategy falls
 * back to the manual button rather than hiding the model list entirely.
 */
export function modelProbePolicy(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
): ModelProbePolicy {
  // Resolved against the mode the Provider would actually run, so a persisted
  // entry naming a dropped mode still gets a sensible button shape. The probe
  // itself is NOT normalized (see buildProbeModelsRequest): it reports the stale
  // mode as `unsupportedAuthMode` so the operator is told to re-pick, rather than
  // silently probing under a mode they never selected.
  const effectiveAuthMode = normalizeAuthMode(capabilities, authMode)
  return capabilities?.modelDiscovery[effectiveAuthMode] === 'automatic'
    ? 'autoOnMount'
    : 'manualButton'
}

export function normalizeAuthMode(
  capabilities: ProviderCapabilities | undefined,
  current: AuthMode,
): AuthMode {
  if (!capabilities) return current
  return capabilities.authModes.includes(current) ? current : capabilities.defaultAuthMode
}

function credentialFieldDescriptorsFor(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
): Array<{ field: ProviderCredentialField; required: boolean }> {
  return capabilities?.credentialFields[authMode] ?? []
}

export function visibleCredentialFieldsFor(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
): ProviderCredentialField[] {
  return credentialFieldDescriptorsFor(capabilities, authMode).map(({ field }) => field)
}

export function credentialFieldIsRequired(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
  field: ProviderCredentialField,
): boolean {
  return (
    credentialFieldDescriptorsFor(capabilities, authMode).find(
      (descriptor) => descriptor.field === field,
    )?.required ?? false
  )
}

function requiredCredentialFieldsFor(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
): ProviderCredentialField[] {
  return credentialFieldDescriptorsFor(capabilities, authMode)
    .filter(({ required }) => required)
    .map(({ field }) => field)
}

function credentialValue(
  input: ProviderCredentialValues,
  field: ProviderCredentialField,
): string | undefined {
  if (field === 'apiKey') return input.providerApiKey
  if (field === 'baseUrl') return input.providerBaseUrl
  return input.providerOauthToken
}

export function buildProbeModelsRequest(
  provider: Pick<ProviderDto, 'kind' | 'capabilities'>,
  input: ProviderCredentialValues,
): {
  request?: ProbeModelsRequest
  missingFields: ProviderCredentialField[]
  maskedFields?: ProviderCredentialField[]
  unsupportedAuthMode?: boolean
} {
  // Deliberately NOT normalized: the probe must run under the mode the operator
  // sees selected. config-tab renders the auth-mode label and the credential
  // inputs from the raw entry mode (a stale mode is kept visible in the radio
  // group on purpose), so silently probing under the manifest default would send
  // credentials the user never entered and drop the ones they did — failing
  // against a field the UI never rendered. A stale mode is surfaced as
  // `unsupportedAuthMode` instead, so the caller can tell the user to re-pick.
  const authMode = input.authMode
  const requiredFields = requiredCredentialFieldsFor(provider.capabilities, authMode)
  const missingFields = requiredFields.filter((field) => !credentialValue(input, field)?.trim())
  // A persisted entry can name a mode the manifest has since dropped. Probing it
  // would fail with `unsupported_mode` on every attempt, so report it as its own
  // condition rather than emitting a request that cannot succeed.
  if (normalizeAuthMode(provider.capabilities, authMode) !== authMode) {
    return { missingFields, unsupportedAuthMode: true }
  }
  const visibleFields = new Set(visibleCredentialFieldsFor(provider.capabilities, authMode))
  const normalizedValues = {
    apiKey: input.providerApiKey?.trim(),
    baseUrl: input.providerBaseUrl?.trim(),
    oauthToken: input.providerOauthToken?.trim(),
  }
  const maskedFields = Array.from(visibleFields).filter(
    (field) => normalizedValues[field] === MASKED_SECRET,
  )
  if (maskedFields.length > 0) return { missingFields, maskedFields }
  if (missingFields.length > 0) return { missingFields }

  return {
    request: {
      kind: provider.kind,
      authMode,
      ...(provider.kind === 'claude-code' && authMode === 'apiKey'
        ? { authHeaderStyle: input.authHeaderStyle === 'bearer' ? 'bearer' : 'x-api-key' }
        : {}),
      ...(visibleFields.has('apiKey') && normalizedValues.apiKey
        ? { apiKey: normalizedValues.apiKey }
        : {}),
      ...(visibleFields.has('baseUrl') && normalizedValues.baseUrl
        ? { baseUrl: normalizedValues.baseUrl }
        : {}),
      ...(visibleFields.has('oauthToken') && normalizedValues.oauthToken
        ? { oauthToken: normalizedValues.oauthToken }
        : {}),
    },
    missingFields: [],
  }
}
