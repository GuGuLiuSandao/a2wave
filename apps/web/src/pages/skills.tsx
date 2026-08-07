import { RemoteSkillInstallDialog } from '@/components/remote-skill-install-dialog'
import { SkillGroupModal } from '@/components/skill-group-modal'
import { SkillUploadDialog } from '@/components/skill-upload-dialog'
import { SkillFormModal } from '@/components/skill/skill-form-modal'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentUser } from '@/hooks/use-auth'
import { useSkillGroups } from '@/hooks/use-skill-groups'
import { useSkills, useUploadSkill, useUploadSkillFolder } from '@/hooks/use-skills'
import { useUrlFlag, useUrlRecord } from '@/hooks/use-url-state'
import { message } from '@/lib/antd-static'
import { formatApiError } from '@/lib/api-error'
import { resolveCollectionIcon } from '@/lib/collection-icons'
import { toUploadEntries } from '@/lib/upload-entries'
import type { Skill, SkillGroup, SkillVisibility } from '@a2wave/shared'
import { Dropdown } from 'antd'
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderPlus,
  Github,
  Globe2,
  Loader2,
  type LucideIcon,
  Pencil,
  Plus,
  Upload,
  Zap,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const ACCEPT = '.md,.zip'

type PendingSkillUpload =
  | { kind: 'file'; file: File }
  | { kind: 'folder'; files: File[]; paths: string[] }

function SkillCard({ skill, onOpen }: { skill: Skill; onOpen: (skill: Skill) => void }) {
  const { t } = useTranslation()
  return (
    <Card
      // biome-ignore lint/a11y/useSemanticElements: <button> accepts phrasing content only, while
      // this card renders an <h3> title and paragraph blocks — invalid inside a button.
      role="button"
      tabIndex={0}
      onClick={() => onOpen(skill)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(skill)
        }
      }}
      className="h-full cursor-pointer hover:border-primary/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CardHeader className="pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle className="min-w-0 flex-1 text-base truncate font-semibold">
              {skill.name}
            </CardTitle>
            {skill.visibility === 'all-users' ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                <Globe2 className="h-3 w-3" aria-hidden />
                {t('skillDetail.visibilityAllUsers')}
              </span>
            ) : null}
          </div>
          {skill.authorName ? (
            <p className="text-xs text-muted-foreground truncate">
              {t('skills.submittedBy', { name: skill.authorName })}
            </p>
          ) : null}
          {skill.remoteSource ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
              <Github className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{skill.remoteSource.repository}</span>
              {skill.sourceDirty ? (
                <span className="shrink-0 text-warning">{t('skills.remote.modified')}</span>
              ) : null}
            </p>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {skill.description ? (
          <p
            className="text-sm text-muted-foreground line-clamp-2 leading-relaxed"
            style={{ textWrap: 'pretty' }}
          >
            {skill.description}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground/50 italic">{t('common.noDescription')}</p>
        )}
      </CardContent>
    </Card>
  )
}

interface GroupProps {
  title: string
  subtitle?: string
  Icon: LucideIcon
  skills: Skill[]
  defaultOpen?: boolean
  onEdit?: () => void
  onOpenSkill: (skill: Skill) => void
}

function SkillGroupSection({
  title,
  subtitle,
  Icon,
  skills,
  defaultOpen = true,
  onEdit,
  onOpenSkill,
}: GroupProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-left rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {subtitle ?? t('skills.groups.memberCount', { count: skills.length })}
          </span>
        </button>
        {onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            {t('skills.groups.edit')}
          </Button>
        )}
      </div>
      {open &&
        (skills.length === 0 ? (
          <p className="text-sm text-muted-foreground italic pl-6">{t('skills.groups.empty')}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {skills.map((s) => (
              <SkillCard key={`${title}-${s.id}`} skill={s} onOpen={onOpenSkill} />
            ))}
          </div>
        ))}
    </section>
  )
}

