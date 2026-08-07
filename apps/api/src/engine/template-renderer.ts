/**
 * 模板变量渲染模块
 *
 * 使用 Mustache 语法（`{{variable}}`）渲染 system prompt 中的动态变量。
 * 内置变量（message / context / model / agent_provider）优先于同名环境变量。
 */

import Mustache from 'mustache'
import { logger } from '../lib/logger.js'

/** 模板渲染上下文 */
export interface TemplateContext {
  /** 用户消息 */
  message: string
  /** 附加上下文（JSON 对象，渲染为 JSON 字符串） */
  context: Record<string, unknown>
  /** Agent 环境变量 */
  env?: Record<string, string>
  /** 当前使用的模型名（如 claude-sonnet、gpt-4o） */
  model?: string
  /** 当前执行引擎可读名（如 Cursor Agent、Claude Code） */
  agent_provider?: string
}

/**
 * Engine type → human-readable label, for the `{{agent_provider}}` prompt
 * variable only.
 *
 * NOT the authority on a Provider's display name — `PRESET_PROVIDERS` /
 * `providerCatalog.manifest.displayName` is, and caller-facing surfaces (e.g.
 * the OAuth gateway errors) read it from there. These labels deliberately drift
 * from it in places (`Cursor Agent` vs the Provider's `Cursor CLI`,
 * `Kimi Code` vs `Kimi Code CLI`).
 *
 * Deliberately NOT synced to the manifest: this string is interpolated into
 * every Agent's system prompt, so changing it rewrites the prompt text of every
 * existing Agent — altering model behaviour and invalidating provider prompt
 * caches — for a purely cosmetic gain. If it is ever unified, do it as its own
 * change with that blast radius stated, not as a drive-by.
 */
const ENGINE_TYPE_LABELS: Record<string, string> = {
  cursor: 'Cursor Agent',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  qoder: 'Qoder',
  trae: 'Trae',
  kimi: 'Kimi Code',
  pi: 'Pi',
  llm: 'LLM',
  script: 'Script',
}

/**
 * 将 engineType 转为提示词中使用的 agent_provider 可读名。
 */
export function engineTypeToAgentProviderLabel(engineType: string | undefined): string {
  if (!engineType) return ''
  return ENGINE_TYPE_LABELS[engineType] ?? engineType
}

const TEMPLATE_PATTERN = /\{\{[^}]+\}\}/

/** 快速检测模板中是否包含 `{{}}` 变量 */
export function hasTemplateVariables(template: string): boolean {
  return TEMPLATE_PATTERN.test(template)
}

/** 提取模板中所有变量名（去重） */
export function extractVariableNames(template: string): string[] {
  const parsed = Mustache.parse(template)
  const names = new Set<string>()
  for (const token of parsed) {
    if (token[0] === 'name') {
      names.add(token[1])
    }
  }
  return [...names]
}

/**
 * 渲染模板，将 `{{variable}}` 替换为实际值。
 *
 * - 无 `{{}}` 时直接返回原文（零开销短路）
 * - HTML 转义已禁用（Mustache 默认转义）
 * - 未定义变量渲染为空字符串
 * - 内置变量（message / context / model / agent_provider）覆盖同名 env var
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  if (!hasTemplateVariables(template)) {
    return template
  }

  // Build view: env vars (low priority) → built-in vars (high priority)
  const view: Record<string, string> = {}

  if (ctx.env) {
    for (const [key, value] of Object.entries(ctx.env)) {
      view[key] = value
    }
  }

  // Built-in variables override env vars
  if (ctx.env && 'message' in ctx.env) {
    logger.warn(
      { key: 'message' },
      'Built-in template variable conflicts with env var, built-in takes priority',
    )
  }
  view.message = ctx.message

  if (ctx.env && 'context' in ctx.env) {
    logger.warn(
      { key: 'context' },
      'Built-in template variable conflicts with env var, built-in takes priority',
    )
  }
  view.context = JSON.stringify(ctx.context)

  if (ctx.env && 'model' in ctx.env) {
    logger.warn(
      { key: 'model' },
      'Built-in template variable conflicts with env var, built-in takes priority',
    )
  }
  view.model = ctx.model ?? ''

  if (ctx.env && 'agent_provider' in ctx.env) {
    logger.warn(
      { key: 'agent_provider' },
      'Built-in template variable conflicts with env var, built-in takes priority',
    )
  }
  view.agent_provider = ctx.agent_provider ?? ''

  // Warn about undefined variables
  const varNames = extractVariableNames(template)
  for (const name of varNames) {
    if (!(name in view)) {
      logger.warn(
        { variable: name },
        'Template variable is not defined, will render as empty string',
      )
      view[name] = ''
    }
  }

  // Disable HTML escaping by using Mustache.render with custom escape
  const originalEscape = Mustache.escape
  Mustache.escape = (text: unknown) => String(text ?? '')
  try {
    return Mustache.render(template, view)
  } finally {
    Mustache.escape = originalEscape
  }
}
