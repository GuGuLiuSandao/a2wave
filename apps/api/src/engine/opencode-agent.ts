/**
 * OpenCode execution engine
 *
 * Wraps the opencode CLI (https://opencode.ai) as a standard a2wave
 * AgentEngine implementation.
 *
 * Core capabilities:
 * - Executes tasks via `opencode run --format json` (NDJSON event stream)
 * - Session resumption (every event line carries a sessionID; `--session <id>`
 *   resumes natively)
 * - MCP injection: merged with the user's global config via the
 *   `OPENCODE_CONFIG_CONTENT` env var (observed merge semantics on 1.18.x —
 *   provider definitions are not clobbered); no workspace files written, the
 *   user repo is untouched
 * - Process timeout & zombie-process protection (via BaseCliAgentEngine)
 *
 * Auth modes (v1): localSession only — OpenCode is a BYO multi-provider CLI;
 * credentials (`~/.local/share/opencode/auth.json`) and provider definitions
 * (`~/.config/opencode/`) are configured host-side as a **deployment-level
 * shared account**, not per-agent credentials. Execution therefore must keep
 * the host `HOME` and `XDG_CONFIG_HOME` (omit the runtime isolation override).
 *
 * Common capabilities (provided by BaseAgentEngine): prompt assembly + safety
 * wrapping, model fallback.
 */

import { unsetEnv } from '../lib/env-utils.js'
import { logger } from '../lib/logger.js'
import { BaseCliAgentEngine, type CliEngineBaseConfig } from './cli-engine-base.js'
import { formatExitError } from './cursor-agent.js'
import { toDisplayExecParams } from './exec-params.js'
import { createHeartbeatTracker } from './heartbeat.js'
import { runStatusProbe, truncateForRaw } from './login-status-helper.js'
import type { ResolvedMcpServer } from './mcp-sync.js'
import { parseOpencodeStreamLine } from './opencode-stream-parser.js'
import {
  buildSafeAgentProcessEnv,
  omitRuntimeEnvKeys,
  sanitizeAgentRuntimeEnv,
} from './runtime-context.js'
import type {
  ExecuteResult,
  ListModelsOptions,
  LoginStatus,
  ModelListResult,
  StreamExecuteRequest,
  TokenUsage,
} from './types.js'
import { accumulateUsage, mapOpencodeUsage } from './usage.js'

const ENGINE_TYPE = 'opencode'

/** Heartbeat interval for in-flight tool calls (ms). */
const TOOL_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * agentEnv blocklist (aligned with codex's PROTECTED_CODEX_ENV_NAMES pattern).
 *
 * localSession = deployment-level shared account: any Agent editor can write
 * agentEnv; if the env vars below leak through, provider endpoints can be
 * redirected / configs replaced, routing the host's shared credentials to an
 * attacker:
 * - `OPENCODE_CONFIG` (config file path, confirmed to be loaded) and
 *   `OPENCODE_CONFIG_CONTENT` (the platform-managed injection channel) — both
 *   can redefine providers/MCP wholesale;
 * - `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` (referenced by the binary,
 *   confirmed) and sibling key/base env vars — a base-URL redirect sends the
 *   host auth.json keys to an attacker endpoint;
 * - `HOME` / `XDG_DATA_HOME` / `PATH` / `NODE_OPTIONS` — credential directory
 *   and subprocess injection vectors;
 * - `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` / `DYLD_LIBRARY_PATH` — dynamic
 *   linker injection: `--auto` spawns dynamically linked tool subprocesses
 *   (bash/git/node); once these take effect it is arbitrary native code
 *   execution in the container, reading the shared auth.json directly.
 *
 * The key set stays aligned with codex's PROTECTED_CODEX_ENV_NAMES (including
 * the three dynamic-linker keys).
 */
const PROTECTED_OPENCODE_ENV_NAMES = new Set([
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'PATH',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
])

/** Filter protected keys; return the remaining env + dropped key names (for troubleshooting logs). */
function stripProtectedOpencodeEnv(env?: Record<string, string>): {
  env: Record<string, string> | undefined
  dropped: string[]
} {
  if (!env) return { env: undefined, dropped: [] }
  const dropped: string[] = []
  const kept = Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      if (PROTECTED_OPENCODE_ENV_NAMES.has(key)) {
        dropped.push(key)
        return false
      }
      return true
    }),
  )
  return { env: kept, dropped }
}

