import { Badge } from '@/components/ui/badge'
import type { EvaluationTaskStatus } from '@a2wave/shared'
import { Ban, CircleAlert, Clock, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Statuses where work is still expected to happen; the caller polls on these. */
export function isTaskPending(status: EvaluationTaskStatus): boolean {
  return status === 'pending' || status === 'queued' || status === 'running'
}

/**
 * `completed` carries no icon: the tinted pill and its label already say the
 * task finished, so a tick only adds a second glyph to decode. The remaining
 * statuses keep theirs because each reports something the label alone does not
 * — that work is still moving, stalled, or was stopped deliberately.
 */
const ICONS: Partial<Record<EvaluationTaskStatus, typeof Clock>> = {
  pending: Clock,
  queued: Clock,
  running: Loader2,
  failed: CircleAlert,
  cancelled: Ban,
}

/**
 * Colour is carried by the icon rather than a filled badge: a row of solid
 * green/red pills competes with the task names for attention, while a tinted
 * glyph is still readable at a glance. `completed` is the exception — it has no
 * icon, so its tint comes from the badge's own `success` variant.
 */
const TONES: Partial<Record<EvaluationTaskStatus, string>> = {
  pending: 'text-muted-foreground',
  queued: 'text-muted-foreground',
  running: 'text-interactive-foreground',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
}

/**
 * Status badge for an evaluation task.
 *
 * `running` spins, because the single most common question about a long
 * evaluation is whether it is still alive at all — a static grey pill answers
 * that identically to a task that died mid-flight.
 */
export function TaskStatusBadge({ status }: { status: EvaluationTaskStatus }) {
  const { t } = useTranslation()
  const Icon = ICONS[status]

  return (
    <Badge variant={status === 'completed' ? 'success' : 'secondary'} className="gap-1">
      {Icon && (
        <Icon
          aria-hidden="true"
          className={`h-3 w-3 ${TONES[status] ?? ''} ${status === 'running' ? 'animate-spin' : ''}`}
        />
      )}
      {t(`agentEvaluation.task.status.${status}`)}
    </Badge>
  )
}
