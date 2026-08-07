/**
 * Fallback message body sent to Feishu when a run reaches a terminal state
 * without usable output (engine failure or empty assistant text). Without this
 * the group would see no reply at all — the feishu-empty-reply bug. The run_id
 * lets operators jump straight to the run in the A2Wave backend. The raw engine
 * error is intentionally NOT surfaced to the chat to avoid leaking internals.
 *
 * Lives in its own module so both feishu-service.ts (sends it as a reply) and
 * run-lifecycle.ts (persists it into chatMessages so the stored chat history
 * matches what the user saw on Feishu) can import it without a circular
 * dependency.
 */
export function buildFeishuFallbackText(runId: string): string {
  return `⚠️ Agent 未返回有效内容，本次执行可能失败。\n请稍后重试，或在 A2Wave 后台查看详情（run_id=${runId}）。`
}

/**
 * Reply body for a message that cannot start a run at all because the Agent's
 * Provider configuration is unusable (every chain entry disabled or pointing at a
 * deleted Provider, or a chain over the length cap).
 *
 * This failure happens BEFORE a Run exists, so there is no run_id to reference
 * and no run record the user could be pointed at. Without an explicit reply the
 * exception is swallowed by the dispatcher's error logger and the bot simply
 * never answers — indistinguishable from being offline. Points at the Agent owner
 * because no end-user retry can fix a configuration fault.
 */
export function buildFeishuProviderConfigErrorText(): string {
  return '⚠️ 该 Agent 的 Provider 配置当前不可用，无法执行。\n请联系 Agent 负责人在 A2Wave 后台检查 Provider 配置后重试。'
}
