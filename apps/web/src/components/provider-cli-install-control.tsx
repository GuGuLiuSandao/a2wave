import { Button } from '@/components/ui/button'
import {
  type ProviderCliState,
  useInstallProviderCli,
  useUninstallProviderCli,
} from '@/hooks/use-provider-clis'
import { message } from '@/lib/antd-static'
import type { TFunction } from 'i18next'
import { AlertTriangle, CheckCircle2, Download, Info, Loader2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Install state + action for one Agent CLI.
 *
 * Shared by the Providers list cards and the Provider detail page so both
 * surfaces report identically — a Provider that reads "installed" in one place
 * and "not installed" in the other is worse than having only one surface.
 */

/**
 * Whether this CLI still needs an install action.
 *
 * Exported so a caller laying out its own row around the control decides to
 * render it on the same predicate the control uses internally; two copies would
 * drift the first time a state is added, leaving an empty row or a hidden
 * button.
 */
export function needsInstallAction(cli: ProviderCliState): boolean {
  return !(cli.installed && cli.lockDrift === 'match')
}

/**
 * Whether the installed build fails the Provider's minimum-version floor.
 *
 * `meetsMinimum` is three-state, and only an outright `false` is a defect:
 * `null` merely means the verdict is undecidable (no floor declared, or an
 * unparsable version), which must not be reported as too old. Hence `=== false`
 * rather than a falsy check.
 */
function isBelowMinimum(cli: ProviderCliState): boolean {
  return cli.meetsMinimum === false
}

/** Must stay in step with CHIP_BASE in pages/providers.tsx — these chips share a row. */
const CHIP_BASE =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-transparent px-2 py-0.5 text-[11px] font-medium'

export function ProviderCliStatusChip({ cli }: { cli: ProviderCliState }) {
  const { t } = useTranslation()

  if (cli.status === 'installing') {
    return (
      <span className={`${CHIP_BASE} bg-primary/10 text-interactive-foreground`}>
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        {t('providerClis.statusInstalling')}
      </span>
    )
  }
  if (cli.status === 'uninstalling') {
    return (
      <span className={`${CHIP_BASE} bg-primary/10 text-interactive-foreground`}>
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        {t('providerClis.statusUninstalling')}
      </span>
    )
  }
  if (!cli.installed) {
    return (
      <span className={`${CHIP_BASE} bg-warning/10 text-warning`}>
        <AlertTriangle className="size-3" aria-hidden="true" />
        {t('providerClis.statusNotInstalled')}
      </span>
    )
  }
  // Installed but not the locked build. The direction matters: only a build
  // *older* than the pin is out of date. A newer one satisfies every requirement
  // the engine has (which gates on minVersion, not on the pin), so flagging it as
  // updatable told operators their newer CLI was stale and offered a downgrade.
  if (cli.lockDrift === 'below') {
    // Below the pin is only a *problem* when it is also below the floor. The
    // platform gates on a minimum version, not on exact-pin equality, so an
    // older-but-conforming build is a supported state and gets the same
    // informational treatment as an unmanaged one. The label carries the
    // severity rather than leaving it to colour alone: amber is already spent
    // on the unrelated sandbox chip in the same row, so scanning for it does
    // not isolate a broken CLI.
    return isBelowMinimum(cli) ? (
      <span className={`${CHIP_BASE} bg-warning/10 text-warning`}>
        <AlertTriangle className="size-3" aria-hidden="true" />
        {t('providerClis.statusBelowMinimum')}
      </span>
    ) : (
      <span className={`${CHIP_BASE} bg-primary/10 text-interactive-foreground`}>
        <Info className="size-3" aria-hidden="true" />
        {t('providerClis.statusBelowLockOk')}
      </span>
    )
  }
  if (cli.lockDrift === 'above' || cli.lockDrift === 'unknown') {
    return (
      <span className={`${CHIP_BASE} bg-primary/10 text-interactive-foreground`}>
        <Info className="size-3" aria-hidden="true" />
        {t('providerClis.statusUnmanaged')}
      </span>
    )
  }
  return (
    <span className={`${CHIP_BASE} bg-success/10 text-success`}>
      <CheckCircle2 className="size-3" aria-hidden="true" />
      {t('providerClis.statusInstalled')}
    </span>
  )
}

/**
 * Copy explaining why the install action is offered.
 *
 * A build below the pin gets one of two very different reasons: an unmet floor
 * names the required version so the operator has something to act on, while a
 * conforming build is told the update is optional rather than that it is broken.
 */
function resolveActionHint(cli: ProviderCliState, t: TFunction): string {
  if (!cli.installed) return t('providerClis.notInstalledHint')
  if (cli.lockDrift !== 'below') return t('providerClis.unmanagedHint')
  if (isBelowMinimum(cli)) return t('providerClis.belowMinimumHint', { minVersion: cli.minVersion })
  return t('providerClis.belowLockMeetsMinimumHint')
}

interface ProviderCliInstallControlProps {
  cli: ProviderCliState
  /** Render the uninstall action too. The Provider card omits it to stay compact. */
  showUninstall?: boolean
}

/**
 * Callers must render this outside any wrapping link. It deliberately offers no
 * stop-propagation escape hatch: one existed while the Providers card nested the
 * whole card in an <a>, and it made an invalid <button>-in-<a> look supported —
 * every later button added there would have navigated away instead.
 */
export function ProviderCliInstallControl({
  cli,
  showUninstall = false,
}: ProviderCliInstallControlProps) {
  const { t } = useTranslation()
  const install = useInstallProviderCli()
  const uninstall = useUninstallProviderCli()

  const busy =
    cli.status === 'installing' ||
    cli.status === 'uninstalling' ||
    install.isPending ||
    uninstall.isPending

  const onInstall = () => {
    install.mutate(cli.kind, {
      onSuccess: () => message.success(t('providerClis.installStarted', { kind: cli.kind })),
      onError: (err) =>
        message.error(err instanceof Error ? err.message : t('providerClis.installFailed')),
    })
  }

  const onUninstall = () => {
    uninstall.mutate(cli.kind, {
      onSuccess: () => message.success(t('providerClis.uninstalled', { kind: cli.kind })),
      onError: (err) =>
        message.error(err instanceof Error ? err.message : t('providerClis.uninstallFailed')),
    })
  }

  // What the install action actually does depends on where the installed build
  // sits: only 'below' is an upgrade. For 'above'/'unknown' the same request
  // replaces a newer or unrecognised build with the pinned one, so it is labelled
  // as a reinstall — calling that an "update" misrepresents a downgrade.
  const actionLabel = !cli.installed
    ? t('providerClis.install')
    : cli.lockDrift === 'below'
      ? t('providerClis.update')
      : t('providerClis.reinstallPinned')

  // Why the action is offered. The compact Providers card has no room for this
  // as body copy — it truncated to "This Provider's CLI is not i..." — so it
  // rides on the button instead, where it stays available without taking space.
  const actionHint = resolveActionHint(cli, t)

  return (
    <div className="flex items-center gap-1.5">
      {needsInstallAction(cli) ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onInstall}
          title={actionHint}
          // Pulled down toward the chip scale it sits beside: the default `sm`
          // (h-8 text-xs) read as a full-weight control next to 11px tags.
          className="h-7 gap-1.5 px-2.5 text-[11px]"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="size-3" aria-hidden="true" />
          )}
          {actionLabel}
        </Button>
      ) : null}
      {showUninstall && cli.installed ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onUninstall}
          aria-label={t('providerClis.uninstall')}
          title={t('providerClis.uninstall')}
          className="h-7 px-2"
        >
          <Trash2 className="size-3" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  )
}
