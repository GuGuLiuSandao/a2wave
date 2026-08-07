import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { AgentMemberRole } from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Select } from 'antd'
import { AlertCircle, Loader2, Search, Trash2 } from 'lucide-react'
import { type JSX, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface MemberRow {
  userId: string
  username: string
  displayName: string | null
  email: string | null
  role: 'owner' | 'editor' | 'viewer'
  isOwner: boolean
  createdAt: string | Date
}

interface LookupRow {
  id: string
  username: string
  displayName: string | null
  email: string | null
}

type Props = {
  open: boolean
  onClose: () => void
  agentId: string
}

/**
 * Map API server-error strings to localized i18n keys. The contract is the
 * Hono error body's `error` field; anything not listed here falls back to a
 * generic operation-failed message.
 */
const ERR_MAP: Record<string, string> = {
  'Cannot add yourself': 'agentDetail.members.errors.selfAddition',
  'Owner is implicitly a member': 'agentDetail.members.errors.ownerIsImplicit',
  'Cannot add members to system agent': 'agentDetail.members.errors.systemAgent',
  "Cannot modify owner's role": 'agentDetail.members.errors.modifyOwner',
  'Cannot remove the owner': 'agentDetail.members.errors.removeOwner',
  'User not found': 'agentDetail.members.errors.userNotFound',
  'Member not found': 'agentDetail.members.errors.memberNotFound',
  'User is already a member': 'agentDetail.members.errors.alreadyMember',
}

function membersQueryKey(agentId: string) {
  return ['agents', agentId, 'members'] as const
}

export function MembersDialog({ open, onClose, agentId }: Props): JSX.Element {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [selectedUser, setSelectedUser] = useState<LookupRow | null>(null)
  const [selectedRole, setSelectedRole] = useState<AgentMemberRole>('viewer')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<MemberRow | null>(null)

  // Reset transient state when the dialog closes so we don't flash stale
  // search results / errors next time it opens.
  useEffect(() => {
    if (!open) {
      setQ('')
      setDebouncedQ('')
      setSelectedUser(null)
      setSelectedRole('viewer')
      setErrorKey(null)
      setPendingRemove(null)
    }
  }, [open])

  // Debounce user-search input.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQ(q), 300)
    return () => window.clearTimeout(handle)
  }, [q])

  const membersQuery = useQuery({
    queryKey: membersQueryKey(agentId),
    queryFn: () => api.get<MemberRow[]>(`/agents/${agentId}/members`),
    enabled: open,
  })

  const lookupQuery = useQuery({
    queryKey: ['user-lookup', debouncedQ],
    queryFn: () =>
      api.get<LookupRow[]>(`/user-lookup?q=${encodeURIComponent(debouncedQ)}&limit=10`),
    enabled: open && debouncedQ.trim().length > 0,
  })

  const members: MemberRow[] = useMemo(
    () => membersQuery.data?.data ?? [],
    [membersQuery.data?.data],
  )
  const memberIds = useMemo(() => new Set(members.map((m) => m.userId)), [members])

  const addMutation = useMutation({
    mutationFn: (input: { userId: string; role: AgentMemberRole }) =>
      api.post<MemberRow>(`/agents/${agentId}/members`, input),
    onMutate: () => {
      setErrorKey(null)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: membersQueryKey(agentId) })
      setQ('')
      setDebouncedQ('')
      setSelectedUser(null)
      setSelectedRole('viewer')
    },
    onError: (err) => {
      setErrorKey(mapError(err))
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AgentMemberRole }) =>
      api.patch<MemberRow>(`/agents/${agentId}/members/${userId}`, { role }),
    onMutate: () => {
      setErrorKey(null)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: membersQueryKey(agentId) })
    },
    onError: (err) => {
      setErrorKey(mapError(err))
    },
  })

  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/agents/${agentId}/members/${userId}`),
    onMutate: () => {
      setErrorKey(null)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: membersQueryKey(agentId) })
      setPendingRemove(null)
    },
    onError: (err) => {
      setErrorKey(mapError(err))
      setPendingRemove(null)
    },
  })

  const lookupRows = lookupQuery.data?.data ?? []
  const isAddDisabled =
    !selectedUser ||
    addMutation.isPending ||
    (selectedUser ? memberIds.has(selectedUser.id) : false)

  const handleAdd = () => {
    if (!selectedUser) return
    if (memberIds.has(selectedUser.id)) {
      setErrorKey('agentDetail.members.errors.alreadyMember')
      return
    }
    addMutation.mutate({ userId: selectedUser.id, role: selectedRole })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      width={640}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('agentDetail.members.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('agentDetail.members.dialogDescription')}</DialogDescription>
        </DialogHeader>

        {errorKey && (
          <div
            className="mt-4 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            data-testid="member-error-banner"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{t(errorKey)}</span>
          </div>
        )}

        {/* Add section */}
        <section className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            {t('agentDetail.members.addSection')}
          </div>
          <div className="flex items-start gap-2">
            <div className="relative flex-1 min-w-0">
              <Search
                className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setSelectedUser(null)
                }}
                placeholder={t('agentDetail.members.searchPlaceholder')}
                className="pl-7"
                data-testid="member-search-input"
                aria-label={t('agentDetail.members.searchPlaceholder')}
              />
              {/* Search results dropdown */}
              {debouncedQ.trim().length > 0 && !selectedUser && (
                <div
                  className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-md max-h-60 overflow-auto"
                  data-testid="member-lookup-list"
                >
                  {lookupQuery.isLoading && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      {t('agentDetail.members.searching')}
                    </div>
                  )}
                  {!lookupQuery.isLoading && lookupRows.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      {t('agentDetail.members.searchEmpty')}
                    </div>
                  )}
                  {lookupRows.map((row) => {
                    const already = memberIds.has(row.id)
                    return (
                      <button
                        type="button"
                        key={row.id}
                        data-testid={`member-lookup-row-${row.id}`}
                        onClick={() => {
                          setSelectedUser(row)
                          setQ(`${row.username}${row.email ? ` (${row.email})` : ''}`)
                        }}
                        className={cn(
                          'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors',
                          'hover:bg-surface-hover focus-visible:outline-none focus-visible:bg-muted',
                          already && 'opacity-60',
                        )}
                      >
                        <span className="font-medium text-foreground">
                          {row.displayName || row.username}
                          {already && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              ({t('agentDetail.members.alreadyMember')})
                            </span>
                          )}
                        </span>
                        {row.email && (
                          <span className="text-xs text-muted-foreground">{row.email}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <Select<AgentMemberRole>
              value={selectedRole}
              onChange={(v) => setSelectedRole(v)}
              className="w-24"
              data-testid="member-add-role"
              aria-label={t('agentDetail.members.role.viewer')}
              options={[
                { value: 'viewer', label: t('agentDetail.members.role.viewer') },
                { value: 'editor', label: t('agentDetail.members.role.editor') },
              ]}
            />

            <Button
              type="button"
              size="sm"
              onClick={handleAdd}
              disabled={isAddDisabled}
              data-testid="member-add-btn"
            >
              {addMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {t('agentDetail.members.addBtn')}
            </Button>
          </div>
          {selectedRole && (
            <p className="mt-2 text-xs text-muted-foreground">
              {selectedRole === 'viewer'
                ? t('agentDetail.members.roleHint.viewer')
                : t('agentDetail.members.roleHint.editor')}
            </p>
          )}
        </section>

        {/* Members list */}
        <section className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            {t('agentDetail.members.membersList')}
          </div>
          {membersQuery.isLoading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">…</div>
          ) : membersQuery.isError ? (
            <div className="text-sm text-destructive py-4 text-center">
              {t('agentDetail.members.errors.loadFailed')}
            </div>
          ) : members.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">
              {t('agentDetail.members.empty')}
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {members.map((m) => (
                <li
                  key={m.userId}
                  className="flex items-center gap-3 px-3 py-2"
                  data-testid={`member-row-${m.userId}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground truncate">
                      {m.username}
                      {m.displayName && m.displayName !== m.username && (
                        <span className="ml-2 text-xs text-muted-foreground">{m.displayName}</span>
                      )}
                    </div>
                    {m.email && (
                      <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                    )}
                  </div>

                  {m.isOwner ? (
                    <Badge variant="secondary" className="shrink-0">
                      {t('agentDetail.members.role.owner')}
                    </Badge>
                  ) : (
                    <>
                      <Select<AgentMemberRole>
                        value={m.role as AgentMemberRole}
                        onChange={(v) => updateMutation.mutate({ userId: m.userId, role: v })}
                        disabled={updateMutation.isPending}
                        className="w-24"
                        data-testid={`member-row-role-${m.userId}`}
                        aria-label={t('agentDetail.members.role.viewer')}
                        options={[
                          { value: 'viewer', label: t('agentDetail.members.role.viewer') },
                          { value: 'editor', label: t('agentDetail.members.role.editor') },
                        ]}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-destructive hover:text-destructive"
                        onClick={() => setPendingRemove(m)}
                        data-testid={`member-row-delete-${m.userId}`}
                        aria-label={t('agentDetail.members.removeConfirmCta')}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('agentDetail.members.close')}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Remove confirmation */}
      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemove(null)
        }}
      >
        <AlertDialogContent>
          <div data-testid="member-remove-confirm">
            <AlertDialogTitle>{t('agentDetail.members.removeConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('agentDetail.members.removeConfirmDesc', {
                name: pendingRemove?.username ?? '',
              })}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPendingRemove(null)}
                data-testid="member-remove-cancel"
              >
                {t('agentDetail.members.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (pendingRemove) removeMutation.mutate(pendingRemove.userId)
                }}
                disabled={removeMutation.isPending}
                data-testid="member-remove-confirm-cta"
              >
                {removeMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                {t('agentDetail.members.removeConfirmCta')}
              </Button>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

function mapError(err: unknown): string {
  const msg = err instanceof Error ? err.message : ''
  return ERR_MAP[msg] ?? 'agentDetail.members.errors.unknown'
}
