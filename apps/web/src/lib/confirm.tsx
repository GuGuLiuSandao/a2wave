import i18n from '@/i18n'
import type { ModalFuncProps } from 'antd'
import { modal } from './antd-static'

/**
 * Unified confirmation dialog wrapper over `modal.confirm`.
 *
 * Centralizes the OK/Cancel button styling so every confirm across the app
 * reads from the same global design tokens instead of each call site hand-
 * picking `okType` / `okButtonProps`. Two inconsistent danger styles used to
 * coexist — `okType: 'danger'` (a red *outlined ghost* button) and
 * `okButtonProps: { danger: true }` (a red *solid* button). This wrapper
 * normalizes danger confirms to a single solid-fill treatment that matches the
 * design system's committed-action buttons (e.g. the Segmented active fill),
 * and defaults the cancel label to `common.cancel`.
 *
 * Pass `danger: true` for destructive actions; omit it for neutral confirms
 * (which use the primary brand fill). Any other `ModalFuncProps` pass through.
 */
export type ConfirmOptions = Omit<ModalFuncProps, 'okType'> & {
  /** Render the OK button as a solid destructive (red) action. */
  danger?: boolean
}

export function confirm({ danger, okButtonProps, cancelText, ...rest }: ConfirmOptions) {
  return modal.confirm({
    // Default the cancel label so call sites don't repeat `common.cancel`.
    cancelText: cancelText ?? i18n.t('common.cancel'),
    // Always a solid primary-shaped button; `danger` recolors it to the
    // destructive token as a solid fill (never the outlined ghost variant).
    okType: 'primary',
    okButtonProps: { danger: danger ?? false, ...okButtonProps },
    ...rest,
  })
}
