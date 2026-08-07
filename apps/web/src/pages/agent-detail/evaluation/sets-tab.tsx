import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  type EvaluationCaseRow,
  type EvaluationSetRow,
  useCreateEvaluationCase,
  useCreateEvaluationSet,
  useDeleteEvaluationCase,
  useDeleteEvaluationSet,
  useEvaluationCases,
  useEvaluationSets,
  useUpdateEvaluationCase,
} from '@/hooks/use-evaluation'
import { confirm } from '@/lib/confirm'
import { Select } from 'antd'
import { ClipboardList, MessagesSquare, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CaseEditor } from './case-editor'

const PAGE_SIZE_OPTIONS = [10, 20, 50]

interface SetsTabProps {
  agentId: string
  canWrite: boolean
}

export function SetsTab({ agentId, canWrite }: SetsTabProps) {
  const { t } = useTranslation()
  const { data: sets, isLoading } = useEvaluationSets(agentId)
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null)

  // Keep a valid selection as sets appear or disappear.
  useEffect(() => {
    if (!sets?.length) {
      setSelectedSetId(null)
      return
    }
    if (!selectedSetId || !sets.some((s) => s.id === selectedSetId)) {
      setSelectedSetId(sets[0].id)
    }
  }, [sets, selectedSetId])

  if (isLoading) {
    return (
      <div className="flex gap-5">
        <Skeleton className="h-64 w-64 shrink-0" />
        <Skeleton className="h-64 flex-1" />
      </div>
    )
  }

  const selectedSet = sets?.find((s) => s.id === selectedSetId) ?? null

  return (
    // Fixed-width rail + hairline divider, matching the memory tab's file
    // browser. The border is what makes the two panes read as separate
    // regions; without it the columns just float side by side.
    // flex-1 rather than h-full: as a flex child it fills the parent's reserved
    // height without needing a resolvable percentage basis, which is what left
    // the rail divider stopping at the content instead of the card's edge.
    <div className="flex min-h-0 flex-1 flex-col gap-5 md:flex-row md:gap-0">
      <div className="w-full shrink-0 md:w-64 md:border-r md:border-border md:pr-5">
        <SetList
          agentId={agentId}
          sets={sets ?? []}
          selectedSetId={selectedSetId}
          onSelect={setSelectedSetId}
          canWrite={canWrite}
        />
      </div>

      <div className="min-w-0 flex-1 md:pl-5">
        {selectedSet ? (
          // Keyed by set: switching sets is a fresh list, so React remounts
          // rather than carrying the previous set's page number across.
          <CaseList key={selectedSet.id} agentId={agentId} set={selectedSet} canWrite={canWrite} />
        ) : (
          <EmptyState
            icon={<ClipboardList className="h-6 w-6 text-muted-foreground" />}
            title={t('agentEvaluation.set.emptyTitle')}
            description={t('agentEvaluation.set.emptyDesc')}
          />
        )}
      </div>
    </div>
  )
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center rounded-[10px] border border-dashed border-border py-16 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-muted">
        {icon}
      </div>
      <h3 className="mb-1.5 text-sm font-semibold text-foreground">{title}</h3>
      <p className="max-w-xs text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

