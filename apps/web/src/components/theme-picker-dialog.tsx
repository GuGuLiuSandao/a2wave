import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DEFAULT_THEME_PREFERENCE,
  type ThemeDefinition,
  type ThemePreference,
  resolveThemePreference,
  themeRegistry,
} from '@/lib/themes'
import { cn } from '@/lib/utils'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ThemePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function ThemeSwatch({ theme }: { theme: ThemeDefinition }) {
  const { tokens, radii, shadows } = theme
  return (
    <div
      className="relative h-20 overflow-hidden border"
      style={{
        background: tokens.background,
        borderColor: tokens.border,
        borderRadius: radii.md,
        boxShadow: shadows.sm,
      }}
      aria-hidden="true"
    >
      <div
        className="absolute inset-y-0 left-0 w-[28%] border-r p-2"
        style={{ background: tokens.sidebar, borderColor: tokens.sidebarBorder }}
      >
        <span
          className="block h-2 w-4/5 border"
          style={{
            background: tokens.sidebarActiveBackground,
            borderColor: tokens.sidebarActiveBorder,
            borderRadius: radii.sm,
          }}
        />
        <span
          className="mt-2 block h-1 w-full opacity-60"
          style={{ background: tokens.sidebarForeground, borderRadius: radii.sm }}
        />
        <span
          className="mt-1.5 block h-1 w-3/4 opacity-40"
          style={{ background: tokens.sidebarForeground, borderRadius: radii.sm }}
        />
      </div>
      <div className="absolute inset-y-0 right-0 w-[72%] p-2.5">
        <div
          className="h-full border p-2"
          style={{
            background: tokens.card,
            borderColor: tokens.border,
            borderRadius: radii.md,
            boxShadow: shadows.xs,
          }}
        >
          <span
            className="block h-1.5 w-3/5"
            style={{ background: tokens.foreground, borderRadius: radii.sm }}
          />
          <span
            className="mt-1.5 block h-1 w-full opacity-50"
            style={{ background: tokens.mutedForeground, borderRadius: radii.sm }}
          />
          <div className="mt-2 flex gap-1.5">
            <span
              className="h-3 w-8 border"
              style={{
                background: tokens.primary,
                borderColor: tokens.primaryActive,
                borderRadius: radii.sm,
              }}
            />
            <span
              className="h-3 flex-1"
              style={{ background: tokens.muted, borderRadius: radii.sm }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function SystemSwatch() {
  const light = resolveThemePreference('system', false)
  const dark = resolveThemePreference('system', true)
  return (
    <div
      className="grid h-20 grid-cols-2 overflow-hidden rounded-md border border-border"
      aria-hidden
    >
      {[light, dark].map((theme) => (
        <div key={theme.id} className="p-2" style={{ background: theme.tokens.background }}>
          <div
            className="h-full border p-2"
            style={{ background: theme.tokens.card, borderColor: theme.tokens.border }}
          >
            <span className="block h-1.5 w-4/5" style={{ background: theme.tokens.foreground }} />
            <span className="mt-2 block h-2 w-1/2" style={{ background: theme.tokens.primary }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ThemePickerDialog({ open, onOpenChange }: ThemePickerDialogProps) {
  const { t } = useTranslation()
  const { preference, setPreference, setPreviewPreference } = useTheme()
  const [draft, setDraft] = useState<ThemePreference>(preference)
  const optionRefs = useRef(new Map<ThemePreference, HTMLInputElement>())
  const previewEnabledRef = useRef(open)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current
    previewEnabledRef.current = open
    wasOpenRef.current = open
    if (!open) {
      setPreviewPreference(null)
      return
    }
    if (justOpened) {
      setDraft(preference)
      setPreviewPreference(null)
    }
  }, [open, preference, setPreviewPreference])

  useEffect(() => () => setPreviewPreference(null), [setPreviewPreference])

  const preview = (next: ThemePreference) => {
    if (previewEnabledRef.current) setPreviewPreference(next)
  }
  const select = (next: ThemePreference) => {
    if (!previewEnabledRef.current) return
    setDraft(next)
    preview(next)
  }
  const cancel = () => {
    // Ant Design keeps the modal mounted for its closing motion. Disable
    // previewing synchronously before clearing it so a late radio change
    // cannot re-apply the draft after Escape, Cancel, or the close button.
    previewEnabledRef.current = false
    setPreviewPreference(null)
    onOpenChange(false)
  }
  const confirm = () => {
    previewEnabledRef.current = false
    setPreference(draft)
    onOpenChange(false)
  }
  const handleAfterOpenChange = (nextOpen: boolean) => {
    previewEnabledRef.current = nextOpen
    if (!nextOpen) return
    // Ant Design focuses the modal container by default; move focus to the
    // persisted option once its opening transition finishes so keyboard users
    // start on the theme that is actually in use.
    optionRefs.current.get(draft)?.focus({ preventScroll: true })
  }

  const options: Array<{
    preference: ThemePreference
    label: string
    description: string
    appearance: 'system' | 'light' | 'dark'
    swatch: React.ReactNode
  }> = [
    {
      preference: DEFAULT_THEME_PREFERENCE,
      label: t('appearance.system.name'),
      description: t('appearance.system.description'),
      appearance: 'system',
      swatch: <SystemSwatch />,
    },
    ...themeRegistry.map((theme) => ({
      preference: theme.id,
      label: t(theme.labelKey),
      description: t(theme.descriptionKey),
      appearance: theme.appearance,
      swatch: <ThemeSwatch theme={theme} />,
    })),
  ]
  const [systemOption, ...themeOptions] = options

  const renderOption = (option: (typeof options)[number], featured = false) => {
    const selected = draft === option.preference
    const AppearanceIcon =
      option.appearance === 'system' ? Monitor : option.appearance === 'dark' ? Moon : Sun

    return (
      <label
        key={option.preference}
        data-theme-option={option.preference}
        className={cn(
          'group relative block min-w-0 cursor-pointer rounded-lg border bg-card p-3 text-left shadow-xs transition-[border-color,box-shadow,transform] duration-150',
          'hover:-translate-y-px hover:border-primary/60 hover:shadow-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
          featured && 'sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-center sm:gap-4',
          selected && 'border-primary shadow-md ring-1 ring-primary/25',
        )}
      >
        <input
          ref={(node) => {
            if (node) optionRefs.current.set(option.preference, node)
            else optionRefs.current.delete(option.preference)
          }}
          type="radio"
          name="appearance-theme"
          value={option.preference}
          checked={selected}
          aria-label={`${option.label} · ${option.description}`}
          className="sr-only"
          onChange={() => select(option.preference)}
        />
        {option.swatch}
        <div className={cn('mt-3 flex items-start gap-2 px-0.5', featured && 'sm:mt-0')}>
          <AppearanceIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold leading-snug text-foreground">
                {option.label}
              </span>
              {selected && (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              )}
            </div>
            <p
              className={cn(
                'mt-1 text-xs leading-5 text-muted-foreground',
                !featured && 'min-h-10',
              )}
            >
              {option.description}
            </p>
          </div>
        </div>
      </label>
    )
  }

  return (
    <Dialog
      open={open}
      width={780}
      padding={20}
      afterOpenChange={handleAfterOpenChange}
      onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : cancel())}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('appearance.title')}</DialogTitle>
          <DialogDescription>{t('appearance.description')}</DialogDescription>
        </DialogHeader>

        <div
          className="mt-5 max-h-[min(68vh,42rem)] space-y-4 overflow-y-auto p-2"
          role="radiogroup"
          aria-label={t('appearance.groupLabel')}
        >
          <section aria-labelledby="appearance-system-heading">
            <h3
              id="appearance-system-heading"
              className="mb-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            >
              {t('appearance.systemSection')}
            </h3>
            {renderOption(systemOption, true)}
          </section>
          <section aria-labelledby="appearance-theme-heading">
            <h3
              id="appearance-theme-heading"
              className="mb-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            >
              {t('appearance.themeSection')}
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {themeOptions.map((option) => renderOption(option))}
            </div>
          </section>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">{t('appearance.previewHint')}</p>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            {t('common.cancel')}
          </Button>
          <Button onClick={confirm}>{t('appearance.apply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
