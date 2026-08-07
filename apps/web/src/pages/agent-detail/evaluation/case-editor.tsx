import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { EvaluationCaseRow } from '@/hooks/use-evaluation'
import type { EvaluationTurn } from '@a2wave/shared'
import { ArrowDown, ArrowUp, Bot, Plus, User, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface CaseEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new case */
  editing: EvaluationCaseRow | null
  onSubmit: (input: { name: string; turns: EvaluationTurn[] }) => void
  isPending: boolean
}

/**
 * Turns carry a client-side uid used only as a React key. Position cannot serve
 * as identity here: reordering or deleting a turn would make React reuse the
 * wrong textarea and the typed text would jump between rows.
 */
interface DraftTurn extends EvaluationTurn {
  uid: string
}

let turnUidSeq = 0
const nextTurnUid = () => `turn-${++turnUidSeq}`

const emptyTurn = (): DraftTurn => ({ uid: nextTurnUid(), request: '', expectedResponse: '' })

const CASE_NAME_MAX = 60

/**
 * Cases are identified by their first request, so asking for a separate title
 * only makes the user invent a label for something they already described.
 * An existing name is preserved — a user who renamed a case meant it.
 */
function deriveCaseName(existing: string, turns: DraftTurn[]): string {
  const kept = existing.trim()
  if (kept) return kept
  const first = turns[0]?.request.trim() ?? ''
  const oneLine = first.replace(/\s+/g, ' ')
  return oneLine.length > CASE_NAME_MAX ? `${oneLine.slice(0, CASE_NAME_MAX)}…` : oneLine
}

/**
 * One side of a turn. The role icon carries the "who is speaking" meaning that
 * a bare label cannot, which is what lets the two fields sit next to each other
 * without a wrapping card to group them.
 *
 * Two rows by default and vertically resizable — enough for the one-liner these
 * fields usually hold, without the tall empty box the old layout produced.
 */
function SpeakerField({
  icon,
  label,
  id,
  value,
  placeholder,
  onChange,
  optional,
}: {
  icon: ReactNode
  label: string
  id: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  optional?: string
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
        {optional && <span className="font-normal text-muted-foreground/70">{optional}</span>}
      </Label>
      <Textarea
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        // The base Textarea sets min-h-[80px], which forced a four-row box for
        // what is usually a one-line question. An explicit min-height keeps two
        // rows; resize-y lets a longer expectation be dragged open when needed.
        // The optional field also sits on muted ground, so the required one is
        // the field the eye lands on first.
        className={`min-h-[56px] resize-y ${optional ? 'bg-muted/30' : ''}`}
      />
    </div>
  )
}

export function CaseEditor({ open, onOpenChange, editing, onSubmit, isPending }: CaseEditorProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [turns, setTurns] = useState<DraftTurn[]>([emptyTurn()])

  // Reseed whenever the dialog opens so a previous edit never leaks into the next.
  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setTurns(
      editing?.turns?.length
        ? editing.turns.map((turn) => ({ ...turn, uid: nextTurnUid() }))
        : [emptyTurn()],
    )
  }, [open, editing])

  const updateTurn = (index: number, patch: Partial<EvaluationTurn>) => {
    setTurns((prev) => prev.map((turn, i) => (i === index ? { ...turn, ...patch } : turn)))
  }

  const moveTurn = (index: number, delta: number) => {
    setTurns((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const removeTurn = (index: number) => {
    setTurns((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  const canSubmit = turns.every((turn) => turn.request.trim().length > 0)

  const handleSubmit = () => {
    if (!canSubmit || isPending) return
    onSubmit({
      name: deriveCaseName(name, turns),
      turns: turns.map((turn) => ({
        request: turn.request.trim(),
        expectedResponse: turn.expectedResponse.trim(),
      })),
    })
  }

  return (
    // 560 rather than 720: these are two short fields, and the extra width was
    // what made the inputs read as large empty rectangles.
    <Dialog open={open} onOpenChange={onOpenChange} width={560}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? t('agentEvaluation.case.editTitle') : t('agentEvaluation.case.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('agentEvaluation.case.dialogDesc')}</DialogDescription>
        </DialogHeader>

        {/* A case is a conversation, so it is laid out as one: alternating
            speaker rows down a single column. The previous version wrapped each
            turn in its own bordered card inside the already-bordered dialog,
            which produced boxes inside boxes and a lot of dead space for what is
            usually a single question and answer. */}
        {/* Vertical rhythm, tightest to loosest: label→field (4px) < the two
            fields of one turn (12px) < separate turns (24px). DialogHeader
            carries no bottom margin of its own, so mt-5 opens the gap the
            description otherwise collides with. */}
        <div className="mt-5 max-h-[60vh] space-y-6 overflow-y-auto pr-1">
          {turns.map((turn, index) => (
            <div key={turn.uid} className="group/turn space-y-3">
              {/* The turn number only matters once there is more than one turn;
                  for a single-turn case it is noise. */}
              {turns.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('agentEvaluation.case.turnLabel', { index: index + 1 })}
                  </span>
                  <div className="h-px flex-1 bg-border/60" />
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100">
                    {index > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={() => moveTurn(index, -1)}
                        aria-label={t('agentEvaluation.case.moveUp')}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {index < turns.length - 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={() => moveTurn(index, 1)}
                        aria-label={t('agentEvaluation.case.moveDown')}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() => removeTurn(index)}
                      aria-label={t('agentEvaluation.case.removeTurn')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}

              <SpeakerField
                icon={<User className="h-3.5 w-3.5" />}
                label={t('agentEvaluation.case.requestLabel')}
                id={`turn-request-${index}`}
                value={turn.request}
                placeholder={t('agentEvaluation.case.requestPlaceholder')}
                onChange={(v) => updateTurn(index, { request: v })}
              />

              <SpeakerField
                icon={<Bot className="h-3.5 w-3.5" />}
                label={t('agentEvaluation.case.expectedLabel')}
                id={`turn-expected-${index}`}
                value={turn.expectedResponse}
                placeholder={t('agentEvaluation.case.expectedPlaceholder')}
                onChange={(v) => updateTurn(index, { expectedResponse: v })}
                optional={t('agentEvaluation.case.optional')}
              />
            </div>
          ))}
        </div>

        {/* Outside the turn list, so the list's 24px rhythm does not apply:
            adding a turn acts on the turns above, so it hugs them. Inside the
            list it sat stranded midway between the fields and the footer.
            A quiet inline action, not a full-width outlined slab — this is an
            occasional refinement, not the primary action of the dialog. */}
        <button
          type="button"
          onClick={() => setTurns((prev) => [...prev, emptyTurn()])}
          className="-ml-2 mt-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('agentEvaluation.case.addTurn')}
        </button>

        {/* mt-4 instead of the footer's default mt-5: the scroll container's
            own trailing rhythm already contributes space above it. */}
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit || isPending}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
