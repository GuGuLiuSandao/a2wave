export const THEME_STORAGE_KEY = 'a2wave.theme'
export const DEFAULT_THEME_PREFERENCE = 'system' as const

export type ThemeId = 'wave-light' | 'wave-dark' | 'neo-yellow' | 'midnight' | 'forest' | 'graphite'
export type ThemePreference = ThemeId | typeof DEFAULT_THEME_PREFERENCE
export type ThemeAppearance = 'light' | 'dark'

type NeutralScale = Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>
type StatusScale = Record<50 | 400 | 500 | 600 | 700, string>

export interface ThemeTokens {
  neutral: NeutralScale
  emerald: StatusScale
  amber: StatusScale
  red: StatusScale
  background: string
  foreground: string
  card: string
  cardForeground: string
  muted: string
  mutedForeground: string
  border: string
  input: string
  ring: string
  primary: string
  primaryHover: string
  primaryActive: string
  primaryForeground: string
  primarySubtle: string
  interactiveForeground: string
  secondary: string
  secondaryForeground: string
  accent: string
  accentForeground: string
  surfaceHover: string
  surfaceSelected: string
  destructive: string
  destructiveForeground: string
  destructiveSubtle: string
  success: string
  successForeground: string
  successSubtle: string
  warning: string
  warningForeground: string
  warningSubtle: string
  brandPanel: string
  brandPanelForeground: string
  brandPanelMutedForeground: string
  brandMarkSurface: string
  sidebar: string
  sidebarForeground: string
  sidebarForegroundHover: string
  sidebarBorder: string
  sidebarMuted: string
  sidebarActiveBackground: string
  sidebarActiveForeground: string
  sidebarActiveBorder: string
  codeBackground: string
  codeForeground: string
  codeBorder: string
  codeSelection: string
  codeVariable: string
  scrollbar: string
  scrollbarHover: string
  gradientAccent: string
  overlay: string
}

interface ThemeRadii {
  sm: string
  md: string
  lg: string
  xl: string
}

interface ThemeShadows {
  xs: string
  sm: string
  md: string
  lg: string
  xl: string
}

export interface ThemeDefinition {
  id: ThemeId
  appearance: ThemeAppearance
  labelKey: string
  descriptionKey: string
  tokens: ThemeTokens
  radii: ThemeRadii
  shadows: ThemeShadows
  antd: { borderRadius: number }
}

const waveLightNeutral: NeutralScale = {
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
}

const darkNeutral: NeutralScale = {
  50: '#1b1e25',
  100: '#232730',
  200: '#303641',
  300: '#454c59',
  400: '#747d8d',
  500: '#a1a8b3',
  600: '#c0c5cd',
  700: '#d7dae0',
  800: '#e8eaed',
  900: '#f6f7f8',
}

const lightEmerald: StatusScale = {
  50: '#ecfdf5',
  400: '#34d399',
  500: '#10b981',
  600: '#059669',
  700: '#047857',
}
const lightAmber: StatusScale = {
  50: '#fffbeb',
  400: '#fbbf24',
  500: '#f59e0b',
  600: '#d97706',
  700: '#b45309',
}
const lightRed: StatusScale = {
  50: '#fef2f2',
  400: '#f87171',
  500: '#ef4444',
  600: '#dc2626',
  700: '#b91c1c',
}
const darkEmerald: StatusScale = {
  50: '#102a24',
  400: '#6ee7b7',
  500: '#34d399',
  600: '#6ee7b7',
  700: '#a7f3d0',
}
const darkAmber: StatusScale = {
  50: '#30240f',
  400: '#fcd34d',
  500: '#fbbf24',
  600: '#fcd34d',
  700: '#fde68a',
}
const darkRed: StatusScale = {
  50: '#351719',
  400: '#fca5a5',
  500: '#f87171',
  600: '#fca5a5',
  700: '#fecaca',
}

