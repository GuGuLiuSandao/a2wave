/**
 * Trae execution engine
 *
 * Wraps traecli (https://docs.trae.cn/cli, ByteDance's Trae enterprise CLI) as
 * a standard a2wave AgentEngine. Since 0.120.x the headless protocol is
 * isomorphic to Claude Code's: `-p <prompt> --output-format stream-json` emits
 * a CC-style NDJSON event stream (`system/init`, `assistant`, `result`; the
 * result error text lives in the `error` field); sessions resume via
 * `--resume <session_id>`. Stream parsing is shared with qoder via
 * cc-stream-parser; process/env mechanics come from BaseCliAgentEngine.
 *
 * Key differences from claude/qoder:
 * - The model is not `-m` but a config override: `-c model.name=<model>`;
 * - The model catalog is decided by the enterprise console and listed via
 *   `traecli models` (prints nothing when logged out);
 * - The CLI is only available to TRAE CN enterprise Ultimate accounts.
 *
 * Auth modes:
 * - apiKey       → injects `TRAECLI_PERSONAL_ACCESS_TOKEN` (a CLI login token
 *                  generated in the enterprise console, `trae-lt-...`); the
 *                  enterprise-dedicated domain is injected via providerBaseUrl
 *                  → `TRAECLI_HOST`.
 * - localSession → uses the host's interactive `traecli` login state (config
 *                  dir `~/.trae`, HOME/XDG-relative); the host HOME /
 *                  XDG_CONFIG_HOME are preserved at execution time.
 * - oauth is not supported.
 *
 * Minimum required version 0.120.0: older builds lack `--output-format
 * stream-json` and the `models` subcommand (only the monolithic `--json`).
 */

import { logger } from '../lib/logger.js'
import { UnsafeUrlError } from '../lib/url-safety-core.js'
import { resolveProviderUrl } from '../lib/url-safety.js'
import { createCcStreamParser } from './cc-stream-parser.js'
import { BaseCliAgentEngine, type CliEngineBaseConfig, stripPromptArg } from './cli-engine-base.js'
import { formatExitError } from './cursor-agent.js'
import { toDisplayExecParams } from './exec-params.js'
import { createHeartbeatTracker } from './heartbeat.js'
import { runStatusProbe, truncateForRaw } from './login-status-helper.js'
import type {
  ExecuteResult,
  ListModelsOptions,
  LoginStatus,
  ModelListResult,
  StreamExecuteRequest,
} from './types.js'

const ENGINE_TYPE = 'trae'

/** Heartbeat interval for in-flight tool calls (ms). */
const TOOL_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * Credential-class env vars: authMode is the single source of truth for the
 * credential mode; agentEnv must not carry these keys to override the
 * isolation result (TRAECLI_HOST can redirect the enterprise endpoint, so it
 * is part of the credential surface too).
 */
const PROTECTED_TRAE_ENV_NAMES = ['TRAECLI_PERSONAL_ACCESS_TOKEN', 'TRAECLI_HOST'] as const

/** Lenient shape for model-id lines (`kimi-k2` / `doubao-seed-2.0`, etc.) */
const MODEL_LINE_PATTERN = /^[A-Za-z0-9._/@:-]+$/

export interface TraeAgentEngineConfig extends CliEngineBaseConfig {
  /** Deployment-level default CLI login token (per-agent providerApiKey wins) */
  apiKey: string
  /** Enterprise-dedicated domain (TRAECLI_HOST, optional) */
  host: string
  /** Whether to pass -y/--yolo to bypass tool permission checks */
  force: boolean
  /** Whether to auto-approve MCP tool calls (--allowed-tool mcp__*) */
  approveMcps: boolean
}

export class TraeAgentEngine extends BaseCliAgentEngine {
  readonly type = ENGINE_TYPE
  protected readonly cliName = 'traecli'
  private config: TraeAgentEngineConfig

  constructor(config: TraeAgentEngineConfig) {
    super(config)
    this.config = config
  }

  // ----------------------------------------------------------
  // Public: login status / model list
  // ----------------------------------------------------------

  /**
   * Probes host login state via `traecli models`.
   *
   * traecli has no dedicated auth-status subcommand; when logged in with
   * models configured in the enterprise console, `models` prints one model
   * name per line, and prints nothing (exit 0) when logged out or
   * unconfigured. The loggedIn semantics here are therefore "able to execute
   * tasks" (logged in + at least one usable model), which matches the actual
   * precondition of the execution path.
   */
  async checkLoginStatus(): Promise<LoginStatus> {
    const result = await runStatusProbe(this.config.path, ['models'], { logTag: 'trae' })
    if (result.notFound) {
      return {
        installed: false,
        loggedIn: false,
        error: `traecli not found in PATH (${this.config.path})`,
      }
    }
    if (result.timedOut) {
      return {
        installed: true,
        loggedIn: false,
        error: 'traecli models timed out',
        raw: truncateForRaw(result.stdout || result.stderr),
      }
    }
    const models = parseModelLines(result.stdout)
    const loggedIn = result.exitCode === 0 && models.length > 0
    return {
      installed: true,
      loggedIn,
      ...(loggedIn
        ? { detail: `${models.length} model(s) available`, method: 'enterprise account' }
        : {
            error:
              result.stderr.trim() ||
              'No models available (run `traecli` login on host, or set TRAECLI_PERSONAL_ACCESS_TOKEN; models are configured in the TRAE enterprise console)',
          }),
      raw: truncateForRaw(result.stdout || result.stderr),
    }
  }