/** Truncate a string for logging */
function truncate(s: string, maxLen = 200): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}...`
}

// ============================================================
// MCP injection (OPENCODE_CONFIG_CONTENT)
// ============================================================

interface OpencodeMcpInjection {
  /** JSON string injected as `OPENCODE_CONFIG_CONTENT`; undefined when no server is injectable */
  configContent: string | undefined
  skipped: Array<{ name: string; type: string; reason: string }>
}

/**
 * Encode a2wave's resolvedMcpServers into the `mcp` block of an OpenCode
 * config.
 *
 * OpenCode's MCP schema (observed on 1.18.x):
 * - stdio → `{ type: 'local', command: [cmd, ...args], environment, enabled }`
 * - http / sse → `{ type: 'remote', url, headers, enabled }` (remote covers
 *   both streamable HTTP and the SSE transport)
 *
 * Note the key name is `mcp`, not Cursor/Claude's `mcpServers` — the mcp-sync
 * serializer cannot be reused. The config is injected via env rather than CLI
 * args, so secrets in `environment` never show up in the process list.
 */
export function buildOpencodeMcpInjection(servers: ResolvedMcpServer[]): OpencodeMcpInjection {
  const mcp: Record<string, unknown> = {}
  const skipped: OpencodeMcpInjection['skipped'] = []
  for (const server of servers) {
    if (server.type === 'stdio') {
      if (!server.command) {
        skipped.push({
          name: server.name,
          type: server.type,
          reason: 'stdio server missing command',
        })
        continue
      }
      mcp[server.name] = {
        type: 'local',
        command: [server.command, ...(server.args ?? [])],
        ...(server.env && Object.keys(server.env).length ? { environment: server.env } : {}),
        enabled: true,
      }
    } else if (server.type === 'http' || server.type === 'sse') {
      if (!server.url) {
        skipped.push({
          name: server.name,
          type: server.type,
          reason: `${server.type} server missing url`,
        })
        continue
      }
      mcp[server.name] = {
        type: 'remote',
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length
          ? { headers: server.headers }
          : {}),
        enabled: true,
      }
    }
  }
  return {
    configContent: Object.keys(mcp).length > 0 ? JSON.stringify({ mcp }) : undefined,
    skipped,
  }
}

// ============================================================
// OpencodeAgentEngine config
// ============================================================

export type OpencodeAgentEngineConfig = CliEngineBaseConfig

// ============================================================
// OpencodeAgentEngine implementation
// ============================================================

export class OpencodeAgentEngine extends BaseCliAgentEngine {
  readonly type = ENGINE_TYPE
  protected readonly cliName = 'opencode'
  private config: OpencodeAgentEngineConfig

  constructor(config: OpencodeAgentEngineConfig) {
    super(config)
    this.config = config
  }

  // ----------------------------------------------------------
  // Public: login status / model list
  // (healthCheck / getVersion / kill / killAll inherited from base)
  // ----------------------------------------------------------

  /**
   * Probes host credentials via `opencode auth list` (purely local, returns
   * instantly). Output looks like:
   *   ┌  Credentials ~/.local/share/opencode/auth.json
   *   ●  111 api
   *   └  1 credentials
   * ≥1 credential counts as logged in (deployment-level shared-account
   * semantics).
   */
  async checkLoginStatus(): Promise<LoginStatus> {
    const result = await runStatusProbe(this.config.path, ['auth', 'list'], {
      logTag: 'opencode',
    })
    if (result.notFound) {
      return { installed: false, loggedIn: false, error: 'opencode CLI not found in PATH' }
    }
    if (result.timedOut) {
      return {
        installed: true,
        loggedIn: false,
        error: 'opencode auth list timed out',
        raw: truncateForRaw(result.stdout || result.stderr),
      }
    }
    const out = result.stdout
    // Prefer anchoring on the "└  N credentials" summary line (avoids binding
    // to digits inside credential names or other lines); fall back to a
    // full-text match for older versions / format drift. 0 or missing means
    // not logged in.
    const countMatch = out.match(/└\s*(\d+)\s+credentials?/i) ?? out.match(/(\d+)\s+credentials?/i)
    const count = countMatch ? Number(countMatch[1]) : 0
    const loggedIn = result.exitCode === 0 && (await count) > 0
    // Extract credential name lines ("●  <name> <kind>") for the detail field
    const names = [...out.matchAll(/●\s+(\S+)/g)].map((m) => m[1])
    return {
      installed: true,
      loggedIn,
      ...(loggedIn
        ? { detail: `${count} credential(s): ${names.join(', ')}`, method: 'auth.json' }
        : { error: 'No credentials configured (run `opencode auth login` on host)' }),
      raw: truncateForRaw(out || result.stderr),
    }
  }

  /**
   * Lists the model ids available under the host OpenCode config
   * (`provider/model` two-part form).
   *
   * localSession only — the catalog is determined by the host `opencode.json`
   * provider definitions, independent of per-agent credentials.
   */
  async listAvailableModels(options: ListModelsOptions): Promise<ModelListResult> {
    if (options.authMode !== 'localSession') {
      return {
        models: [],
        error: 'OpenCode only supports localSession mode (BYO providers are configured on host)',
        code: 'unsupported_mode',
      }
    }
    const result = await runStatusProbe(this.config.path, ['models'], {
      logTag: 'opencode-models',
      timeoutMs: 20_000,
    })
    if (result.notFound) {
      return { models: [], error: 'opencode CLI not found in PATH', code: 'spawn_failed' }
    }
    if (result.timedOut) {
      return { models: [], error: 'opencode models timed out', code: 'timeout' }
    }
    if (result.exitCode !== 0) {
      const stderrSample = truncateForRaw(result.stderr, 300)
      return {
        models: [],
        error: stderrSample || `opencode exit ${result.exitCode}`,
        code: 'cli_failed',
        details: { exitCode: result.exitCode, stderr: stderrSample },
      }
    }
    // One `provider/model` id per line
    const models = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /^[A-Za-z0-9._@-]+\/[A-Za-z0-9._/@:-]+$/.test(line))
    if (models.length === 0) {
      return {
        models: [],
        error: 'opencode models returned no parseable model ids',
        code: 'parse_failed',
        details: { raw: truncateForRaw(result.stdout, 300) },
      }
    }
    logger.info(
      { count: models.length, sample: models.slice(0, 3) },
      '[opencode] listAvailableModels success',
    )
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
    const agentEnv = agentConfig?.agentEnv as Record<string, string> | undefined
    const runtimeEnv = request.runtimeContext?.env
    const resolvedMcpServers = agentConfig?.resolvedMcpServers as ResolvedMcpServer[] | undefined

    const resolvedWorkDir = workDir || this.config.defaultWorkDir

    const args = this.buildArgs(model, inputChatId, prompt)
    const mcpInjection = buildOpencodeMcpInjection(resolvedMcpServers ?? [])
    for (const s of mcpInjection.skipped) {
      logger.warn({ taskId, ...s }, '[opencode] MCP server skipped in injection')
    }
    const streamEnv = this.buildEnv(taskId, agentEnv, runtimeEnv, mcpInjection.configContent)

    const execParams: Record<string, unknown> = {
      cmd: this.config.path,
      args: args.slice(0, -1), // drop last arg (prompt)
      cwd: resolvedWorkDir,
      authMode: 'localSession',
      mcpServers: (resolvedMcpServers ?? []).map((s) => s.name),
      runtimeHome: request.runtimeContext?.home.dir,
      workspaceDir: request.runtimeContext?.workspace.dir,
      workspaceType: request.runtimeContext?.workspace.type,
      artifactsDir: request.runtimeContext?.artifacts.dir,
    }
    logger.info({ taskId, ...execParams }, '[opencode] execute (stream) params')
    onLogEntry?.({
      type: 'exec_params',
      engine: 'opencode',
      params: toDisplayExecParams(execParams),
      ts: Date.now(),
    })
    onLogEntry?.({ type: 'system', subtype: 'preparing', ts: Date.now() })

    const heartbeat = createHeartbeatTracker({
      intervalMs: TOOL_HEARTBEAT_INTERVAL_MS,
      emit: (entry) => onLogEntry?.(entry),
    })

    let textBuffer = ''
    let extractedChatId = inputChatId
    /** ⚠️ Only step_finish(reason='stop') sets this; 'tool-calls' mid-run is not terminal */
    let finalStepReceived = false
    let initEmitted = false
    // Each step_finish reports one API call, so accumulate all steps for the run.
    let totalUsage: TokenUsage | undefined
    let lastCost: number | undefined
    let streamErrorMessage: string | undefined

    const parseJsonLine = (line: string) => {
      const { events, sessionId } = parseOpencodeStreamLine(line)
      if (sessionId) extractedChatId = sessionId

      for (const ev of events) {
        switch (ev.kind) {
          case 'non_json':
            return
          case 'step_started':
            if (!initEmitted) {
              initEmitted = true
              onLogEntry?.({ type: 'system', subtype: 'init', model, ts: Date.now() })
            }
            break
          case 'assistant_text':
            logger.info({ taskId, len: ev.text.length }, `[ASSISTANT] ${truncate(ev.text)}`)
            textBuffer = textBuffer ? `${textBuffer}\n${ev.text}` : ev.text
            onUpdate?.(textBuffer)
            onLogEntry?.({ type: 'assistant', text: ev.text, ts: Date.now() })
            break
          case 'tool_call':
            logger.info(
              { taskId, toolName: ev.toolName, callId: ev.callId, subtype: ev.subtype },
              `[TOOL_CALL] ${ev.toolName} (${ev.subtype})`,
            )
            onLogEntry?.({
              type: 'tool_call',
              subtype: ev.subtype,
              callId: ev.callId,
              toolName: ev.toolName,
              input: ev.input,
              ...(ev.error ? { error: ev.error } : {}),
              ts: Date.now(),
            })
            if (ev.callId) {
              if (ev.subtype === 'started') heartbeat.onStarted(ev.callId, ev.toolName)
              else heartbeat.onSettled(ev.callId)
            }
            break
          case 'step_finished': {
            const stepUsage = mapOpencodeUsage(ev.usage)
            if (stepUsage) totalUsage = accumulateUsage(totalUsage, stepUsage)
            if (ev.cost !== undefined) lastCost = ev.cost
            if (ev.final) {
              finalStepReceived = true
              logger.info(
                { taskId, usage: ev.usage, cost: ev.cost },
                '[RESULT] Final step finished (reason=stop)',
              )
              onLogEntry?.({
                type: 'result',
                subtype: 'success',
                ...(totalUsage ? { usage: totalUsage } : {}),
                ts: Date.now(),
              })
            } else {
              logger.debug({ taskId, reason: ev.reason }, '[STEP] Intermediate step finished')
            }
            break
          }
          case 'error':
            streamErrorMessage = ev.message
            logger.error({ taskId }, `[ERROR] Stream error: ${truncate(ev.message, 500)}`)
            onLogEntry?.({ type: 'error', message: truncate(ev.message, 500), ts: Date.now() })
            break
          case 'unknown':
            logger.debug({ taskId, type: ev.msgType }, `[UNKNOWN] ${ev.msgType}`)
            break
        }
      }
    }

    return this.runCliStream({
      taskId,
      args,
      env: streamEnv,
      cwd: resolvedWorkDir,
      timeoutMs: (agentConfig?.timeoutMinutes ?? this.config.timeoutMinutes) * 60 * 1000,
      onStdoutLine: (line) => {
        if (line.trim()) parseJsonLine(line)
      },
      getUsage: () => totalUsage,
      onSpawned: () => onLogEntry?.({ type: 'system', subtype: 'spawned', ts: Date.now() }),
      cleanup: () => heartbeat.stop(),
      settle: ({ exitCode, stderr }) => {
        logger.info(
          { taskId, exitCode, finalStepReceived, usage: totalUsage, cost: lastCost },
          'opencode process exited',
        )

        // A stream-level error wins over any success verdict (aligned with
        // codex's resultIsError defense): once opencode emits type=error, the
        // run is a failure even if it exits 0 with buffered text — never
        // silently report success with truncated output.
        if (streamErrorMessage) {
          return { ok: false, error: new Error(streamErrorMessage), usage: totalUsage }
        }

        // Terminal verdict: reason=stop is a normal completion; process exit
        // is the last-resort fallback — exit 0 with text but no stop (e.g.
        // reason=length truncation) is tolerated as success.
        if (exitCode === 0 && (finalStepReceived || textBuffer)) {
          if (!finalStepReceived) {
            logger.warn(
              { taskId },
              'opencode exited 0 without reason=stop; accepting buffered text',
            )
          }
          return {
            ok: true,
            result: {
              success: true,
              output: textBuffer,
              chatId: extractedChatId,
              ...(totalUsage ? { usage: totalUsage } : {}),
            },
          }
        }

        if (exitCode !== 0) {
          // streamErrorMessage was already rejected above; only stderr remains
          return {
            ok: false,
            error: new Error(formatExitError(exitCode ?? 1, stderr)),
            usage: totalUsage,
          }
        }

        return {
          ok: false,
          error: new Error('opencode exited without producing a result (exit 0, no result)'),
          usage: totalUsage,
        }
      },
    })
  }

  // ----------------------------------------------------------
  // Private: CLI args / environment variables
  // ----------------------------------------------------------

  private buildArgs(model: string, chatId: string | undefined, prompt: string): string[] {
    // --auto: unattended execution must auto-approve permissions, otherwise
    // tool calls escaping cwd get rejected by OpenCode's default permission
    // model (observed "user rejected permission"); semantically matches
    // cursor's --trust / codex's bypass sandbox.
    const args = ['run', '--format', 'json', '-m', model, '--auto']
    if (chatId) {
      args.push('--session', chatId)
    }
    args.push(prompt)
    return args
  }

  /**
   * Build the child-process env (localSession semantics).
   *
   * Kept engine-local (instead of the base `buildCredentialEnv`) because
   * opencode's semantics diverge: the runtimeEnv also goes through the
   * protected-name strip, only `OPENCODE_CONFIG_CONTENT` is unset from the
   * inherited env (stripping the full blocklist would drop PATH/HOME from the
   * service's own env), and the managed MCP config content is injected AFTER
   * the merge so agentEnv can never override it.
   *
   * - Omit the runtime isolation's `HOME` / `XDG_CONFIG_HOME`: OpenCode's
   *   credentials live in the host `~/.local/share/opencode/auth.json`
   *   (resolved via $HOME) and provider definitions in `~/.config/opencode/`
   *   (resolved via $XDG_CONFIG_HOME); overriding either loses the
   *   deployment-level shared account. The remaining isolation vars
   *   (cache/tmp/A2WAVE_*) are kept.
   * - MCP injection goes through `OPENCODE_CONFIG_CONTENT` (merged with the
   *   global config, observed on 1.18.x); the managed injection wins, and any
   *   same-named var in agentEnv is stripped to prevent hijacking.
   */
  private buildEnv(
    taskId: string,
    agentEnv?: Record<string, string>,
    runtimeEnv?: Record<string, string>,
    mcpConfigContent?: string,
  ): NodeJS.ProcessEnv {
    const env = buildSafeAgentProcessEnv()
    // Residual injection in the service process itself must not leak into the child
    unsetEnv(env, 'OPENCODE_CONFIG_CONTENT')
    // Unconditionally strip agentEnv against the blocklist (see the
    // PROTECTED_OPENCODE_ENV_NAMES comment): config-injection channels +
    // provider redirects + subprocess/dynamic-linker injection vectors must
    // never pass through.
    const { env: sanitizedAgentEnv, dropped } = stripProtectedOpencodeEnv(
      sanitizeAgentRuntimeEnv(agentEnv),
    )
    if (agentEnv && Object.keys(agentEnv).length > 0) {
      // Log the keys actually passed through + the ones dropped by the
      // blocklist, avoiding the "logs say injected, actually discarded"
      // troubleshooting black hole
      logger.debug(
        { taskId, injected: Object.keys(sanitizedAgentEnv ?? {}), dropped },
        'Injecting agent environment variables',
      )
    }
    // runtimeEnv is built server-side and currently carries no dangerous keys,
    // but it goes through the blocklist too as defense in depth, so future
    // runtimeContext additions cannot silently bypass it.
    const { env: effectiveRuntimeEnv } = stripProtectedOpencodeEnv(
      omitRuntimeEnvKeys(runtimeEnv, ['HOME', 'XDG_CONFIG_HOME']),
    )
    return {
      ...env,
      ...(sanitizedAgentEnv || {}),
      ...(effectiveRuntimeEnv || {}),
      ...(mcpConfigContent ? { OPENCODE_CONFIG_CONTENT: mcpConfigContent } : {}),
    }
  }
}