const softRadii: ThemeRadii = {
  sm: '0.375rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
}
const compactRadii: ThemeRadii = {
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
}
const organicRadii: ThemeRadii = {
  sm: '0.5rem',
  md: '0.625rem',
  lg: '1rem',
  xl: '1.5rem',
}
const industrialRadii: ThemeRadii = {
  sm: '0.125rem',
  md: '0.25rem',
  lg: '0.375rem',
  xl: '0.5rem',
}
const neoRadii: ThemeRadii = {
  sm: '0.0625rem',
  md: '0.125rem',
  lg: '0.125rem',
  xl: '0.25rem',
}

const warmShadows: ThemeShadows = {
  xs: '0 1px 2px 0 rgb(28 25 23 / 0.03)',
  sm: '0 1px 3px 0 rgb(28 25 23 / 0.04), 0 1px 2px -1px rgb(28 25 23 / 0.03)',
  md: '0 4px 6px -1px rgb(28 25 23 / 0.05), 0 2px 4px -2px rgb(28 25 23 / 0.03)',
  lg: '0 10px 15px -3px rgb(28 25 23 / 0.06), 0 4px 6px -4px rgb(28 25 23 / 0.03)',
  xl: '0 20px 25px -5px rgb(28 25 23 / 0.08), 0 8px 10px -6px rgb(28 25 23 / 0.05)',
}
const darkShadows: ThemeShadows = {
  xs: '0 1px 2px rgb(0 0 0 / 0.2)',
  sm: '0 2px 5px rgb(0 0 0 / 0.24)',
  md: '0 8px 18px -8px rgb(0 0 0 / 0.5)',
  lg: '0 16px 32px -12px rgb(0 0 0 / 0.58)',
  xl: '0 24px 50px -16px rgb(0 0 0 / 0.68)',
}
const midnightShadows: ThemeShadows = {
  xs: '0 1px 2px rgb(2 8 23 / 0.34)',
  sm: '0 4px 12px -5px rgb(30 116 160 / 0.4)',
  md: '0 10px 28px -12px rgb(31 145 194 / 0.52)',
  lg: '0 20px 42px -18px rgb(24 120 168 / 0.62)',
  xl: '0 30px 64px -22px rgb(18 96 143 / 0.72)',
}
const forestShadows: ThemeShadows = {
  xs: '0 1px 2px rgb(2 10 4 / 0.28)',
  sm: '0 3px 8px rgb(2 12 5 / 0.32)',
  md: '0 12px 24px -10px rgb(1 12 4 / 0.64)',
  lg: '0 22px 44px -16px rgb(1 10 3 / 0.72)',
  xl: '0 34px 70px -24px rgb(0 8 2 / 0.8)',
}
const graphiteShadows: ThemeShadows = {
  xs: '0 1px 0 rgb(255 255 255 / 0.035), 0 2px 0 rgb(0 0 0 / 0.48)',
  sm: '0 1px 0 rgb(255 255 255 / 0.04), 0 5px 0 -2px rgb(0 0 0 / 0.58)',
  md: '0 1px 0 rgb(255 255 255 / 0.045), 0 10px 0 -5px rgb(0 0 0 / 0.7)',
  lg: '0 1px 0 rgb(255 255 255 / 0.05), 0 16px 0 -7px rgb(0 0 0 / 0.76)',
  xl: '0 1px 0 rgb(255 255 255 / 0.055), 0 24px 0 -10px rgb(0 0 0 / 0.84)',
}
const neoShadows: ThemeShadows = {
  xs: '1px 1px 0 #171717',
  sm: '2px 2px 0 #171717',
  md: '3px 3px 0 #171717',
  lg: '5px 5px 0 #171717',
  xl: '8px 8px 0 #171717',
}

