/**
 * The single built-in brand icon: the system default logo
 * (/brand-icons/default.svg — the original waves + purple gradient).
 * The SVG carries its own colors and a transparent background; it lives in
 * apps/web/public/brand-icons/. Selecting/uploading writes into
 * branding.faviconUrl (the value is the public path), which drives both the
 * browser favicon and the brand mark in the sidebar header.
 * No other presets are offered — users replace it by uploading a custom icon.
 */
export interface BrandPreset {
  /** Stable identifier, used for the i18n label and selected-state comparison. */
  key: string
  /** Public path, written directly into faviconUrl. */
  url: string
}

/** Public path of the default brand icon (written back when restoring the default). */
export const DEFAULT_BRAND_ICON_URL = '/brand-icons/default.svg'

export const BRAND_PRESETS: BrandPreset[] = [{ key: 'default', url: DEFAULT_BRAND_ICON_URL }]
