import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCurrentUser } from '@/hooks/use-auth'
import {
  useCreateSkillGroup,
  useDeleteSkillGroup,
  useSkillGroupMembers,
  useUpdateSkillGroup,
} from '@/hooks/use-skill-groups'
import { useSkills } from '@/hooks/use-skills'
import { formatApiError } from '@/lib/api-error'
import {
  COLLECTION_ICON_OPTIONS,
  type CollectionIconName,
  DEFAULT_COLLECTION_ICON,
} from '@/lib/collection-icons'
import { selectFilterOption } from '@/lib/select-filter'
import { cn } from '@/lib/utils'
import type { SkillGroup } from '@a2wave/shared'
import { Select } from 'antd'
import { Loader2, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = 创建模式；有值 = 编辑模式 */
  group: SkillGroup | null
  onSaved?: (group: SkillGroup) => void
}

function normalizeIcon(raw: string | null | undefined): CollectionIconName {
  if (raw && COLLECTION_ICON_OPTIONS.some((o) => o.name === raw)) {
    return raw as CollectionIconName
  }
  return DEFAULT_COLLECTION_ICON
}

export function SkillGroupModal({ open, onOpenChange, group, onSaved }: Props) {
  const { t } = useTranslation()
  const isEdit = !!group
  const { data: skillsResult } = useSkills({ pageSize: 500 })
  const { data: currentUser } = useCurrentUser()
  const skillsList = (skillsResult?.data ?? []).filter(
    (skill) => currentUser?.role === 'admin' || skill.userId === currentUser?.id,
  )
  const membersQuery = useSkillGroupMembers(isEdit ? group.id : null)
  const memberIds = membersQuery.data
  const membersLoading = isEdit && (membersQuery.isLoading || membersQuery.isFetching)

  const createMut = useCreateSkillGroup()
  const updateMut = useUpdateSkillGroup()
  const deleteMut = useDeleteSkillGroup()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState<CollectionIconName>(DEFAULT_COLLECTION_ICON)
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setConfirmDelete(false)
    if (group) {
      setName(group.name)
      setDescription(group.description ?? '')
      setIcon(normalizeIcon(group.icon))
      // 成员清空由 /:id/skills 端点回填；先置空避免把上一个分组的成员带进来
      setSkillIds([])
    } else {
      setName('')
      setDescription('')
      setIcon(DEFAULT_COLLECTION_ICON)
      setSkillIds([])
    }
  }, [open, group])

  useEffect(() => {
    if (open && isEdit && memberIds) {
      setSkillIds(memberIds)
    }
  }, [open, isEdit, memberIds])

  const saving = createMut.isPending || updateMut.isPending
  const canSave = !saving && !membersLoading

  const handleSave = async () => {
    setError(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('skills.groups.nameRequired'))
      return
    }
    try {
      const payload = {
        name: trimmed,
        description: description.trim() || null,
        icon,
        skillIds,
      }
      const res = group
        ? await updateMut.mutateAsync({ id: group.id, ...payload })
        : await createMut.mutateAsync(payload)
      onSaved?.(res.data)
      onOpenChange(false)
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  const handleDelete = async () => {
    if (!group) return
    try {
      await deleteMut.mutateAsync(group.id)
      onOpenChange(false)
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={560}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t('skills.groups.edit') : t('skills.groups.new')}</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div>
            <Label className="mb-1.5 block" required>
              {t('skills.groups.name')}
            </Label>
            <Input
              value={name}
              maxLength={100}
              placeholder={t('skills.groups.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <Label className="mb-1.5 block">{t('skills.groups.icon')}</Label>
            <div className="grid grid-cols-10 gap-1.5">
              {COLLECTION_ICON_OPTIONS.map(({ name: iconName, icon: IconComp }) => {
                const selected = icon === iconName
                return (
                  <button
                    key={iconName}
                    type="button"
                    onClick={() => setIcon(iconName)}
                    aria-label={t(`skills.groups.iconPicker.${iconName}` as const)}
                    aria-pressed={selected}
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-[7px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-input bg-card text-muted-foreground hover:border-ring hover:text-foreground',
                    )}
                  >
                    <IconComp className="h-4 w-4" aria-hidden />
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block">{t('skills.groups.description')}</Label>
            <Textarea
              value={description}
              placeholder={t('skills.groups.descriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div>
            <Label className="mb-1.5 block">{t('skills.groups.members')}</Label>
            <Select
              mode="multiple"
              showSearch
              placeholder={t('skills.groups.membersPlaceholder')}
              value={skillIds}
              onChange={(vals) => setSkillIds(vals)}
              options={skillsList.map((s) => {
                const currentGroupId = (s as { groupId?: string | null }).groupId ?? null
                const movedFromOther = currentGroupId && (!group || currentGroupId !== group.id)
                return {
                  value: s.id,
                  label: s.name,
                  description: s.description,
                  movedFromOther,
                }
              })}
              filterOption={selectFilterOption}
              optionRender={(option) => {
                const data = option.data as { description?: string; movedFromOther?: boolean }
                return (
                  <div className="flex flex-col min-w-0 overflow-hidden py-0.5">
                    <span className="truncate text-sm">{option.label}</span>
                    {data.description && (
                      <span className="text-xs text-muted-foreground truncate block">
                        {data.description}
                      </span>
                    )}
                    {data.movedFromOther && (
                      <span className="block truncate text-xs text-warning">
                        {t('skills.groups.movedFromOther')}
                      </span>
                    )}
                  </div>
                )
              }}
              className="w-full"
              maxTagCount="responsive"
              popupMatchSelectWidth
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t('skills.groups.membersHint', { count: skillIds.length })}
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <div>
            {isEdit &&
              (confirmDelete ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleteMut.isPending}
                >
                  {deleteMut.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden />
                  )}
                  {t('skills.groups.confirmDelete')}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t('skills.groups.delete')}
                </Button>
              ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={!canSave}>
              {saving || membersLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Save className="h-4 w-4" aria-hidden />
              )}
              {t('common.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
