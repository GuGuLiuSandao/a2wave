/**
 * Helpers for the `exec_params` run-log entry.
 *
 * `exec_params` is emitted via `onLogEntry` and ends up **persisted to the run
 * step output and rendered in the run-log UI to anyone with read access**
 * (including viewer-role members). It is therefore a different trust surface
 * than the server-side `logger.info` line: the latter may carry truncated
 * secrets for ops diagnostics, the former MUST NOT carry credentials.
 *
 * Redaction of secret-bearing arg VALUES is the responsibility of each engine,
 * co-located with its arg builder so it can't drift silently:
 *   - claude-code: `filterClaudeCodeArgs` drops the `-p` prompt and the
 *     `--append-system-prompt` identity text (flag + value).
 *   - codex:       `redactCodexArgs` masks every `-c` / `--config` value
 *     (including MCP and proxy settings), and `.slice(0, -1)` drops the
 *     trailing positional prompt.
 *   - cursor:      `.slice(0, -1)` drops the trailing positional prompt.
 * Each engine puts that already-redacted array in `params.args`, so this helper
 * trusts it as-is and only strips the credential object-keys (apiKey, oauthToken,
 * cursorApiKey) that the server log keeps masked but must never reach the UI.
 */

/** Keys that may appear in the server-log params but must never reach the UI. */
const HIDDEN_PARAM_KEYS = new Set(['apiKey', 'oauthToken', 'cursorApiKey', 'runtimeHome'])

/**
 * Derive the user-visible `exec_params.params` from the richer server-log
 * params by stripping credentials and internal host-layout paths. `params.args` is trusted verbatim:
 * each engine has already redacted its own secret-bearing arg values, which
 * keeps non-sensitive flag values (model, sandbox, output-format, …) visible.
 */
export function toDisplayExecParams(
  serverParams: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(serverParams)) {
    if (HIDDEN_PARAM_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}
