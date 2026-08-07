import { Skeleton } from '@/components/ui/skeleton'
import { formatApiError } from '@/lib/api-error'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  /** False in create mode — nothing to load, so children mount immediately. */
  isEditMode: boolean
  /**
   * The entity detail query's `isPending`. Note this is also true while the
   * query is *disabled*, which is why closed modals must pass `isOpen: false`
   * rather than relying on this flag alone.
   */
  isLoading: boolean
  /**
   * The entity detail query's error, if it failed. Note this may be set while
   * `entity` still holds the last good data (a failed *refetch*) — that case is
   * a non-blocking warning, not a reason to take the form away.
   */
  error?: { message?: string } | null
  /** The loaded entity. Missing after a settled query = not found. */
  entity: unknown
  /**
   * Whether the host modal is open. A closed modal disables its detail query,
   * which leaves `isLoading` stuck true — without this the gate would render a
   * skeleton (or worse, the not-found state) into the hidden modal and flash it
   * on the next open. Closed = render children as-is; nothing is visible anyway.
   */
  isOpen: boolean
  children: ReactNode
}

/**
 * Guards an edit form against mounting before its entity has loaded.
 *
 * Without this, an edit form renders with blank `defaultValues` and a user on a
 * slow connection can type into (and submit) that blank form, writing the
 * defaults over the real record — description/content nulled out, credentials
 * and sync config reset. A late-arriving response is just as bad: `reset()`
 * would overwrite whatever the user had already typed.
 *
 * Create mode has no entity to wait for, so `isEditMode: false` passes through.
 */
export function EntityFormGate({ isEditMode, isLoading, error, entity, isOpen, children }: Props) {
  const { t } = useTranslation()

  if (!isEditMode || !isOpen) return <>{children}</>

  if (isLoading) {
    return (
      <div
        className="space-y-4 py-2"
        // biome-ignore lint/a11y/useSemanticElements: <output> is display:inline and carries form
        // semantics (it belongs to a form's result), neither of which fits this block-level
        // skeleton container — swapping it in would collapse the stacked skeleton layout.
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">{t('common.loading')}</span>
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-2/3 rounded-md" />
        <Skeleton className="h-32 w-full rounded-md" />
      </div>
    )
  }

  // Only block when there is no entity to edit — either the initial load failed
  // or a settled query returned nothing (the record is gone). Once `entity` is
  // present the form stays mounted no matter what `error` says: TanStack keeps
  // the last good `data` alongside a *refetch* error, and unmounting on that
  // would destroy whatever the user had already typed. KB documents poll every
  // 30s, and every detail query refetches on window focus, so a transient
  // failure mid-edit is routine — it must not cost the user their input.
  if (!entity) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">{t('common.entityLoadFailed')}</p>
        {/* `break-all` is load-bearing: SCM routes answer with prose that embeds a
            full path, which would otherwise overflow this narrow container. */}
        {error && (
          <p className="text-xs text-muted-foreground break-all">{formatApiError(error, t)}</p>
        )}
      </div>
    )
  }

  return (
    <>
      {/* A background refresh failed but the loaded entity is still editable —
          warn without taking the form away. */}
      {error && (
        <p
          className="mb-3 text-xs text-muted-foreground"
          // biome-ignore lint/a11y/useSemanticElements: this is a block-level warning paragraph,
          // not a form's calculated result; <output> is display:inline and would drop the `mb-3`
          // block spacing that separates the warning from the form below it.
          role="status"
          aria-live="polite"
          data-testid="entity-refresh-warning"
        >
          {t('common.entityRefreshFailed')}
        </p>
      )}
      {children}
    </>
  )
}
