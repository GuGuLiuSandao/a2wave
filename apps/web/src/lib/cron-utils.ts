export type SchedulePreset = 'daily' | 'weekly' | 'monthly'

export interface PresetConfig {
  preset: SchedulePreset
  time: string
  weekday?: number
  monthDay?: number
}

export function presetToCron(
  preset: SchedulePreset,
  time: string,
  weekday?: number,
  monthDay?: number,
): string {
  const parts = (time || '00:00').split(':')
  const h = Number(parts[0]) || 0
  const m = Number(parts[1]) || 0
  switch (preset) {
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekly':
      return `${m} ${h} * * ${weekday ?? 1}`
    case 'monthly':
      return `${m} ${h} ${monthDay ?? 1} * *`
  }
}

export function cronToPreset(cron: string): PresetConfig | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts

  if (mon !== '*') return null
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null

  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`

  if (dom === '*' && dow === '*') {
    return { preset: 'daily', time }
  }
  if (dom === '*' && /^[0-6]$/.test(dow)) {
    return { preset: 'weekly', time, weekday: Number(dow) }
  }
  if (/^\d+$/.test(dom) && dow === '*') {
    return { preset: 'monthly', time, monthDay: Number(dom) }
  }

  return null
}
