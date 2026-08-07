import type { ThemeConfig } from 'antd'
import { theme as antdThemeApi } from 'antd'
import type { ThemeDefinition } from './themes'

/**
 * Design tokens — single source of truth for values shared between
 * Tailwind CSS (@theme in globals.css) and Ant Design ConfigProvider.
 *
 * Token hierarchy:
 *   Layer 1 — Primitive (raw color scale values)
 *   Layer 2 — Semantic  (contextual meaning: background, foreground, …)
 *   Layer 3 — Component (specific usage: card, sidebar, …)
 *
 * NOTE: When you change a value here, update the corresponding CSS variable
 * in `src/styles/globals.css` @theme block to keep them in sync.
 */

// ─── Layer 1: Primitive tokens ───────────────────────────────────

export const primitive = {
  warm: {
    50: '#faf9f7',
    100: '#f3f1ed',
    200: '#e8e5df',
    300: '#d4d0c8',
    400: '#a8a29e',
    500: '#78716c',
    600: '#57534e',
    700: '#44403c',
    800: '#292524',
    900: '#1c1917',
  },
  indigo: {
    50: '#eef2ff',
    400: '#818cf8',
    500: '#6366f1',
    600: '#4f46e5',
    700: '#4338ca',
  },
  violet: {
    400: '#a78bfa',
    500: '#8b5cf6',
  },
  emerald: {
    50: '#ecfdf5',
    400: '#34d399',
    500: '#10b981',
    600: '#059669',
    700: '#047857',
  },
  amber: {
    50: '#fffbeb',
    400: '#fbbf24',
    500: '#f59e0b',
    600: '#d97706',
    700: '#b45309',
  },
  red: {
    50: '#fef2f2',
    400: '#f87171',
    500: '#ef4444',
    600: '#dc2626',
    700: '#b91c1c',
  },
  white: '#ffffff',
} as const

// ─── Layer 2: Semantic tokens ────────────────────────────────────

export const semantic = {
  background: primitive.warm[50],
  foreground: primitive.warm[900],
  card: primitive.white,
  cardForeground: primitive.warm[900],
  muted: primitive.warm[100],
  mutedForeground: primitive.warm[500],
  border: primitive.warm[200],
  input: primitive.warm[200],
  // Focus ring is a lighter indigo than the solid brand fill — reads cleaner
  // as a 2px halo on dense forms without shouting like the primary color.
  ring: primitive.indigo[400],
  primary: primitive.indigo[500],
  primaryHover: primitive.indigo[600],
  primaryActive: primitive.indigo[700],
  primaryForeground: primitive.white,
  // Soft brand surface for tinted callouts / selected rows (the bg-primary/8 pattern).
  primarySubtle: primitive.indigo[50],
  // Foreground for links, selected labels, and small interactive text. Unlike
  // `primary`, this token must remain readable when a theme uses a bright brand fill.
  interactiveForeground: primitive.indigo[700],
  secondary: primitive.warm[100],
  secondaryForeground: primitive.warm[700],
  accent: primitive.warm[100],
  accentForeground: primitive.warm[700],
  // ── Interaction states — mirror of --color-surface-* in globals.css.
  //    Hover is a translucent brand tint, not an opaque grey: `muted` doubles
  //    as a resting surface, so reusing it for hover collapsed both onto one
  //    scale and dropped a grey slab over the row. Being translucent, one
  //    value composites correctly over cards, tinted rows and panel headers.
  //    hover → selected are two stops of the same indigo.
  surfaceHover: 'color-mix(in srgb, var(--color-primary) 5%, transparent)',
  surfaceSelected: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
  // ── Status: each has a solid tone (badges/icons), a foreground for solid
  //    fills, and a *Subtle surface for soft info-boxes (per design-tokens.md
  //    "info areas" pattern). Prefer these over raw amber-*/red-*/emerald-*. ──
  destructive: primitive.red[500],
  destructiveForeground: primitive.white,
  destructiveSubtle: primitive.red[50],
  success: primitive.emerald[500],
  successForeground: primitive.white,
  successSubtle: primitive.emerald[50],
  warning: primitive.amber[500],
  warningForeground: primitive.white,
  warningSubtle: primitive.amber[50],
} as const

// ─── Layer 3: Component tokens ───────────────────────────────────

export const component = {
  sidebar: {
    bg: primitive.white,
    // Inactive nav labels — warm-600 keeps the *primary* navigation legible
    // (muted-foreground/warm-500 read as disabled). Hover deepens to warm-800.
    foreground: primitive.warm[600],
    foregroundHover: primitive.warm[800],
    border: primitive.warm[100],
    muted: primitive.warm[50],
    active: primitive.indigo[500],
  },
  tab: {
    navFontSize: 15,
    navFontWeight: 600,
    cardFontSize: 13,
    cardFontWeight: 400,
  },
  // segmentedPanel: Segmented control connected to its content area in one bordered card.
  // CSS layer: --segmented-panel-* vars + .segmented-panel / .segmented-panel-header / .segmented-panel-body classes in globals.css.
  segmentedPanel: {
    borderOpacity: 0.6, // border-border/60
    headerBgOpacity: 0.4, // bg-muted/40
    bodyBgOpacity: 0.1, // bg-muted/10
  },
} as const

// ─── Typography ──────────────────────────────────────────────────

export const typography = {
  fontFamily: "'Inter Variable', Inter, system-ui, -apple-system, sans-serif",
  fontSize: 13,
  borderRadius: 8,
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
  },
} as const

