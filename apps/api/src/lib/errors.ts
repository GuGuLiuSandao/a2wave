export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, `${resource} not found`, 'NOT_FOUND')
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, 'VALIDATION_ERROR')
  }
}

export class EngineError extends AppError {
  constructor(message: string) {
    super(502, message, 'ENGINE_ERROR')
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message, 'CONFLICT')
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN')
  }
}

export class ProviderConfigurationError extends AppError {
  constructor(
    public readonly providerId: string,
    public readonly providerKind: string,
    // Subclasses describing a different flavour of "this Agent's provider config
    // is broken" override these while staying in the same catch block.
    message = `Provider "${providerId}" has unsupported kind "${providerKind}"; correct the Provider configuration before retrying`,
    code = 'PROVIDER_CONFIGURATION_ERROR',
  ) {
    super(409, message, code)
  }
}

/**
 * A providerChain was configured but resolved to nothing usable — every entry is
 * disabled, or points at a Provider that has since been deleted. Raised instead
 * of proceeding unbound: with no provider, engineType silently defaults to
 * 'cursor' and the run fails deep inside the CLI with no credentials, which is
 * far harder to diagnose than this.
 *
 * Extends ProviderConfigurationError so the gateway / oauth-gateway routes that
 * already translate that class into a 424 AGENT_CONFIGURATION_ERROR keep working
 * — this is the same category of fault (the Agent's provider config is broken and
 * the caller must contact its owner), and a bare AppError would instead escape to
 * the generic 500 handler.
 */
export class UnusableProviderChainError extends ProviderConfigurationError {
  constructor(public readonly agentId: string) {
    super(
      '(none)',
      '(unresolved)',
      `Agent "${agentId}" has no usable provider: every entry in its provider chain is disabled or refers to a deleted Provider`,
      'UNUSABLE_PROVIDER_CHAIN',
    )
  }
}

/**
 * A providerChain longer than PROVIDER_CHAIN_MAX reached execution.
 *
 * The create/update schema caps chain length, but it is not the only writer:
 * import and clone copy `config` verbatim, and rows written before the cap
 * existed are never revalidated. Enforced at execution as well so the cap is a
 * system invariant rather than a property of one code path — an oversized chain
 * otherwise multiplies into (maxRetries + 1) × chainLength subprocess launches,
 * which is exactly the resource ceiling the cap exists to impose.
 *
 * Fails loudly instead of truncating: silently dropping providers would run the
 * Agent on a configuration its owner never approved.
 */
export class ProviderChainTooLongError extends ProviderConfigurationError {
  constructor(
    public readonly agentId: string,
    public readonly chainLength: number,
    public readonly max: number,
  ) {
    super(
      '(none)',
      '(too-long)',
      `Agent "${agentId}" has ${chainLength} providers in its chain, exceeding the maximum of ${max}; remove entries before running it`,
      'PROVIDER_CHAIN_TOO_LONG',
    )
  }
}

/**
 * An enabled Provider binding violates its capability manifest — for example,
 * apiKey mode is missing the required Agent-scoped key. Enforcing this while
 * resolving the binding keeps publish/resume/live-PATCH preflight and runtime
 * execution on the same contract; otherwise an Agent can activate successfully
 * and fail only after a CLI process is started.
 */
export class ProviderBindingInvalidError extends ProviderConfigurationError {
  constructor(
    public readonly agentId: string,
    public readonly bindingId: string,
    providerId: string,
    providerKind: string,
    providerName: string,
    public readonly validationCode: 'unsupported_mode' | 'invalid_input' | undefined,
    public readonly missingFields: readonly string[],
    validationMessage: string,
  ) {
    super(
      providerId,
      providerKind,
      `Agent "${agentId}" has an invalid binding "${bindingId}" for Provider "${providerName}" (${providerKind}): ${validationMessage}`,
      'PROVIDER_BINDING_INVALID',
    )
  }
}

/**
 * An Agent configured an MCP-backed capability while at least one enabled
 * Provider cannot receive MCP servers. Failing during config resolution keeps
 * the saved Agent and the runtime behavior honest: silently dropping tools for
 * one entry in a fallback chain would execute a materially different Agent.
 *
 * Extends ProviderConfigurationError so every invocation channel translates it
 * to the existing caller-facing Agent configuration error boundary.
 */
export class ProviderMcpUnsupportedError extends ProviderConfigurationError {
  constructor(
    public readonly agentId: string,
    providerId: string,
    providerKind: string,
    providerName: string,
  ) {
    super(
      providerId,
      providerKind,
      `Agent "${agentId}" uses MCP-backed capabilities, but Provider "${providerName}" (${providerKind}) does not support MCP delivery; remove mounted MCP Servers and A2A routes, or choose a Provider with MCP support`,
      'PROVIDER_MCP_UNSUPPORTED',
    )
  }
}
