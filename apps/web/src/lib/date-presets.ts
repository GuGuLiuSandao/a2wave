import dayjs from 'dayjs'

/**
 * Relative date-range presets shared by the run and audit log lists.
 *
 * Both pages offer the same "last N days / custom" choice, so the ranges are
 * defined once here rather than drifting apart per page.
 */

export type DatePreset = '1d' | '7d' | '30d' | 'all' | 'custom'

export const DATE_PRESETS = [
  { value: '1d', labelKey: 'runs.datePreset1d' },
  { value: '7d', labelKey: 'runs.datePreset7d' },
  { value: '30d', labelKey: 'runs.datePreset30d' },
  { value: 'custom', labelKey: 'runs.datePresetCustom' },
] as const

/** Presets with "all time" included — for lists that do not default to a window. */
export const DATE_PRESETS_WITH_ALL = [
  { value: 'all', labelKey: 'auditLogs.datePresetAll' },
  ...DATE_PRESETS,
] as const

export interface DateRange {
  start?: string
  end?: string
}

/**
 * Resolve a preset into an absolute range. `custom` and `all` yield an empty
 * range: the former because the user supplies the dates, the latter because no
 * bound is the point.
 */
export function getPresetDateRange(preset: DatePreset): DateRange {
  const days = preset === '1d' ? 1 : preset === '7d' ? 7 : preset === '30d' ? 30 : 0
  if (days === 0) return {}
  return {
    start: dayjs().subtract(days, 'day').startOf('day').toISOString(),
    end: dayjs().endOf('day').toISOString(),
  }
}