// ─── Ant Design theme (derived from tokens above) ───────────────

export function createAntdTheme(activeTheme: ThemeDefinition): ThemeConfig {
  const { tokens } = activeTheme
  // A theme's brand fill is not necessarily a visible focus boundary. Neo
  // Yellow, for example, intentionally uses a fluorescent primary on a light
  // card. Keep form-control boundaries on the semantic ring token so focused
  // and hovered fields retain the WCAG 3:1 non-text contrast target.
  const formControlFocus = {
    activeBorderColor: tokens.ring,
    hoverBorderColor: tokens.ring,
    activeShadow: `0 0 0 2px color-mix(in srgb, ${tokens.ring} 22%, transparent)`,
  }
  return {
    algorithm: activeTheme.appearance === 'dark' ? antdThemeApi.darkAlgorithm : undefined,
    cssVar: { key: activeTheme.id },
    token: {
      colorPrimary: tokens.primary,
      colorPrimaryHover: tokens.primaryHover,
      colorPrimaryActive: tokens.primaryActive,
      colorLink: tokens.interactiveForeground,
      colorLinkHover: tokens.interactiveForeground,
      colorLinkActive: tokens.interactiveForeground,
      colorError: tokens.destructive,
      colorSuccess: tokens.success,
      colorWarning: tokens.warning,
      colorBgContainer: tokens.card,
      colorBgElevated: tokens.card,
      colorBgLayout: tokens.background,
      colorBgBase: tokens.background,
      colorBorder: tokens.border,
      colorBorderSecondary: tokens.border,
      colorText: tokens.foreground,
      colorTextSecondary: tokens.mutedForeground,
      colorTextTertiary: tokens.mutedForeground,
      // Hover fill for list-like controls (Dropdown/Select menu items, etc.).
      // antd defaults to an opaque cool grey; align it with the design-system
      // `surface-hover` indigo tint so every hovered list row matches the
      // sidebar nav hover (hover:bg-surface-hover) instead of flashing grey.
      controlItemBgHover: `color-mix(in srgb, ${tokens.primary} 7%, transparent)`,
      controlItemBgActive: `color-mix(in srgb, ${tokens.primary} 14%, transparent)`,
      // Warm-tinted overlay shadow so antd popovers/dropdowns/selects match the
      // warm --shadow-* scale instead of falling back to a cool-grey default.
      boxShadowSecondary: activeTheme.shadows.lg,
      borderRadius: activeTheme.antd.borderRadius,
      fontFamily: typography.fontFamily,
      fontSize: typography.fontSize,
    },
    components: {
      Input: formControlFocus,
      InputNumber: formControlFocus,
      DatePicker: formControlFocus,
      Select: {
        activeBorderColor: tokens.ring,
        hoverBorderColor: tokens.ring,
        activeOutlineColor: `color-mix(in srgb, ${tokens.ring} 22%, transparent)`,
      },
      Tabs: {
        titleFontSize: component.tab.navFontSize,
        // Nav bottom margin. antd defaults to `0 0 ${token.margin}px 0` (16px),
        // which is smaller than the 20px (space-y-5) rhythm around tab strips in
        // cards, so the gap above the nav looked tighter than the gap below.
        // Align it to 20px globally so every Tabs strip sits with even spacing.
        horizontalMargin: '0 0 20px 0',
      },
      Table: {
        // antd draws a short vertical tick between header cells via a `::before`
        // pseudo-element that spans only part of the header height and has no
        // counterpart in the body, so it reads as a floating stub rather than a
        // column divider. Collapse it to zero width and lean on a single solid
        // rule under the header to separate it from the rows instead.
        headerSplitColor: 'transparent',
        // Row separators sit one step lighter than `border` so the header rule
        // (kept at the full border color in globals.css) reads as the stronger
        // edge. antd derives both from the same token by default, which left the
        // header indistinguishable from every row line.
        borderColor: tokens.border,
        // Row hover: the design-system `surface-hover` indigo tint (a light
        // primary wash), matching the sidebar nav hover. Without this, table
        // rows in the User Management / Audit Log lists fell back to antd's
        // opaque cool-grey default, reading as a different system than the rest
        // of the app. hover previews the `surface-selected` tint a row would take.
        rowHoverBg: `color-mix(in srgb, ${tokens.primary} 7%, transparent)`,
      },
      Segmented: {
        // Track: a soft brand tint (primarySubtle = indigo-50), consistent with
        // other tinted brand surfaces (info-panel, preset badge). The selected
        // item stays solid `primary`, so the active pill still separates from the
        // track by depth + shadow rather than by hue.
        trackBg: tokens.primarySubtle,
        trackPadding: 3,
        // Active item: solid brand fill — the selected option is a committed
        // choice, so it carries the primary color rather than a white card.
        itemSelectedBg: tokens.primary,
        itemSelectedColor: tokens.primaryForeground,
        // Inactive item. Hover only nudges from muted → slightly-darker muted (not
        // a near-black warm[700]) so clicking an option doesn't flash the label to
        // black mid-transition — the switch stays calm.
        itemColor: tokens.mutedForeground,
        itemHoverColor: tokens.foreground,
        itemHoverBg: 'transparent',
        borderRadius: activeTheme.antd.borderRadius,
        borderRadiusSM: Math.max(activeTheme.antd.borderRadius - 2, 1),
      },
    },
  }
}