export const themeRegistry = [
  {
    id: 'wave-light',
    appearance: 'light',
    labelKey: 'appearance.themes.waveLight.name',
    descriptionKey: 'appearance.themes.waveLight.description',
    tokens: {
      neutral: waveLightNeutral,
      emerald: lightEmerald,
      amber: lightAmber,
      red: lightRed,
      background: '#faf9f7',
      foreground: '#1c1917',
      card: '#ffffff',
      cardForeground: '#1c1917',
      muted: '#f3f1ed',
      mutedForeground: '#78716c',
      border: '#e8e5df',
      input: '#e8e5df',
      ring: '#818cf8',
      primary: '#6264ee',
      primaryHover: '#4f46e5',
      primaryActive: '#4338ca',
      primaryForeground: '#ffffff',
      primarySubtle: '#eef2ff',
      interactiveForeground: '#4338ca',
      secondary: '#f3f1ed',
      secondaryForeground: '#44403c',
      accent: '#f3f1ed',
      accentForeground: '#44403c',
      surfaceHover: 'color-mix(in srgb, #6264ee 5%, transparent)',
      surfaceSelected: 'color-mix(in srgb, #6264ee 10%, transparent)',
      destructive: '#b91c1c',
      destructiveForeground: '#ffffff',
      destructiveSubtle: '#fef2f2',
      success: '#047857',
      successForeground: '#ffffff',
      successSubtle: '#ecfdf5',
      warning: '#b45309',
      warningForeground: '#ffffff',
      warningSubtle: '#fffbeb',
      brandPanel: '#eeeaf7',
      brandPanelForeground: '#1c1917',
      brandPanelMutedForeground: '#57534e',
      brandMarkSurface: '#ffffff',
      sidebar: '#ffffff',
      sidebarForeground: '#57534e',
      sidebarForegroundHover: '#292524',
      sidebarBorder: '#f3f1ed',
      sidebarMuted: '#faf9f7',
      sidebarActiveBackground: '#eef2ff',
      sidebarActiveForeground: '#4338ca',
      sidebarActiveBorder: '#c7d2fe',
      codeBackground: '#f3f1ed',
      codeForeground: '#292524',
      codeBorder: '#e8e5df',
      // Selection must read as a band at a glance. The previous #dfe4ff sat at
      // 1.12:1 against codeBackground — a tint too faint to show where a
      // selection starts and ends, so dragging over a long prompt looked like
      // nothing had been selected. This is 1.72:1, matching the dark themes,
      // and still leaves codeForeground at 7.8:1 on top.
      codeSelection: '#a8b8f5',
      codeVariable: '#4f46e5',
      scrollbar: '#d4d0c8',
      scrollbarHover: '#a8a29e',
      gradientAccent: '#7c3aed',
      overlay: 'rgb(15 12 10 / 0.24)',
    },
    radii: softRadii,
    shadows: warmShadows,
    antd: { borderRadius: 8 },
  },
  {
    id: 'wave-dark',
    appearance: 'dark',
    labelKey: 'appearance.themes.waveDark.name',
    descriptionKey: 'appearance.themes.waveDark.description',
    tokens: {
      neutral: darkNeutral,
      emerald: darkEmerald,
      amber: darkAmber,
      red: darkRed,
      background: '#0f1115',
      foreground: '#f4f4f5',
      card: '#171a21',
      cardForeground: '#f4f4f5',
      muted: '#222630',
      mutedForeground: '#a1a8b3',
      border: '#303641',
      input: '#3a414d',
      ring: '#a5b4fc',
      primary: '#818cf8',
      primaryHover: '#a5b4fc',
      primaryActive: '#6366f1',
      primaryForeground: '#101116',
      primarySubtle: '#252b4a',
      interactiveForeground: '#a5b4fc',
      secondary: '#252a34',
      secondaryForeground: '#e4e4e7',
      accent: '#292e3a',
      accentForeground: '#f4f4f5',
      surfaceHover: 'color-mix(in srgb, #818cf8 9%, transparent)',
      surfaceSelected: 'color-mix(in srgb, #818cf8 16%, transparent)',
      destructive: '#fb7185',
      destructiveForeground: '#27070e',
      destructiveSubtle: '#3b181f',
      success: '#4ade80',
      successForeground: '#06200e',
      successSubtle: '#15291c',
      warning: '#fbbf24',
      warningForeground: '#241801',
      warningSubtle: '#33260d',
      brandPanel: '#121622',
      brandPanelForeground: '#f4f4f5',
      brandPanelMutedForeground: '#b7bdc8',
      brandMarkSurface: '#ffffff',
      sidebar: '#12141a',
      sidebarForeground: '#b7bdc8',
      sidebarForegroundHover: '#ffffff',
      sidebarBorder: '#262b35',
      sidebarMuted: '#1b1e26',
      sidebarActiveBackground: '#252b4a',
      sidebarActiveForeground: '#c7d2fe',
      sidebarActiveBorder: '#4f5b91',
      codeBackground: '#11141a',
      codeForeground: '#e7e9ee',
      codeBorder: '#343a46',
      // Was #333b69 (1.73:1) — the faintest of the dark themes. Lifted into
      // line with midnight/forest at 2.0:1.
      codeSelection: '#3a4478',
      codeVariable: '#a5b4fc',
      scrollbar: '#3a414d',
      scrollbarHover: '#596272',
      gradientAccent: '#c4b5fd',
      overlay: 'rgb(0 0 0 / 0.58)',
    },
    radii: softRadii,
    shadows: darkShadows,
    antd: { borderRadius: 8 },
  },
  {
    id: 'neo-yellow',
    appearance: 'light',
    labelKey: 'appearance.themes.neoYellow.name',
    descriptionKey: 'appearance.themes.neoYellow.description',
    tokens: {
      neutral: {
        50: '#fffdf5',
        100: '#f4f1e8',
        200: '#dfdbcf',
        300: '#c6c0b3',
        400: '#969083',
        500: '#69645a',
        600: '#4d4942',
        700: '#38352f',
        800: '#24231f',
        900: '#151515',
      },
      emerald: lightEmerald,
      amber: lightAmber,
      red: lightRed,
      background: '#f4f1e8',
      foreground: '#151515',
      card: '#fffdf5',
      cardForeground: '#151515',
      muted: '#ebe7da',
      mutedForeground: '#4d4942',
      border: '#171717',
      input: '#171717',
      ring: '#171717',
      primary: '#ddf52f',
      primaryHover: '#cde71e',
      primaryActive: '#bdd70f',
      primaryForeground: '#121212',
      primarySubtle: '#f2ff9a',
      interactiveForeground: '#3d430c',
      secondary: '#171717',
      secondaryForeground: '#fffdf5',
      accent: '#b9a7ff',
      accentForeground: '#171717',
      surfaceHover: 'color-mix(in srgb, #ddf52f 28%, transparent)',
      surfaceSelected: 'color-mix(in srgb, #ddf52f 50%, transparent)',
      destructive: '#b91c1c',
      destructiveForeground: '#ffffff',
      destructiveSubtle: '#ffe2dc',
      success: '#0f6d41',
      successForeground: '#ffffff',
      successSubtle: '#dff7e9',
      warning: '#92400e',
      warningForeground: '#ffffff',
      warningSubtle: '#fff0bd',
      brandPanel: '#eee9dc',
      brandPanelForeground: '#151515',
      brandPanelMutedForeground: '#4d4942',
      brandMarkSurface: '#ffffff',
      sidebar: '#eee9dc',
      sidebarForeground: '#4d4942',
      sidebarForegroundHover: '#151515',
      sidebarBorder: '#171717',
      sidebarMuted: '#e2ddcf',
      sidebarActiveBackground: '#ddf52f',
      sidebarActiveForeground: '#151515',
      sidebarActiveBorder: '#171717',
      codeBackground: '#171717',
      codeForeground: '#f7f3e8',
      codeBorder: '#171717',
      codeSelection: '#536323',
      codeVariable: '#151515',
      scrollbar: '#69645a',
      scrollbarHover: '#171717',
      gradientAccent: '#8d6cff',
      overlay: 'rgb(23 23 23 / 0.28)',
    },
    radii: neoRadii,
    shadows: neoShadows,
    antd: { borderRadius: 2 },
  },
  {
    id: 'midnight',
    appearance: 'dark',
    labelKey: 'appearance.themes.midnight.name',
    descriptionKey: 'appearance.themes.midnight.description',
    tokens: {
      neutral: darkNeutral,
      emerald: darkEmerald,
      amber: darkAmber,
      red: darkRed,
      background: '#080d18',
      foreground: '#eaf2ff',
      card: '#0f1828',
      cardForeground: '#eaf2ff',
      muted: '#172338',
      mutedForeground: '#94a7c2',
      border: '#273854',
      input: '#334867',
      ring: '#67d9ff',
      primary: '#55d6ff',
      primaryHover: '#83e3ff',
      primaryActive: '#2abce9',
      primaryForeground: '#06111a',
      primarySubtle: '#12344a',
      interactiveForeground: '#67d9ff',
      secondary: '#1a2941',
      secondaryForeground: '#dce9fb',
      accent: '#26395a',
      accentForeground: '#f2f7ff',
      surfaceHover: 'color-mix(in srgb, #55d6ff 10%, transparent)',
      surfaceSelected: 'color-mix(in srgb, #55d6ff 18%, transparent)',
      destructive: '#fb7185',
      destructiveForeground: '#27070e',
      destructiveSubtle: '#3b181f',
      success: '#4ade80',
      successForeground: '#06200e',
      successSubtle: '#15291c',
      warning: '#fbbf24',
      warningForeground: '#241801',
      warningSubtle: '#33260d',
      brandPanel: '#081426',
      brandPanelForeground: '#eaf2ff',
      brandPanelMutedForeground: '#9fb1ca',
      brandMarkSurface: '#ffffff',
      sidebar: '#0a1220',
      sidebarForeground: '#9fb1ca',
      sidebarForegroundHover: '#f4f8ff',
      sidebarBorder: '#1d2b42',
      sidebarMuted: '#101b2c',
      sidebarActiveBackground: '#12344a',
      sidebarActiveForeground: '#bdefff',
      sidebarActiveBorder: '#2abce9',
      codeBackground: '#070b13',
      codeForeground: '#dce9fb',
      codeBorder: '#29405f',
      codeSelection: '#174866',
      codeVariable: '#67d9ff',
      scrollbar: '#314867',
      scrollbarHover: '#4b678d',
      gradientAccent: '#8b9cff',
      overlay: 'rgb(0 0 0 / 0.62)',
    },
    radii: compactRadii,
    shadows: midnightShadows,
    antd: { borderRadius: 6 },
  },
  {
    id: 'forest',
    appearance: 'dark',
    labelKey: 'appearance.themes.forest.name',
    descriptionKey: 'appearance.themes.forest.description',
    tokens: {
      neutral: darkNeutral,
      emerald: darkEmerald,
      amber: darkAmber,
      red: darkRed,
      background: '#0e140f',
      foreground: '#edf4e8',
      card: '#161e17',
      cardForeground: '#edf4e8',
      muted: '#202a21',
      mutedForeground: '#9eae9c',
      border: '#344136',
      input: '#405043',
      ring: '#bef264',
      primary: '#a3e635',
      primaryHover: '#bef264',
      primaryActive: '#84cc16',
      primaryForeground: '#102006',
      primarySubtle: '#26391a',
      interactiveForeground: '#bef264',
      secondary: '#263128',
      secondaryForeground: '#e7efe2',
      accent: '#304033',
      accentForeground: '#f2f7ef',
      surfaceHover: 'color-mix(in srgb, #a3e635 9%, transparent)',
      surfaceSelected: 'color-mix(in srgb, #a3e635 17%, transparent)',
      destructive: '#fb7185',
      destructiveForeground: '#27070e',
      destructiveSubtle: '#3b181f',
      success: '#4ade80',
      successForeground: '#06200e',
      successSubtle: '#15291c',
      warning: '#fbbf24',
      warningForeground: '#241801',
      warningSubtle: '#33260d',
      brandPanel: '#0b150d',
      brandPanelForeground: '#edf4e8',
      brandPanelMutedForeground: '#acbba9',
      brandMarkSurface: '#ffffff',
      sidebar: '#0b110c',
      sidebarForeground: '#acbba9',
      sidebarForegroundHover: '#f4f9f1',
      sidebarBorder: '#29342b',
      sidebarMuted: '#151c16',
      sidebarActiveBackground: '#26391a',
      sidebarActiveForeground: '#d9f99d',
      sidebarActiveBorder: '#6e9f35',
      codeBackground: '#0a0f0b',
      codeForeground: '#e3ebdf',
      codeBorder: '#344637',
      codeSelection: '#354b26',
      codeVariable: '#bef264',
      scrollbar: '#3a4a3d',
      scrollbarHover: '#5d705f',
      gradientAccent: '#67e8a5',
      overlay: 'rgb(0 0 0 / 0.6)',
    },
    radii: organicRadii,
    shadows: forestShadows,
    antd: { borderRadius: 10 },
  },
  {
    id: 'graphite',
    appearance: 'dark',
    labelKey: 'appearance.themes.graphite.name',
    descriptionKey: 'appearance.themes.graphite.description',
    tokens: {
      neutral: darkNeutral,
      emerald: darkEmerald,
      amber: darkAmber,
      red: darkRed,
      background: '#111111',
      foreground: '#f1f0ed',
      card: '#1a1a1a',
      cardForeground: '#f1f0ed',
      muted: '#252525',
      mutedForeground: '#aaa7a2',
      border: '#383838',
      input: '#444444',
      ring: '#ffda7c',
      primary: '#f4c95d',
      primaryHover: '#ffda7c',
      primaryActive: '#dcae3d',
      primaryForeground: '#1b1304',
      primarySubtle: '#392f19',
      interactiveForeground: '#ffda7c',
      secondary: '#2b2b2b',
      secondaryForeground: '#eceae6',
      accent: '#333333',
      accentForeground: '#ffffff',
      surfaceHover: 'color-mix(in srgb, #f4c95d 9%, transparent)',
      surfaceSelected: 'color-mix(in srgb, #f4c95d 17%, transparent)',
      destructive: '#fb7185',
      destructiveForeground: '#27070e',
      destructiveSubtle: '#3b181f',
      success: '#4ade80',
      successForeground: '#06200e',
      successSubtle: '#15291c',
      warning: '#fbbf24',
      warningForeground: '#241801',
      warningSubtle: '#33260d',
      brandPanel: '#161616',
      brandPanelForeground: '#f1f0ed',
      brandPanelMutedForeground: '#b6b3ae',
      brandMarkSurface: '#ffffff',
      sidebar: '#151515',
      sidebarForeground: '#b6b3ae',
      sidebarForegroundHover: '#ffffff',
      sidebarBorder: '#303030',
      sidebarMuted: '#1e1e1e',
      sidebarActiveBackground: '#392f19',
      sidebarActiveForeground: '#ffe6a3',
      sidebarActiveBorder: '#8d7138',
      codeBackground: '#0d0d0d',
      codeForeground: '#e8e6e2',
      codeBorder: '#3d3d3d',
      codeSelection: '#57461f',
      codeVariable: '#ffda7c',
      scrollbar: '#424242',
      scrollbarHover: '#626262',
      gradientAccent: '#ff8a4c',
      overlay: 'rgb(0 0 0 / 0.64)',
    },
    radii: industrialRadii,
    shadows: graphiteShadows,
    antd: { borderRadius: 4 },
  },
] as const satisfies readonly ThemeDefinition[]