export function SkillsPage() {
  const { t } = useTranslation()
  const { data: skillsResult, isLoading } = useSkills({ pageSize: 500 })
  const { data: groupsResult, isLoading: isGroupsLoading } = useSkillGroups()
  const { data: currentUser } = useCurrentUser()
  const skills = skillsResult?.data ?? []
  const groups = groupsResult?.data ?? []

  const uploadSkill = useUploadSkill()
  const uploadSkillFolder = useUploadSkillFolder()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<PendingSkillUpload>()
  // Modal state lives in the URL so an editor is linkable and survives a reload.
  const groupModal = useUrlRecord('group')
  const [remoteInstallOpen, setRemoteInstallOpen] = useUrlFlag('install')
  // Skill create/edit modal (undefined skillId = create).
  const skillModal = useUrlRecord('skill')
  const openSkill = (skill: Skill) => skillModal.openEdit(skill.id)

  const skillsByGroupId = useMemo(() => {
    const map = new Map<string | null, Skill[]>()
    for (const s of skills) {
      const gid = (s as Skill & { groupId?: string | null }).groupId ?? null
      const list = map.get(gid) ?? []
      list.push(s)
      map.set(gid, list)
    }
    return map
  }, [skills])

  const visibleGroupIds = new Set(groups.map((group) => group.id))
  // A shared Skill may belong to its administrator's private group. Show it in
  // the ungrouped section for other users instead of letting it disappear.
  const ungroupedSkills = skills.filter(
    (skill) => !skill.groupId || !visibleGroupIds.has(skill.groupId),
  )

  const handleUpload = (file: File) => {
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'))
    if (ext !== '.md' && ext !== '.zip') {
      uploadSkill.reset()
      message.error(t('errors.skillUploadExt'))
      return
    }
    setPendingUpload({ kind: 'file', file })
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleUpload(file)
    e.target.value = ''
  }

  const handleFolderUpload = (fileList: FileList | null) => {
    const entries = toUploadEntries(fileList)
    if (entries.length === 0) return
    const hasSkillMd = entries.some((e) => {
      const base = e.path.split('/').pop() ?? ''
      return base === 'SKILL.md'
    })
    if (!hasSkillMd) {
      uploadSkillFolder.reset()
      message.error(t('errors.skillFolderNoMd'))
      return
    }
    setPendingUpload({
      kind: 'folder',
      files: entries.map((entry) => entry.file),
      paths: entries.map((entry) => entry.path),
    })
  }

  const confirmUpload = async (visibility: SkillVisibility) => {
    if (!pendingUpload) return
    try {
      const res =
        pendingUpload.kind === 'file'
          ? await uploadSkill.mutateAsync({ file: pendingUpload.file, visibility })
          : await uploadSkillFolder.mutateAsync({
              files: pendingUpload.files,
              paths: pendingUpload.paths,
              visibility,
            })
      setPendingUpload(undefined)
      skillModal.openEdit(res.data.id)
    } catch (err) {
      message.error(formatApiError(err, t))
    }
  }

  const onFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFolderUpload(e.target.files)
    e.target.value = ''
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleUpload(file)
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }
  const onDragLeave = () => setDragOver(false)

  const openCreateGroup = () => groupModal.openCreate()
  const openEditGroup = (g: SkillGroup) => groupModal.openEdit(g.id)
  // The modal takes the group object; resolve it from the id in the URL so a
  // deep link works before the user has clicked anything.
  const editingGroup = groupModal.id ? (groups.find((g) => g.id === groupModal.id) ?? null) : null
  // `?group=<id>` naming a group that no longer exists (deleted, mistyped, or a
  // stale shared link) resolves to null — which the modal reads as CREATE mode.
  // Saving there would silently create a new group instead of editing the one
  // the link pointed at, so surface it as not-found rather than degrading.
  const groupNotFound = !!groupModal.id && !isGroupsLoading && !editingGroup

  const busy = isLoading || isGroupsLoading
  const hasAnything = skills.length > 0 || groups.length > 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2
            className="text-2xl font-semibold tracking-tight text-foreground"
            style={{ textWrap: 'balance' }}
          >
            {t('skills.title')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">{t('skills.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            aria-hidden
            onChange={onFileChange}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            className="hidden"
            aria-hidden
            onChange={onFolderChange}
          />
          <Button variant="outline" onClick={openCreateGroup}>
            <FolderPlus className="h-4 w-4" aria-hidden="true" />
            {t('skills.groups.new')}
          </Button>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'file',
                  label: t('skills.uploadFile'),
                  icon: <File className="h-4 w-4" />,
                  onClick: () => fileInputRef.current?.click(),
                },
                {
                  key: 'folder',
                  label: (
                    <div className="flex flex-col">
                      <span>{t('skills.uploadFolder')}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('skills.uploadFolderHelp')}
                      </span>
                    </div>
                  ),
                  icon: <Folder className="h-4 w-4" />,
                  onClick: () => folderInputRef.current?.click(),
                },
                {
                  type: 'divider',
                },
                {
                  key: 'remote',
                  label: t('skills.remote.menu'),
                  icon: <Github className="h-4 w-4" />,
                  onClick: () => setRemoteInstallOpen(true),
                },
              ],
            }}
            trigger={['click']}
            placement="bottomRight"
            disabled={uploadSkill.isPending || uploadSkillFolder.isPending}
          >
            <Button
              variant="outline"
              disabled={uploadSkill.isPending || uploadSkillFolder.isPending}
            >
              {uploadSkill.isPending || uploadSkillFolder.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="h-4 w-4" aria-hidden="true" />
              )}
              {t('skills.upload')}
            </Button>
          </Dropdown>
          <Button onClick={() => skillModal.openCreate()}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('skills.newSkill')}
          </Button>
        </div>
      </div>

      {busy ? (
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
      ) : !hasAnything ? (
        <Card>
          {/* biome-ignore lint/a11y/useSemanticElements: this dropzone holds an <h3>, paragraphs
              and a nested upload <Button> — none of which is valid inside a <button>. */}
          <CardContent
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInputRef.current?.click()
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            className={`flex flex-col items-center justify-center py-20 px-8 text-center rounded-xl border-2 border-dashed transition-colors ${
              dragOver ? 'border-primary/50 bg-primary/5' : 'border-transparent hover:border-border'
            } ${uploadSkill.isPending ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}
            aria-label={t('skills.uploadAria')}
          >
            <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground mb-5">
              <Zap className="h-7 w-7" aria-hidden />
            </div>
            <h3 className="font-semibold text-base mb-1 text-foreground">
              {t('skills.emptyTitle')}
            </h3>
            <p
              className="text-sm text-muted-foreground mb-5 max-w-xs"
              style={{ textWrap: 'pretty' }}
            >
              {t('skills.emptyDesc')}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                fileInputRef.current?.click()
              }}
              disabled={uploadSkill.isPending}
            >
              {uploadSkill.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="h-4 w-4" aria-hidden="true" />
              )}
              {t('skills.upload')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <SkillGroupSection
              key={g.id}
              title={g.name}
              Icon={resolveCollectionIcon(g.icon)}
              skills={skillsByGroupId.get(g.id) ?? []}
              onEdit={() => openEditGroup(g)}
              onOpenSkill={openSkill}
              defaultOpen={false}
            />
          ))}
          <SkillGroupSection
            title={t('skills.groups.ungrouped')}
            Icon={Archive}
            skills={ungroupedSkills}
            onOpenSkill={openSkill}
            defaultOpen
          />
        </div>
      )}

      {/* Withheld while the group list is still loading, so a deep link does not
          flash create-mode before its target resolves. */}
      <SkillGroupModal
        open={groupModal.open && !groupNotFound && !(groupModal.id && isGroupsLoading)}
        onOpenChange={(open) => !open && groupModal.close()}
        group={editingGroup}
      />
      <AlertDialog open={groupNotFound} onOpenChange={(open) => !open && groupModal.close()}>
        <AlertDialogContent>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            {t('skills.groupNotFoundTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('skills.groupNotFoundDesc')}</AlertDialogDescription>
          <AlertDialogFooter>
            <Button onClick={() => groupModal.close()}>{t('common.close')}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RemoteSkillInstallDialog
        open={remoteInstallOpen}
        onOpenChange={setRemoteInstallOpen}
        groups={groups}
        onInstalled={(installed) => {
          message.success(t('skills.remote.success', { count: installed.length }))
          if (installed.length === 1) {
            skillModal.openEdit(installed[0].id)
          }
        }}
      />
      <SkillUploadDialog
        open={!!pendingUpload}
        isAdmin={currentUser?.role === 'admin'}
        isPending={uploadSkill.isPending || uploadSkillFolder.isPending}
        selection={
          pendingUpload?.kind === 'file'
            ? { kind: 'file', name: pendingUpload.file.name }
            : pendingUpload
              ? { kind: 'folder', count: pendingUpload.files.length }
              : undefined
        }
        onOpenChange={(open) => {
          if (!open) setPendingUpload(undefined)
        }}
        onConfirm={(visibility) => void confirmUpload(visibility)}
      />
      <SkillFormModal
        open={skillModal.open}
        onOpenChange={(open) => !open && skillModal.close()}
        skillId={skillModal.id}
      />
    </div>
  )
}
