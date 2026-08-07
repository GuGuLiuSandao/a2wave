import { Popover } from 'antd'
import { CircleHelp } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

export function TokenUsageCoverageHelp() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const content = (
    <div className="w-80 max-w-[calc(100vw-3rem)] space-y-2 p-1">
      <p className="text-sm font-medium text-foreground">{t('runs.tokenCoverageTitle')}</p>
      <p className="text-xs leading-5 text-muted-foreground">{t('runs.tokenCoverageNote')}</p>
      <Link
        to="/wiki/runs"
        className="inline-flex text-xs font-medium text-interactive-foreground underline-offset-2 hover:underline"
        onClick={() => setOpen(false)}
      >
        {t('runs.tokenCoverageDetails')}
      </Link>
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomLeft"
      open={open}
      onOpenChange={setOpen}
    >
      <button
        type="button"
        aria-label={t('runs.tokenCoverageTitle')}
        aria-expanded={open}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CircleHelp className="size-3.5" aria-hidden="true" />
      </button>
    </Popover>
  )
}
