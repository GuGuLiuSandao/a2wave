import { Card, CardContent } from '@/components/ui/card'
import { ClipboardList, FlaskConical } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { SetsTab } from './sets-tab'
import { TasksTab } from './tasks-tab'

const VALID_EVAL_TABS = ['sets', 'tasks'] as const
type EvalTab = (typeof VALID_EVAL_TABS)[number]

interface EvaluationTabProps {
  agentId: string
  canWrite: boolean
}

/**
 * Sub-tab switch: plain text with an icon, active in brand colour, sitting on
 * the card's own white surface.
 *
 * Deliberately not a Segmented pill or a second underlined Tabs strip. Both
 * carry their own filled surface, which put a heavy band across the top of the
 * card and competed with the page-level tabs directly above. A nested control
 * should be the quietest thing in its container, not the loudest.
 */
function SubTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors ${
        active
          ? 'font-medium text-interactive-foreground'
          : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

export function EvaluationTab({ agentId, canWrite }: EvaluationTabProps) {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()

  const param = searchParams.get('evalTab')
  const activeTab: EvalTab = VALID_EVAL_TABS.includes(param as EvalTab)
    ? (param as EvalTab)
    : 'sets'

  const handleTabChange = (key: EvalTab) => {
    const next = new URLSearchParams(searchParams)
    next.set('evalTab', key)
    setSearchParams(next, { replace: true })
  }

  return (
    <Card>
      {/* A minimum height rather than a fixed one: it stops the card collapsing
          to a sliver on an empty state and stops the page jumping when
          switching between the two sub-tabs, while still letting a long list
          grow instead of being clipped. */}
      <CardContent className="flex min-h-[520px] flex-col p-5">
        <div className="mb-4 flex items-center gap-1 border-b border-border/60 pb-3">
          <SubTab
            active={activeTab === 'sets'}
            icon={<ClipboardList className="h-3.5 w-3.5" />}
            label={t('agentEvaluation.tabSets')}
            onClick={() => handleTabChange('sets')}
          />
          <SubTab
            active={activeTab === 'tasks'}
            icon={<FlaskConical className="h-3.5 w-3.5" />}
            label={t('agentEvaluation.tabTasks')}
            onClick={() => handleTabChange('tasks')}
          />
        </div>

        {/* flex-1 fills the reserved height; flex flex-col then gives the child
            a resolvable height, without which the sets tab's `h-full` has
            nothing to measure against and its rail divider stops short of the
            card's bottom edge. */}
        <div className="flex flex-1 flex-col">
          {activeTab === 'sets' ? (
            <SetsTab agentId={agentId} canWrite={canWrite} />
          ) : (
            <TasksTab agentId={agentId} canWrite={canWrite} />
          )}
        </div>
      </CardContent>
    </Card>
  )
}
