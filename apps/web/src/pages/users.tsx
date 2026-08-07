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
import { Pagination } from '@/components/ui/pagination'
import { modal } from '@/lib/antd-static'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'
import { confirm } from '@/lib/confirm'
import type { PaginatedResponse } from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Table, Tag, Tooltip } from 'antd'
import dayjs from 'dayjs'
import {
  Ban,
  Check,
  CircleCheck,
  KeyRound,
  Mail,
  Plus,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

interface User {
  id: string
  username: string
  displayName: string | null
  /** SSO 用户的邮箱（IdP JWT email claim）；本地 password 用户为 null */
  email: string | null
  /** SSO 用户的 IdP sub claim；本地 password 用户为 null */
  idaasSub: string | null
  role: 'admin' | 'user'
  isActive: boolean
  createdAt: string
  updatedAt: string
}

const PAGE_SIZE = 20

function checkPolicy(password: string) {
  return {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasDigit: /\d/.test(password),
  }
}

export function UsersPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1') || 1)
  const [addOpen, setAddOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetUserId, setResetUserId] = useState<string | null>(null)

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams)
    if (nextPage <= 1) {
      next.delete('page')
    } else {
      next.set('page', String(nextPage))
    }
    setSearchParams(next)
  }

  const { data: usersData, isLoading } = useQuery({
    queryKey: ['users', page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      const res = await fetch(`/api/users?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch users')
      return res.json() as Promise<PaginatedResponse<User>>
    },
  })

  const users = usersData?.data ?? []
  const pagination = usersData?.pagination

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  // Both surface their own failure in a modal below, so they opt out of the global
  // MutationCache toast — otherwise one failed role change notifies twice.
  // `deleteMutation` above deliberately does not: the global toast is its only
  // surface, and opting out would make a failed delete silent.
  const updateRoleMutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: ({ id, role }: { id: string; role: 'admin' | 'user' }) =>
      api.patch(`/users/${id}/role`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  const updateStatusMutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/users/${id}/status`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  const handleDelete = (user: User) => {
    confirm({
      title: t('users.deleteTitle'),
      content: t('users.deleteContent', { username: user.username }),
      okText: t('common.confirm'),
      danger: true,
      onOk: () => deleteMutation.mutateAsync(user.id),
    })
  }

  const roleLabel = (role: 'admin' | 'user') =>
    role === 'admin' ? t('users.roleAdmin') : t('users.roleUser')

  const handleToggleRole = (user: User) => {
    const next: 'admin' | 'user' = user.role === 'admin' ? 'user' : 'admin'
    confirm({
      title: t('users.changeRoleTitle'),
      content: t('users.changeRoleContent', {
        username: user.username,
        from: roleLabel(user.role),
        to: roleLabel(next),
      }),
      okText: t('common.confirm'),
      danger: next === 'admin',
      onOk: async () => {
        try {
          await updateRoleMutation.mutateAsync({ id: user.id, role: next })
        } catch (err) {
          modal.error({
            title: t('users.changeRoleFailed'),
            content: formatApiError(err, t),
          })
        }
      },
    })
  }

  const handleToggleStatus = (user: User) => {
    const next = !user.isActive
    confirm({
      title: next ? t('users.enableTitle') : t('users.disableTitle'),
      content: next
        ? t('users.enableContent', { username: user.username })
        : t('users.disableContent', { username: user.username }),
      okText: t('common.confirm'),
      danger: !next,
      onOk: async () => {
        try {
          await updateStatusMutation.mutateAsync({ id: user.id, isActive: next })
        } catch (err) {
          modal.error({
            title: t('users.changeStatusFailed'),
            content: formatApiError(err, t),
          })
        }
      },
    })
  }

  const columns = [
    {
      title: t('users.username'),
      dataIndex: 'username',
      key: 'username',
      render: (username: string, record: User) => (
        <div className="flex items-center gap-1.5">
          <span>{username}</span>
          {record.idaasSub && (
            <Tooltip title={t('users.ssoBadgeHint')}>
              <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
                SSO
              </Tag>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: t('users.displayName'),
      dataIndex: 'displayName',
      key: 'displayName',
      render: (v: string | null) => v || '-',
    },
    {
      title: (
        <span className="inline-flex items-center gap-1.5">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" /> {t('users.email')}
        </span>
      ),
      dataIndex: 'email',
      key: 'email',
      render: (v: string | null) => v || <span className="text-muted-foreground">-</span>,
    },
    {
      title: t('users.role'),
      dataIndex: 'role',
      key: 'role',
      render: (role: 'admin' | 'user') => (
        <Tag color={role === 'admin' ? 'blue' : 'default'}>{roleLabel(role)}</Tag>
      ),
    },
    {
      title: t('users.status'),
      dataIndex: 'isActive',
      key: 'isActive',
      render: (active: boolean) => (
        <Tag color={active ? 'green' : 'default'}>
          {active ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('users.createdAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: t('users.actions'),
      key: 'actions',
      render: (_: unknown, record: User) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => handleToggleRole(record)}
          >
            {record.role === 'admin' ? (
              <ShieldOff className="h-3.5 w-3.5" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {record.role === 'admin' ? t('users.demoteToUser') : t('users.promoteToAdmin')}
          </Button>
          {/* Disable stays available for admins too: a departing administrator is this
              feature's most real use case. "Cannot disable the last admin" is enforced by
              the backend gate rather than by hiding the button. */}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => handleToggleStatus(record)}
          >
            {record.isActive ? (
              <Ban className="h-3.5 w-3.5" />
            ) : (
              <CircleCheck className="h-3.5 w-3.5" />
            )}
            {record.isActive ? t('users.disable') : t('users.enable')}
          </Button>
          {/* SSO-only 用户 (passwordHash=null) 没法重置密码，UI 上隐藏 */}
          {!record.idaasSub && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setResetUserId(record.id)
                setResetOpen(true)
              }}
            >
              <KeyRound className="h-3.5 w-3.5" />
              {t('users.resetPassword')}
            </Button>
          )}
          {record.role !== 'admin' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => handleDelete(record)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('users.delete')}
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('users.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('users.subtitle')}</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('users.addUser')}
        </Button>
      </div>

      <Table
        dataSource={users}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={false}
        // Dim disabled rows so dead accounts are obvious at a glance, without having to
        // read the status tag on every row
        rowClassName={(record: User) => (record.isActive ? '' : 'opacity-60')}
      />

      {pagination && (
        <Pagination
          className="mt-4"
          pagination={pagination}
          onPageChange={setPage}
          totalLabel={t('users.paginationTotal', { total: pagination.total })}
          previousLabel={t('users.prevPage')}
          nextLabel={t('users.nextPage')}
        />
      )}

      <AddUserDialog open={addOpen} onOpenChange={setAddOpen} />
      <ResetPasswordDialog open={resetOpen} onOpenChange={setResetOpen} userId={resetUserId} />
    </>
  )
}

function AddUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const policy = checkPolicy(password)
  const allValid = policy.minLength && policy.hasUpper && policy.hasLower && policy.hasDigit

  const mutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: (data: { username: string; displayName?: string; password: string }) =>
      api.post('/users', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      onOpenChange(false)
      setUsername('')
      setDisplayName('')
      setPassword('')
      setError('')
    },
  })

  const handleSubmit = async () => {
    setError('')
    if (!username || !allValid) return
    try {
      await mutation.mutateAsync({
        username,
        displayName: displayName || undefined,
        password,
      })
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  const PolicyItem = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center gap-1.5 text-xs">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <X className="h-3.5 w-3.5 text-muted-foreground/40" />
      )}
      <span className={ok ? 'text-emerald-600' : 'text-muted-foreground'}>{label}</span>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('users.addUser')}</DialogTitle>
          <DialogDescription>{t('users.addUserDesc')}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium text-foreground" htmlFor="add-user-username">
              {t('users.username')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <Input
              id="add-user-username"
              className="mt-1"
              placeholder={t('users.usernamePlaceholder')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground" htmlFor="add-user-display-name">
              {t('users.displayName')}
            </label>
            <Input
              id="add-user-display-name"
              className="mt-1"
              placeholder={t('users.displayNamePlaceholder')}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground" htmlFor="add-user-password">
              {t('auth.password')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <Input
              id="add-user-password"
              type="password"
              className="mt-1"
              placeholder={t('auth.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {password.length > 0 && (
            <div className="info-panel px-3 py-2.5 space-y-1">
              <PolicyItem ok={policy.minLength} label={t('auth.policyMinLength')} />
              <PolicyItem ok={policy.hasUpper} label={t('auth.policyUppercase')} />
              <PolicyItem ok={policy.hasLower} label={t('auth.policyLowercase')} />
              <PolicyItem ok={policy.hasDigit} label={t('auth.policyDigit')} />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-600">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={mutation.isPending}
            disabled={!username || !allValid}
            onClick={handleSubmit}
          >
            {t('users.addUser')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({
  open,
  onOpenChange,
  userId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string | null
}) {
  const { t } = useTranslation()
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')

  const policy = checkPolicy(newPassword)
  const allValid = policy.minLength && policy.hasUpper && policy.hasLower && policy.hasDigit

  const mutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: (data: { newPassword: string }) =>
      api.post(`/users/${userId}/reset-password`, data),
  })

  const handleSubmit = async () => {
    setError('')
    if (!allValid) return
    try {
      await mutation.mutateAsync({ newPassword })
      onOpenChange(false)
      setNewPassword('')
      setError('')
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  const PolicyItem = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center gap-1.5 text-xs">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <X className="h-3.5 w-3.5 text-muted-foreground/40" />
      )}
      <span className={ok ? 'text-emerald-600' : 'text-muted-foreground'}>{label}</span>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('users.resetPasswordTitle')}</DialogTitle>
          <DialogDescription>{t('users.resetPasswordDesc')}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium text-foreground" htmlFor="reset-new-password">
              {t('auth.newPassword')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <Input
              id="reset-new-password"
              type="password"
              className="mt-1"
              placeholder={t('auth.newPasswordPlaceholder')}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>

          {newPassword.length > 0 && (
            <div className="info-panel px-3 py-2.5 space-y-1">
              <PolicyItem ok={policy.minLength} label={t('auth.policyMinLength')} />
              <PolicyItem ok={policy.hasUpper} label={t('auth.policyUppercase')} />
              <PolicyItem ok={policy.hasLower} label={t('auth.policyLowercase')} />
              <PolicyItem ok={policy.hasDigit} label={t('auth.policyDigit')} />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-600">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={mutation.isPending} disabled={!allValid} onClick={handleSubmit}>
            {t('users.resetPassword')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
