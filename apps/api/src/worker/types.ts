/** Task payload sent to the worker/executor */
export interface WorkerTaskPayload {
  taskId: string
  prompt: string
  model?: string
  workDir?: string
  chatId?: string
  agentConfig: import('../lib/agent-helpers.js').AgentConfig
  /** 附加上下文（用于模板变量 {{context}}，渲染为 JSON 字符串） */
  context?: Record<string, unknown>
  /** Agent 级别环境变量（从 Agent.env 展开） */
  agentEnv?: Record<string, string>
}

/** Options for executeInWorker */
export interface ExecuteWorkerOptions {
  stepId?: string
  runId?: string
  onUpdate?: (content: string) => void
  onLogEntry?: (entry: import('../engine/types.js').StreamLogEntry) => void
  timeoutMs?: number
}

/** Result from executeInWorker */
export interface ExecuteWorkerResult {
  success: boolean
  output: string
  chatId?: string
  error?: string
  durationMs: number
  /** Token usage forwarded from ExecuteResult.usage. */
  usage?: import('../engine/types.js').TokenUsage
}
