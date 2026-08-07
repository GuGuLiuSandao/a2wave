import { Cron } from 'croner'

export const SUPPORTED_SCHEDULE_CRON_EXAMPLES = [
  { cron: '0 9 * * *', zh: '每天 09:00', en: 'Daily at 09:00' },
  { cron: '0 7,19 * * *', zh: '每天 07:00 和 19:00', en: 'Daily at 07:00 and 19:00' },
  {
    cron: '0 7-23/12 * * *',
    zh: '07:00 到 23:00 每 12 小时',
    en: 'Every 12 hours from 07:00 to 23:00',
  },
  { cron: '*/30 * * * *', zh: '每 30 分钟', en: 'Every 30 minutes' },
  { cron: '0 10 * * 1', zh: '每周一 10:00', en: 'Every Monday at 10:00' },
  { cron: '0 0 1 * *', zh: '每月 1 日 00:00', en: 'Monthly on day 1 at 00:00' },
] as const

export function isSupportedScheduleCron(expr: string): boolean {
  const trimmed = expr.trim()
  if (!/^(\S+\s+){4}\S+$/.test(trimmed)) return false

  try {
    new Cron(trimmed, { paused: true })
    return true
  } catch {
    return false
  }
}
