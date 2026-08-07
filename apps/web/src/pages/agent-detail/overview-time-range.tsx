import { Button } from '@/components/ui/button'
import type { TimeseriesRange } from '@/hooks/use-runs'
import { cn } from '@/lib/utils'
import { DatePicker } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

const { RangePicker } = DatePicker

export const RANGE_PRESETS = ['today', '7d', '30d', '90d', 'custom'] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]

const PRESET_LABEL_KEYS: Record<RangePreset, string> = {
  today: 'agentOverview.rangeToday',
  '7d': 'agentOverview.rangeLast7',
  '30d': 'agentOverview.rangeLast30',
  '90d': 'agentOverview.rangeLast90',
  custom: 'agentOverview.rangeCustom',
}

/** Days each preset spans, inclusive of today. */
const PRESET_DAYS: Record<Exclude<RangePreset, 'custom'>, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

const DATE_FORMAT = 'YYYY-MM-DD'

/**
 * Mirrors MAX_BUCKETS in apps/api/src/lib/time-buckets.ts. The server is still
 * the authority — this only stops the picker from offering spans it will reject.
 */
export const MAX_RANGE_DAYS = 400

/**
 * Hourly buckets stay readable up to about two days; past that a day bucket is
 * the only sensible granularity. The server independently caps total buckets,
 * since a direct API caller never runs this rule.
 */
function bucketForSpan(from: Dayjs, to: Dayjs): TimeseriesRange['bucket'] {
  return to.diff(from, 'day') <= 1 ? 'hour' : 'day'
}

/**
 * Resolve a preset to a concrete range.
 *
 * Note the `days - 1`: "last 7 days" *including today* spans seven buckets, so
 * the start is six days back. Using 7 would render an eight-column chart.
 */
export function resolvePreset(preset: Exclude<RangePreset, 'custom'>): TimeseriesRange {
  const to = dayjs()
  const from = to.subtract(PRESET_DAYS[preset] - 1, 'day')
  return {
    from: from.format(DATE_FORMAT),
    to: to.format(DATE_FORMAT),
    bucket: preset === 'today' ? 'hour' : 'day',
  }
}

export function rangeFromDates(from: Dayjs, to: Dayjs): TimeseriesRange {
  return {
    from: from.format(DATE_FORMAT),
    to: to.format(DATE_FORMAT),
    bucket: bucketForSpan(from, to),
  }
}

type Props = {
  preset: RangePreset
  range: TimeseriesRange
  onPresetChange: (preset: RangePreset) => void
  onRangeChange: (range: TimeseriesRange) => void
}

export function OverviewTimeRange({ preset, range, onPresetChange, onRangeChange }: Props) {
  const { t } = useTranslation()
  // Tracks the half-open selection so `disabledDate` can bound the second click
  // relative to the first; antd only reports a completed pair via onChange.
  const [pickerRange, setPickerRange] = useState<(Dayjs | null)[] | undefined>()

  return (
    <div className="flex flex-wrap items-center gap-2">
      {RANGE_PRESETS.map((p) => (
        <Button
          key={p}
          type="button"
          size="sm"
          variant={preset === p ? 'default' : 'outline'}
          aria-pressed={preset === p}
          onClick={() => onPresetChange(p)}
          className={cn(preset === p && 'shadow-sm')}
        >
          {t(PRESET_LABEL_KEYS[p])}
        </Button>
      ))}

      {preset === 'custom' && (
        <RangePicker
          value={[dayjs(range.from), dayjs(range.to)]}
          allowClear={false}
          // Bound the picker to what the server will actually accept. Without
          // this, a 3-year span is selectable, comes back as a 400, and renders
          // as a generic "failed to load" panel that says nothing about the
          // real problem or the limit.
          disabledDate={(current) => {
            if (!current) return false
            if (current.isAfter(dayjs(), 'day')) return true
            const [start] = pickerRange ?? []
            if (!start) return false
            return Math.abs(current.diff(start, 'day')) >= MAX_RANGE_DAYS
          }}
          onCalendarChange={(dates) => setPickerRange(dates ?? undefined)}
          onOpenChange={(open) => {
            if (!open) setPickerRange(undefined)
          }}
          onChange={(dates) => {
            const [from, to] = dates ?? []
            if (from && to) onRangeChange(rangeFromDates(from, to))
          }}
        />
      )}
    </div>
  )
}
