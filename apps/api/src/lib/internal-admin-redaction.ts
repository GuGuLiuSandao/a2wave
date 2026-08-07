import type { SettingsMap } from '@a2wave/shared'

const INTERNAL_ADMIN_SETTINGS_KEYS: Record<string, ReadonlySet<string>> = {
  general: new Set(['teamName', 'timeoutMinutes']),
  branding: new Set(['subtitle', 'faviconUrl']),
  webhook: new Set(['enabled', 'type', 'maxRetries']),
  artifacts: new Set(['retentionHours', 'requireAuthForDownload']),
  attachments: new Set([
    'stagingTtlHours',
    'maxFileSizeBytes',
    'maxFilesPerRequest',
    'allowedExtensions',
  ]),
  evaluation: new Set(['maxConcurrency']),
  dataRetention: new Set(['enabled', 'retentionDays']),
  templates: new Set(['providerModel']),
  auth: new Set([
    'oauthEnabled',
    'oauthAllowedEmailDomains',
    'oauthDefaultRole',
    'oauthAutoProvision',
    'passwordLoginEnabled',
  ]),
}

/**
 * The platform-admin Agent needs operational state, not credentials, encrypted
 * key material, webhook capability URLs, or local storage paths.
 */
export function redactSettingsForInternalAdmin(settings: SettingsMap): SettingsMap {
  const redacted: SettingsMap = {}
  for (const [category, values] of Object.entries(settings)) {
    const allowedKeys = INTERNAL_ADMIN_SETTINGS_KEYS[category]
    if (!allowedKeys) continue
    const kept = Object.fromEntries(Object.entries(values).filter(([key]) => allowedKeys.has(key)))
    if (Object.keys(kept).length > 0) redacted[category] = kept
  }
  return redacted
}

/** Provider scripts, local paths, and extension config are not needed for monitoring. */
export function toInternalAdminProviderDto(provider: Record<string, unknown>) {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    description: provider.description,
    isPreset: provider.isPreset,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  }
}
