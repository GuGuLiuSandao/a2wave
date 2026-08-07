/**
 * 模型 Fallback 策略
 *
 * 所有引擎通用的模型错误判断与 fallback 选择逻辑。
 */

/** 模型相关错误关键词 */
const MODEL_ERROR_KEYWORDS = [
  'model',
  'invalid model',
  'model not found',
  'model unavailable',
  'model not available',
  'unknown model',
  'unsupported model',
  'model error',
]

/** 判断错误是否与模型相关（参考 executor.go: isModelError） */
export function isModelError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  return MODEL_ERROR_KEYWORDS.some((kw) => lower.includes(kw))
}

/** 选择与当前模型不同的 fallback 模型 */
export function selectFallbackModel(
  currentModel: string,
  fallbackModels: string[],
): string | undefined {
  return fallbackModels.find((m) => m !== currentModel)
}