function SetList({
  agentId,
  sets,
  selectedSetId,
  onSelect,
  canWrite,
}: {
  agentId: string
  sets: EvaluationSetRow[]
  selectedSetId: string | null
  onSelect: (id: string) => void
  canWrite: boolean
}) {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const createSet = useCreateEvaluationSet(agentId)
  const deleteSet = useDeleteEvaluationSet(agentId)

  const handleCreate = () => {
    if (!name.trim() || createSet.isPending) return
    createSet.mutate(
      { name: name.trim(), description: description.trim() || null },
      {
        onSuccess: (res) => {
          setDialogOpen(false)
          setName('')
          setDescription('')
          onSelect(res.data.id)
        },
      },
    )
  }

  const confirmDelete = (set: EvaluationSetRow) => {
    confirm({
      title: t('agentEvaluation.set.deleteTitle'),
      content: t('agentEvaluation.set.deleteDesc', { name: set.name }),
      okText: t('common.delete'),
      danger: true,
      onOk: () => deleteSet.mutate(set.id),
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('agentEvaluation.tabSets')}
        </span>
        {canWrite && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('agentEvaluation.set.create')}
            title={t('agentEvaluation.set.create')}
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      {sets.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
          {t('agentEvaluation.set.listEmpty')}
        </p>
      ) : (
        // Rows, not cards: a row is one line of text with the same height as
        // its neighbours, so the list reads as a list. Cards made every entry a
        // heavy block that clashed with the create control above it.
        <div className="space-y-0.5">
          {sets.map((set) => {
            const active = set.id === selectedSetId
            return (
              <div
                key={set.id}
                className={`group flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-surface-selected text-interactive-foreground'
                    : 'hover:bg-surface-hover'
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => onSelect(set.id)}
                  title={set.name}
                >
                  {set.name}
                </button>
                {canWrite && (
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => confirmDelete(set)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('agentEvaluation.set.createTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="set-name">{t('agentEvaluation.set.nameLabel')}</Label>
              <Input id="set-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-desc">{t('agentEvaluation.set.descLabel')}</Label>
              <Textarea
                id="set-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!name.trim() || createSet.isPending}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CaseList({
  agentId,
  set,
  canWrite,
}: {
  agentId: string
  set: EvaluationSetRow
  canWrite: boolean
}) {
  const { t } = useTranslation()
  const { data: cases, isLoading } = useEvaluationCases(agentId, set.id)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<EvaluationCaseRow | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const createCase = useCreateEvaluationCase(agentId, set.id)
  const updateCase = useUpdateEvaluationCase(agentId, set.id)
  const deleteCase = useDeleteEvaluationCase(agentId, set.id)

  // Switching sets or shrinking the list must never strand the user on a page
  // that no longer exists.
  const total = cases?.length ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // Mount-only is enough because the caller keys this component by set id, so a
  // set switch remounts it rather than reusing the instance.
  useEffect(() => {
    setPage(1)
  }, [])
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const visible = cases?.slice((page - 1) * pageSize, page * pageSize) ?? []

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }

  const handleSubmit = (input: {
    name: string
    turns: { request: string; expectedResponse: string }[]
  }) => {
    const onSuccess = () => setEditorOpen(false)
    if (editing) {
      updateCase.mutate({ caseId: editing.id, ...input }, { onSuccess })
    } else {
      createCase.mutate({ ...input, sortOrder: total }, { onSuccess })
    }
  }

  const confirmDelete = (row: EvaluationCaseRow) => {
    confirm({
      title: t('agentEvaluation.case.deleteTitle'),
      content: t('agentEvaluation.case.deleteDesc', { name: row.name }),
      okText: t('common.delete'),
      danger: true,
      onOk: () => deleteCase.mutate(row.id),
    })
  }

  if (isLoading) return <Skeleton className="h-48 w-full" />

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{set.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('agentEvaluation.case.count', { count: total })}
          </p>
        </div>
        {canWrite && (
          <Button variant="outline" size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            {t('agentEvaluation.case.create')}
          </Button>
        )}
      </div>

      {total === 0 ? (
        <EmptyState
          icon={<MessagesSquare className="h-6 w-6 text-muted-foreground" />}
          title={t('agentEvaluation.case.emptyTitle')}
          description={t('agentEvaluation.case.emptyDesc')}
        />
      ) : (
        <>
          {/* Separate tinted rows rather than one bordered block with dividers:
              ten cases inside a single outline read as one dense slab, and the
              rows gave no sign they were interactive even though clicking one
              opens the editor. Each row now carries its own surface and lifts
              on hover. */}
          <div className="space-y-1">
            {visible.map((row) => (
              <div
                key={row.id}
                className="group flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2.5 transition-colors hover:bg-surface-hover"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    if (!canWrite) return
                    setEditing(row)
                    setEditorOpen(true)
                  }}
                  disabled={!canWrite}
                >
                  <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                  {/* The name is derived from the first request, so repeating
                      that request below would just say the same thing twice.
                      Only the turn count adds information. */}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('agentEvaluation.case.turnCount', { count: row.turns.length })}
                  </p>
                </button>
                {canWrite && (
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={t('agentEvaluation.case.edit')}
                      onClick={() => {
                        setEditing(row)
                        setEditorOpen(true)
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={t('common.delete')}
                      onClick={() => confirmDelete(row)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('agentEvaluation.case.perPage')}
              </span>
              <Select
                size="small"
                value={pageSize}
                onChange={(v) => {
                  setPageSize(v)
                  setPage(1)
                }}
                options={PAGE_SIZE_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
                style={{ width: 72 }}
              />
            </div>
            <Pagination
              pagination={{ total, page, pageSize, totalPages }}
              onPageChange={setPage}
              totalLabel={t('agentEvaluation.case.count', { count: total })}
              previousLabel={t('agentEvaluation.case.prevPage')}
              nextLabel={t('agentEvaluation.case.nextPage')}
              className="sm:justify-end"
            />
          </div>
        </>
      )}

      <CaseEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        onSubmit={handleSubmit}
        isPending={createCase.isPending || updateCase.isPending}
      />
    </div>
  )
}
