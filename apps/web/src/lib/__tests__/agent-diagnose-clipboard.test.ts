import { describe, expect, it } from 'vitest'
import { formatAgentDiagnoseClipboardText } from '../agent-diagnose-clipboard'

const labels = {
  title: 'Diagnostics',
  checkedAtLabel: 'Checked at',
  scopeLabel: 'Scope',
  summaryOk: 'OK',
  summaryBad: 'Bad',
  severityError: 'Error',
  severityWarn: 'Warn',
  severityInfo: 'Info',
}

describe('formatAgentDiagnoseClipboardText', () => {
  it('formats ok payload with checks', () => {
    const text = formatAgentDiagnoseClipboardText(
      {
        ok: true,
        meta: { scope: 'instance', checkedAt: '2025-01-01T00:00:00.000Z' },
        checks: [
          { id: 'a', severity: 'info', message: 'All good' },
          { id: 'b', severity: 'warn', message: 'Minor' },
        ],
      },
      labels,
    )
    expect(text).toBe(
      [
        'Diagnostics',
        'Checked at: 2025-01-01T00:00:00.000Z',
        'Scope: instance',
        '',
        'OK',
        '',
        '[Info] All good',
        '[Warn] Minor',
      ].join('\n'),
    )
  })

  it('uses summaryBad when not ok', () => {
    const text = formatAgentDiagnoseClipboardText(
      {
        ok: false,
        meta: { scope: 'x', checkedAt: 't' },
        checks: [{ id: 'e', severity: 'error', message: 'Fail' }],
      },
      labels,
    )
    expect(text).toContain('Bad')
    expect(text).toContain('[Error] Fail')
  })
})
