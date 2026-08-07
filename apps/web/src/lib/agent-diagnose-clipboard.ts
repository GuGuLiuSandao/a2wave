export type AgentDiagnoseClipboardCheck = {
  id: string
  severity: 'error' | 'warn' | 'info'
  message: string
}

export type AgentDiagnoseClipboardPayload = {
  ok: boolean
  meta: { scope: string; checkedAt: string }
  checks: AgentDiagnoseClipboardCheck[]
}

export type AgentDiagnoseClipboardLabels = {
  title: string
  checkedAtLabel: string
  scopeLabel: string
  summaryOk: string
  summaryBad: string
  severityError: string
  severityWarn: string
  severityInfo: string
}

function severityWord(
  severity: AgentDiagnoseClipboardCheck['severity'],
  labels: AgentDiagnoseClipboardLabels,
): string {
  if (severity === 'error') return labels.severityError
  if (severity === 'warn') return labels.severityWarn
  return labels.severityInfo
}

export function formatAgentDiagnoseClipboardText(
  payload: AgentDiagnoseClipboardPayload,
  labels: AgentDiagnoseClipboardLabels,
): string {
  const head = [
    labels.title,
    `${labels.checkedAtLabel}: ${payload.meta.checkedAt}`,
    `${labels.scopeLabel}: ${payload.meta.scope}`,
    '',
    payload.ok ? labels.summaryOk : labels.summaryBad,
    '',
  ]
  const body = payload.checks.map((c) => `[${severityWord(c.severity, labels)}] ${c.message}`)
  return [...head, ...body].join('\n')
}
