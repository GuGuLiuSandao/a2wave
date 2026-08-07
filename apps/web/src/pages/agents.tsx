import { AgentCard } from '@/components/agent-card'
import { ImportAgentDialog } from '@/components/import-agent-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgents, useSetAgentPinned } from '@/hooks/use-agents'
import { useOnboarding } from '@/hooks/use-onboarding'
import { useTemplatePresetSettings } from '@/hooks/use-settings'
import {
  AGENT_TEMPLATE_CATALOG,
  type AgentTemplateDefinition,
  localizeAgentTemplate,
} from '@/lib/agent-template-catalog'
import { applyTemplatePreset } from '@/lib/template-preset'
import { cn } from '@/lib/utils'
import { Bot, Compass, FilePlus, Plus, Upload } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

const PAGE_SIZE = 24

export function AgentsPage() {
  const { i18n, t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1') || 1)
  const [showTemplateDialog, setShowTemplateDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const { data: agentsResult, isLoading } = useAgents({ page, pageSize: PAGE_SIZE })
  const agents = agentsResult?.data
  const pagination = agentsResult?.pagination
  // 模板 Provider 预填（settings.templates；未配置时为空 → 模板不预填）
  const { data: templatePreset } = useTemplatePresetSettings()
  const setPinned = useSetAgentPinned()
  // 记录所有正在切换置顶的 agentId，用于逐卡禁用避免重复点击。
  // 不用 setPinned.variables（只反映最近一次 mutate），否则连点多张卡时早先在途的卡会被提前解禁。
  const [pendingPinIds, setPendingPinIds] = useState<Set<string>>(new Set())
  const togglePin = useCallback(
    ({ id, pinned }: { id: string; pinned: boolean }) => {
      setPendingPinIds((prev) => new Set(prev).add(id))
      setPinned.mutate(
        { id, pinned },
        {
          onSettled: () =>
            setPendingPinIds((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            }),
        },
      )
    },
    [setPinned],
  )

  // 新手引导：仅需「开始」入口；具体步骤由根部 OnboardingTour 按应用状态推导。
  const { start: startOnboarding } = useOnboarding()

  const setPage = useCallback(
    (nextPage: number) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current)
        if (nextPage <= 1) {
          next.delete('page')
        } else {
          next.set('page', String(nextPage))
        }
        return next
      })
    },
    [setSearchParams],
  )

  useEffect(() => {
    if (!pagination) return
    if (pagination.totalPages === 0 && page !== 1) {
      setPage(1)
      return
    }
    if (pagination.totalPages > 0 && page > pagination.totalPages) {
      setPage(pagination.totalPages)
    }
  }, [page, pagination, setPage])

  const handleCreate = () => {
    setShowTemplateDialog(true)
  }

  const handleSelectBlank = () => {
    setShowTemplateDialog(false)
    localStorage.removeItem('draft:agent-create')
    localStorage.removeItem('draft-extra:agent-create')
    navigate('/agents/new')
  }

  const handleSelectTemplate = (definition: AgentTemplateDefinition) => {
    setShowTemplateDialog(false)
    localStorage.removeItem('draft:agent-create')
    localStorage.removeItem('draft-extra:agent-create')
    const localized = localizeAgentTemplate(definition, (key) => t(key))
    const template = definition.applyProviderPreset
      ? applyTemplatePreset(localized, templatePreset)
      : localized
    navigate('/agents/new', {
      state: { template },
    })
  }

  // Keep deployment-specific IDs and credentials out of the catalog. A template
  // provides portable intent, prompt, and safe defaults; the user selects resources.
  const templates = [
    {
      key: 'blank',
      icon: <FilePlus className="h-[18px] w-[18px] text-muted-foreground" aria-hidden="true" />,
      title: t('agents.templateBlank'),
      desc: t('agents.templateBlankDesc'),
      onClick: handleSelectBlank,
      // Deliberately the only neutral, dashed chip in the grid: "start from
      // nothing" is a different kind of choice from picking a template, and
      // every catalog entry carries a category tint instead. `border-dashed`
      // (not `ring-dashed`, which is not a Tailwind utility) over the shared
      // ring, which this one opts out of.
      chip: 'bg-muted border border-dashed border-foreground/25 ring-0',
      dataTour: undefined as string | undefined,
    },
    ...AGENT_TEMPLATE_CATALOG.map((definition) => ({
      key: definition.key,
      icon: definition.icon,
      title: t(definition.nameKey),
      desc: t(definition.descriptionKey),
      onClick: () => handleSelectTemplate(definition),
      chip: definition.chipClassName,
      dataTour: definition.dataTour,
    })),
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2
            className="text-2xl font-semibold tracking-tight text-foreground"
            style={{ textWrap: 'balance' }}
          >
            {t('agents.title')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">{t('agents.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={startOnboarding}>
            <Compass className="h-4 w-4" />
            {t('onboarding.startGuide')}
          </Button>
          <Button variant="outline" onClick={() => setShowImportDialog(true)}>
            <Upload className="h-4 w-4" />
            {t('agents.importAgent')}
          </Button>
          <Button data-tour="new-agent-btn" onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            {t('agents.newAgent')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-live="polite">
          <span className="sr-only">{t('common.loading')}</span>
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
            <Card key={i}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-10 rounded-xl" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : agents?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 px-8">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground mb-5">
              <Bot className="h-7 w-7" aria-hidden="true" />
            </div>
            <h3 className="font-semibold text-base mb-1 text-foreground">
              {t('agents.emptyTitle')}
            </h3>
            <p
              className="text-sm text-muted-foreground mb-5 text-center max-w-xs"
              style={{ textWrap: 'pretty' }}
            >
              {t('agents.emptyDesc')}
            </p>
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4" />
              {t('agents.createFirst')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {agents?.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onTogglePin={agent.canManage ? togglePin : undefined}
                pinPending={pendingPinIds.has(agent.id)}
              />
            ))}
          </div>

          {pagination && (
            <Pagination
              className="mt-4"
              pagination={pagination}
              onPageChange={setPage}
              totalLabel={t('agents.paginationTotal', { total: pagination.total })}
              previousLabel={t('agents.prevPage')}
              nextLabel={t('agents.nextPage')}
            />
          )}
        </>
      )}

      <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog} width={900}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('agents.createTitle')}</DialogTitle>
            <DialogDescription>{t('agents.createSubtitle')}</DialogDescription>
          </DialogHeader>
          <div className="mt-5 grid max-h-[65vh] grid-cols-1 gap-2.5 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
            {/* No per-card stagger. A 40ms cascade was fine for a handful of
                templates, but the catalog has grown to eleven cards — nearly
                half a second of them arriving one by one, which reads as the
                dialog still loading rather than as polish. They all fade in
                together now. */}
            {templates.map((tpl) => (
              <button
                key={tpl.key}
                type="button"
                data-tour={tpl.dataTour}
                onClick={tpl.onClick}
                className="group animate-fade-in flex flex-col gap-2 rounded-xl border border-border/70 bg-card/40 p-3.5 text-left transition-all duration-200 hover:border-foreground/20 hover:bg-surface-hover hover:shadow-sm"
              >
                <div className="flex items-center gap-2.5">
                  {/* The chip tints are deliberately pale (they sit behind an
                      emoji, not text), which on a near-white card left them
                      reading as no tile at all. The inset ring gives every chip
                      an edge, so the category color is legible as a choice
                      rather than looking like a rendering glitch. */}
                  <div
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-lg text-base leading-none ring-1 ring-inset ring-foreground/10 transition-transform duration-200 group-hover:scale-110',
                      tpl.chip,
                    )}
                  >
                    {tpl.icon}
                  </div>
                  <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {tpl.title}
                  </div>
                </div>
                <div className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                  {tpl.desc}
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <ImportAgentDialog open={showImportDialog} onClose={() => setShowImportDialog(false)} />
    </div>
  )
}
