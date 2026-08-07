import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EntityFormGate } from '@/components/ui/entity-form-gate'
import { useSkill } from '@/hooks/use-skills'
import { useTranslation } from 'react-i18next'
import { SkillForm } from './skill-form'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** undefined = create mode; a value = edit mode */
  skillId?: string
}

/** Modal shell hosting the Skill create/edit form. */
export function SkillFormModal({ open, onOpenChange, skillId }: Props) {
  const { t } = useTranslation()
  // Only fetch the title source while open, so a closed modal doesn't keep a
  // stale request tied to its last skillId (empty id disables the query).
  const { data: skill, isPending, error } = useSkill(open ? (skillId ?? '') : '')
  const title = skillId ? (skill?.name ?? t('skills.newSkill')) : t('skills.newSkill')

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={760} scrollBody>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* The form owns its own layout: the tab bar and save bar stay pinned
            while only the active tab's content scrolls. We just bound the height
            here (70vh) and let the form manage the scroll region internally. */}
        <div className="mt-4 max-h-[70vh]">
          {/* In edit mode the form must not mount until the skill has loaded —
              a blank form is submittable and would null out the real record. */}
          <EntityFormGate
            isEditMode={!!skillId}
            isOpen={open}
            isLoading={isPending}
            error={error}
            entity={skill}
          >
            {/* Remount the form per target so create/edit state never leaks between opens */}
            <SkillForm
              key={skillId ?? 'new'}
              skillId={skillId}
              onSaved={() => onOpenChange(false)}
              onDeleted={() => onOpenChange(false)}
            />
          </EntityFormGate>
        </div>
      </DialogContent>
    </Dialog>
  )
}
