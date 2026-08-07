/**
 * 模板变量工具 — 纯正则实现（无需 Mustache）
 *
 * 用于前端编辑器的变量提取与校验。
 */

const VARIABLE_PATTERN = /\{\{\s*(\w+)\s*\}\}/g

/** 内置变量名（不需要在 env 中定义） */
const BUILTIN_VARIABLES = new Set(['message', 'context', 'model', 'agent_provider'])

/** 提取模板中所有变量名（去重，保持顺序） */
export function extractTemplateVariables(template: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

/** 返回模板中引用了但未在 envKeys 和内置变量中定义的变量名 */
export function findUndefinedVariables(template: string, envKeys: string[]): string[] {
  const vars = extractTemplateVariables(template)
  const defined = new Set([...BUILTIN_VARIABLES, ...envKeys])
  return vars.filter((v) => !defined.has(v))
}