  /**
   * Lists the models configured in the enterprise console via `traecli models`.
   *
   * - localSession → runs directly against the host login state
   * - apiKey       → injects TRAECLI_PERSONAL_ACCESS_TOKEN (+ optional TRAECLI_HOST)
   */
  async listAvailableModels(options: ListModelsOptions): Promise<ModelListResult> {
    if (options.authMode === 'oauth') {
      return {
        models: [],
        error: 'Trae CLI does not support oauth mode (use apiKey or localSession)',
        code: 'unsupported_mode',
      }
    }

    let env: NodeJS.ProcessEnv | undefined
    if (options.authMode === 'apiKey') {
      if (!options.apiKey) {
        return { models: [], error: 'apiKey is required for apiKey mode', code: 'invalid_input' }
      }
      if (options.baseUrl) {
        try {
          // Trae owns its network stack, so this preflight blocks stable private DNS answers but
          // cannot pin the validated addresses into the subprocess connection. The documented
          // egress requirement remains necessary against DNS rebinding.
          await resolveProviderUrl(options.baseUrl)
        } catch (error) {
          return {
            models: [],
            error:
              error instanceof UnsafeUrlError
                ? error.message
                : 'TRAECLI_HOST could not be validated safely',
            code: 'invalid_input',
          }
        }
      }
      env = {
        TRAECLI_PERSONAL_ACCESS_TOKEN: options.apiKey,
        ...(options.baseUrl ? { TRAECLI_HOST: options.baseUrl } : {}),
      }
    }

    const result = await runStatusProbe(this.config.path, ['models'], {
      logTag: 'trae-models',
      timeoutMs: 20_000,
      ...(env ? { env } : {}),
    })
    if (result.notFound) {
      return { models: [], error: 'traecli not found in PATH', code: 'spawn_failed' }
    }
    if (result.timedOut) {
      return { models: [], error: 'traecli models timed out', code: 'timeout' }
    }
    if (result.exitCode !== 0) {
      const stderrSample = truncateForRaw(result.stderr, 300)
      return {
        models: [],
        error: stderrSample || `traecli exit ${result.exitCode}`,
        code: 'cli_failed',
        details: { exitCode: result.exitCode, stderr: stderrSample },
      }
    }
    const models = parseModelLines(result.stdout)
    if (models.length === 0) {
      // Logged-out and "no models configured in the console" are both empty
      // output; give the combined guidance
      return {
        models: [],
        error:
          'traecli models returned nothing — not logged in, token invalid, or no models configured in the TRAE enterprise console',
        code: 'local_session_not_logged_in',
        details: { raw: truncateForRaw(result.stdout || result.stderr, 300) },
      }
    }
    logger.info({ count: models.length, sample: models.slice(0, 3) }, '[trae] listAvailableModels')
    return { models }
  }

  // ----------------------------------------------------------
  // Protected: execution (single model) — called by BaseAgentEngine
  // ----------------------------------------------------------

