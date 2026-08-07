/**
 * Agent 创建模板的 Provider 预填合并。
 *
 * 预填值来自 settings.templates（providerBaseUrl / providerModel，默认为空）：
 * 企业部署可配置为内部 LLM 网关地址与默认模型，恢复「模板只粘一个 key」的体验；
 * 未配置时模板不预填，Provider 表单走官方 API 默认值。
 */

export interface TemplatePresetSettings {
  providerBaseUrl?: string
  providerModel?: string
}

export function applyTemplatePreset<T extends object>(
  template: T,
  preset: TemplatePresetSettings | undefined,
): T & { baseUrl?: string; model?: string } {
  const baseUrl = preset?.providerBaseUrl?.trim()
  const model = preset?.providerModel?.trim()
  return {
    ...template,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
  }
}