const themeById = new Map<ThemeId, ThemeDefinition>(themeRegistry.map((theme) => [theme.id, theme]))

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && themeById.has(value as ThemeId)
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === DEFAULT_THEME_PREFERENCE || isThemeId(value)
}

export function getTheme(id: ThemeId): ThemeDefinition {
  const theme = themeById.get(id)
  if (!theme) throw new Error(`Unknown theme: ${id}`)
  return theme
}

export function resolveThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
): ThemeDefinition {
  if (preference === DEFAULT_THEME_PREFERENCE) {
    return getTheme(prefersDark ? 'wave-dark' : 'wave-light')
  }
  return getTheme(preference)
}

export function getStoredThemePreference(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE
  } catch {
    return DEFAULT_THEME_PREFERENCE
  }
}

export function persistThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, 'setItem'>,
) {
  try {
    storage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // A blocked storage backend must not prevent changing the in-memory theme.
  }
}

const tokenVariableNames: Record<
  Exclude<keyof ThemeTokens, 'neutral' | 'emerald' | 'amber' | 'red'>,
  string
> = {
  background: '--color-background',
  foreground: '--color-foreground',
  card: '--color-card',
  cardForeground: '--color-card-foreground',
  muted: '--color-muted',
  mutedForeground: '--color-muted-foreground',
  border: '--color-border',
  input: '--color-input',
  ring: '--color-ring',
  primary: '--color-primary',
  primaryHover: '--color-primary-hover',
  primaryActive: '--color-primary-active',
  primaryForeground: '--color-primary-foreground',
  primarySubtle: '--color-primary-subtle',
  interactiveForeground: '--color-interactive-foreground',
  secondary: '--color-secondary',
  secondaryForeground: '--color-secondary-foreground',
  accent: '--color-accent',
  accentForeground: '--color-accent-foreground',
  surfaceHover: '--color-surface-hover',
  surfaceSelected: '--color-surface-selected',
  destructive: '--color-destructive',
  destructiveForeground: '--color-destructive-foreground',
  destructiveSubtle: '--color-destructive-subtle',
  success: '--color-success',
  successForeground: '--color-success-foreground',
  successSubtle: '--color-success-subtle',
  warning: '--color-warning',
  warningForeground: '--color-warning-foreground',
  warningSubtle: '--color-warning-subtle',
  brandPanel: '--color-brand-panel',
  brandPanelForeground: '--color-brand-panel-foreground',
  brandPanelMutedForeground: '--color-brand-panel-muted-foreground',
  brandMarkSurface: '--color-brand-mark-surface',
  sidebar: '--color-sidebar',
  sidebarForeground: '--color-sidebar-foreground',
  sidebarForegroundHover: '--color-sidebar-foreground-hover',
  sidebarBorder: '--color-sidebar-border',
  sidebarMuted: '--color-sidebar-muted',
  sidebarActiveBackground: '--color-sidebar-active-background',
  sidebarActiveForeground: '--color-sidebar-active-foreground',
  sidebarActiveBorder: '--color-sidebar-active-border',
  codeBackground: '--color-code-background',
  codeForeground: '--color-code-foreground',
  codeBorder: '--color-code-border',
  codeSelection: '--color-code-selection',
  codeVariable: '--color-code-variable',
  scrollbar: '--color-scrollbar',
  scrollbarHover: '--color-scrollbar-hover',
  gradientAccent: '--color-gradient-accent',
  overlay: '--color-overlay',
}

