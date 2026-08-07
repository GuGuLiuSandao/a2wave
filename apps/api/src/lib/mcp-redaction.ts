const MASK = '********'

export function maskAllStringRecord(
  record: Record<string, string> | null | undefined,
): Record<string, string> | null | undefined {
  if (!record) return record
  return Object.fromEntries(Object.keys(record).map((key) => [key, MASK]))
}

/**
 * Keep only the origin of a remote MCP URL whenever any secret-bearing part is
 * present. Credentials can appear in userinfo, path segments, query parameters,
 * or fragments, so key-name heuristics are insufficient here.
 */
export function redactMcpUrl(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value
  try {
    const parsed = new URL(value)
    const hasSecretBearingParts = Boolean(
      parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname.replace(/^\/+$/, ''),
    )
    return hasSecretBearingParts ? `${parsed.origin}/${MASK}` : value
  } catch {
    return MASK
  }
}

export function redactMcpGroupConfig(
  groupConfig: unknown,
  options: { dropRefBackends?: boolean } = {},
): unknown {
  if (!groupConfig || typeof groupConfig !== 'object') return groupConfig
  const backends = (groupConfig as { backends?: unknown }).backends
  if (!backends || typeof backends !== 'object') return groupConfig

  return {
    backends: Object.fromEntries(
      Object.entries(backends as Record<string, Array<Record<string, unknown>>>).map(
        ([groupKey, list]) => [
          groupKey,
          list
            .filter((backend) => !options.dropRefBackends || backend.mode === 'inline')
            .map((backend) =>
              backend.mode === 'inline'
                ? {
                    ...backend,
                    url: redactMcpUrl(backend.url),
                    env: maskAllStringRecord(
                      backend.env as Record<string, string> | null | undefined,
                    ),
                    headers: maskAllStringRecord(
                      backend.headers as Record<string, string> | null | undefined,
                    ),
                  }
                : backend,
            ),
        ],
      ),
    ),
  }
}

/** Redact every credential-bearing MCP field while preserving selector metadata. */
export function redactMcpServerSecrets<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    url: redactMcpUrl(row.url),
    env: maskAllStringRecord(row.env as Record<string, string> | null | undefined),
    headers: maskAllStringRecord(row.headers as Record<string, string> | null | undefined),
    groupConfig: redactMcpGroupConfig(row.groupConfig),
  }
}