  protected async executeStreamWithModel(
    request: StreamExecuteRequest,
    model: string,
  ): Promise<ExecuteResult> {
    const {
      taskId,
      workDir,
      prompt,
      chatId: inputChatId,
      onUpdate,
      onLogEntry,
      agentConfig,
    } = request
    const perAgentApiKey = agentConfig?.providerApiKey as string | undefined
    const perAgentBaseUrl = agentConfig?.providerBaseUrl as string | undefined
    const authMode =
      (agentConfig?.authMode as 'apiKey' | 'oauth' | 'localSession' | undefined) ?? 'apiKey'
    const resolvedWorkDir = workDir || this.config.defaultWorkDir

    const streamTimeoutMinutes = agentConfig?.timeoutMinutes ?? this.config.timeoutMinutes
    const args = this.buildArgs(prompt, model, inputChatId, streamTimeoutMinutes, {
      readOnly: agentConfig?.readOnly !== undefined ? Boolean(agentConfig.readOnly) : undefined,
      force: agentConfig?.force !== undefined ? Boolean(agentConfig.force) : undefined,
      approveMcps:
        agentConfig?.approveMcps !== undefined ? Boolean(agentConfig.approveMcps) : undefined,
    })
    const resolvedApiKey = perAgentApiKey || this.config.apiKey
    const resolvedHost = perAgentBaseUrl || this.config.host
    const execEnv = this.buildCredentialEnv({
      protectedNames: PROTECTED_TRAE_ENV_NAMES,
      // apiKey mode injects the token (+ optional enterprise host);
      // localSession clears both and keeps the host HOME / XDG_CONFIG_HOME
      // (the config dir ~/.trae resolves through them)
      ...(authMode !== 'localSession'
        ? {
            inject: {
              TRAECLI_PERSONAL_ACCESS_TOKEN: resolvedApiKey,
              TRAECLI_HOST: resolvedHost,
            },
          }
        : { omitRuntimeKeys: ['HOME', 'XDG_CONFIG_HOME'] }),
      agentEnv: agentConfig?.agentEnv as Record<string, string> | undefined,
      runtimeEnv: request.runtimeContext?.env,
    })
    const streamTimeoutMs = streamTimeoutMinutes * 60 * 1000

    const execParams: Record<string, unknown> = {
      cmd: this.config.path,
      args: stripPromptArg(args),
      cwd: resolvedWorkDir,
      authMode,
      timeout: streamTimeoutMs,
      runtimeHome: request.runtimeContext?.home.dir,
      workspaceDir: request.runtimeContext?.workspace.dir,
      workspaceType: request.runtimeContext?.workspace.type,
      artifactsDir: request.runtimeContext?.artifacts.dir,
    }
    if (authMode === 'apiKey' && resolvedApiKey) {
      execParams.apiKey = `${resolvedApiKey.slice(0, 8)}***`
    }
    logger.info({ taskId, ...execParams }, '[trae] execute (stream) params')
    onLogEntry?.({
      type: 'exec_params',
      engine: 'trae',
      params: toDisplayExecParams(execParams),
      ts: Date.now(),
    })
    onLogEntry?.({ type: 'system', subtype: 'preparing', ts: Date.now() })

    const heartbeat = createHeartbeatTracker({
      intervalMs: TOOL_HEARTBEAT_INTERVAL_MS,
      emit: (entry) => onLogEntry?.(entry),
    })
    const parser = createCcStreamParser({
      onUpdate,
      onLogEntry,
      heartbeat,
      initialSessionId: inputChatId,
    })

    return this.runCliStream({
      taskId,
      args,
      env: execEnv,
      cwd: resolvedWorkDir,
      timeoutMs: streamTimeoutMs,
      onStdoutLine: parser.parseLine,
      parseStderrLines: true,
      getUsage: () => parser.state.lastUsage,
      onSpawned: () => onLogEntry?.({ type: 'system', subtype: 'spawned', ts: Date.now() }),
      cleanup: () => heartbeat.stop(),
      settle: ({ exitCode, stderr }) => {
        const { resultIsError, resultErrorText, resultReceived, outputBuffer, sessionId } =
          parser.state
        logger.info({ taskId, exitCode, resultReceived, resultIsError }, 'trae process exited')
        if (resultIsError) {
          return {
            ok: false,
            error: new Error(resultErrorText || stderr || 'Trae stream execution failed'),
            usage: parser.state.lastUsage,
          }
        }
        if (resultReceived || exitCode === 0) {
          return {
            ok: true,
            result: {
              success: true,
              output: outputBuffer,
              chatId: sessionId,
              ...(parser.state.lastUsage ? { usage: parser.state.lastUsage } : {}),
            },
          }
        }
        return {
          ok: false,
          error: new Error(formatExitError(exitCode ?? 1, stderr)),
          usage: parser.state.lastUsage,
        }
      },
    })
  }

  // ----------------------------------------------------------
  // Private: CLI args
  // ----------------------------------------------------------

  private buildArgs(
    prompt: string,
    model: string,
    chatId: string | undefined,
    timeoutMinutes: number,
    extras?: { readOnly?: boolean; force?: boolean; approveMcps?: boolean },
  ): string[] {
    const args = ['-p', prompt, '--output-format', 'stream-json']
    // The model is injected as a config override (traecli has no --model flag)
    if (model) args.push('-c', `model.name=${model}`)
    if (extras?.readOnly) {
      args.push('--permission-mode', 'plan')
    }
    if (extras?.force ?? this.config.force) {
      args.push('-y')
    }
    if (extras?.approveMcps ?? this.config.approveMcps) {
      args.push('--allowed-tool', 'mcp__*')
    }
    if (chatId) args.push('--resume', chatId)
    // Align the CLI-side per-query timeout with the engine timeout so the CLI
    // can produce its own structured timeout error
    args.push('--query-timeout', `${timeoutMinutes}m`)
    return args
  }
}

/** One model name per line; filters empty and header/notice-style lines */
function parseModelLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'MODEL' && MODEL_LINE_PATTERN.test(line))
}