export function themeToCssVariables(theme: ThemeDefinition): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [token, variable] of Object.entries(tokenVariableNames)) {
    variables[variable] = theme.tokens[token as keyof typeof tokenVariableNames]
  }
  for (const [shade, color] of Object.entries(theme.tokens.neutral)) {
    variables[`--color-warm-${shade}`] = color
  }
  for (const scaleName of ['emerald', 'amber', 'red'] as const) {
    for (const [shade, color] of Object.entries(theme.tokens[scaleName])) {
      variables[`--color-${scaleName}-${shade}`] = color
    }
  }
  for (const [size, radius] of Object.entries(theme.radii)) {
    variables[`--radius-${size}`] = radius
  }
  for (const [size, shadow] of Object.entries(theme.shadows)) {
    variables[`--shadow-${size}`] = shadow
  }
  return variables
}

interface ApplyThemeOptions {
  root?: HTMLElement
  prefersDark?: boolean
}

export function applyTheme(
  preference: ThemePreference,
  options: ApplyThemeOptions = {},
): ThemeDefinition {
  const root = options.root ?? document.documentElement
  const prefersDark =
    options.prefersDark ?? window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  const resolved = resolveThemePreference(preference, prefersDark)

  root.dataset.themePreference = preference
  root.dataset.theme = resolved.id
  root.dataset.appearance = resolved.appearance
  root.classList.toggle('dark', resolved.appearance === 'dark')
  root.style.colorScheme = resolved.appearance
  for (const [variable, value] of Object.entries(themeToCssVariables(resolved))) {
    root.style.setProperty(variable, value)
  }

  return resolved
}
