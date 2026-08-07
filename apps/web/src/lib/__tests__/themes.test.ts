/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  applyTheme,
  getStoredThemePreference,
  resolveThemePreference,
  themeRegistry,
  themeToCssVariables,
} from '../themes'

const globalsCss = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8')
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

function extractCssBlock(source: string, marker: string) {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Missing CSS block: ${marker}`)
  const openIndex = source.indexOf('{', markerIndex)
  let depth = 0
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(openIndex + 1, index)
  }
  throw new Error(`Unclosed CSS block: ${marker}`)
}

function parseCssVariables(block: string) {
  const variables = new Map<string, string>()
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of withoutComments.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    variables.set(match[1], match[2].replace(/\s+/g, ' ').trim())
  }
  return variables
}

function mergeCssVariables(target: Map<string, string>, block: string) {
  for (const [variable, value] of parseCssVariables(block)) target.set(variable, value)
}

function resolveCssValue(value: string, variables: Map<string, string>) {
  let resolved = value
  for (let depth = 0; depth < 10; depth += 1) {
    const next = resolved.replace(/var\((--[\w-]+)\)/g, (_, variable: string) => {
      return variables.get(variable) ?? `var(${variable})`
    })
    if (next === resolved) return resolved
    resolved = next
  }
  return resolved
}

function extractStringArray(source: string, variable: string) {
  const match = source.match(new RegExp(`const ${variable} = \\[([^\\]]*)\\]`, 's'))
  if (!match) throw new Error(`Missing first-paint list: ${variable}`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
}

function createRoot() {
  const root = document.createElement('html')
  return root
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(first: string, second: string) {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  )
}

describe('theme registry', () => {
  it('ships six visually complete themes with explicit appearances', () => {
    expect(themeRegistry.map((theme) => theme.id)).toEqual([
      'wave-light',
      'wave-dark',
      'neo-yellow',
      'midnight',
      'forest',
      'graphite',
    ])
    expect(themeRegistry.filter((theme) => theme.appearance === 'light')).not.toHaveLength(0)
    expect(themeRegistry.filter((theme) => theme.appearance === 'dark')).not.toHaveLength(0)

    for (const theme of themeRegistry) {
      expect(theme.tokens.background).toMatch(/^#/)
      expect(theme.tokens.card).toMatch(/^#/)
      expect(theme.tokens.foreground).toMatch(/^#/)
      expect(theme.tokens.primary).toMatch(/^#/)
      expect(theme.tokens.codeBackground).toMatch(/^#/)
      expect(theme.tokens.scrollbar).toMatch(/^#/)
      expect(theme.radii.lg).toMatch(/rem$/)
      expect(theme.shadows.md).toBeTruthy()
    }
  })

  it('keeps body, muted, button, and status text at WCAG AA contrast', () => {
    for (const theme of themeRegistry) {
      const pairs = [
        [theme.tokens.background, theme.tokens.foreground],
        [theme.tokens.background, theme.tokens.mutedForeground],
        [theme.tokens.card, theme.tokens.mutedForeground],
        [theme.tokens.primary, theme.tokens.primaryForeground],
        [theme.tokens.primaryHover, theme.tokens.primaryForeground],
        [theme.tokens.gradientAccent, theme.tokens.primaryForeground],
        [theme.tokens.destructive, theme.tokens.destructiveForeground],
        [theme.tokens.success, theme.tokens.successForeground],
        [theme.tokens.warning, theme.tokens.warningForeground],
        [theme.tokens.successSubtle, theme.tokens.success],
        [theme.tokens.warningSubtle, theme.tokens.warning],
        [theme.tokens.destructiveSubtle, theme.tokens.destructive],
      ] as const
      for (const [background, foreground] of pairs) {
        expect(
          contrastRatio(background, foreground),
          `${theme.id}: ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps every sidebar active state at WCAG AA contrast', () => {
    for (const theme of themeRegistry) {
      expect(
        contrastRatio(theme.tokens.sidebarActiveBackground, theme.tokens.sidebarActiveForeground),
        `${theme.id}: active sidebar foreground on active background`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(theme.tokens.sidebar, theme.tokens.sidebarForeground),
        `${theme.id}: inactive sidebar foreground on sidebar`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(theme.tokens.sidebarActiveBorder).toMatch(/^#/)
    }
  })

  it('keeps defined PromptEditor variables at normal-text WCAG AA contrast', () => {
    for (const theme of themeRegistry) {
      expect(
        contrastRatio(theme.tokens.primarySubtle, theme.tokens.codeVariable),
        `${theme.id}: PromptEditor variable ${theme.tokens.codeVariable} on ${theme.tokens.primarySubtle}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps a code selection visible as a band and readable as text', () => {
    /**
     * Two separate failures, both of which shipped:
     *
     * 1. Wave Light's selection sat at 1.12:1 against the code background — a
     *    tint so faint you could not see where a selection began or ended.
     * 2. The global `::selection` rule pairs its background with *white* text,
     *    so overriding only the background left white on a pale tint at
     *    1.26:1. The editor now pins `codeForeground` alongside it.
     *
     * The band threshold is deliberately modest: a selection is a surface
     * change, not text, so WCAG AA does not apply — but below ~1.5:1 it stops
     * registering as a change at all.
     */
    for (const theme of themeRegistry) {
      expect(
        contrastRatio(theme.tokens.codeSelection, theme.tokens.codeBackground),
        `${theme.id}: selection ${theme.tokens.codeSelection} is indistinguishable from code background ${theme.tokens.codeBackground}`,
      ).toBeGreaterThanOrEqual(1.5)

      expect(
        contrastRatio(theme.tokens.codeForeground, theme.tokens.codeSelection),
        `${theme.id}: code text ${theme.tokens.codeForeground} on selection ${theme.tokens.codeSelection}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps textual interactions readable on every content surface', () => {
    for (const theme of themeRegistry) {
      const interactiveForeground = (
        theme.tokens as typeof theme.tokens & { interactiveForeground?: string }
      ).interactiveForeground
      expect(interactiveForeground, `${theme.id}: interactive foreground token`).toMatch(/^#/)
      if (!interactiveForeground) continue

      for (const background of [
        theme.tokens.background,
        theme.tokens.card,
        theme.tokens.primarySubtle,
      ]) {
        expect(
          contrastRatio(background, interactiveForeground),
          `${theme.id}: interactive ${interactiveForeground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the public login brand panel readable in every theme', () => {
    for (const theme of themeRegistry) {
      const tokens = theme.tokens as typeof theme.tokens & {
        brandPanel?: string
        brandPanelForeground?: string
        brandPanelMutedForeground?: string
        brandMarkSurface?: string
      }

      expect(tokens.brandPanel, `${theme.id}: login brand panel surface`).toMatch(/^#/)
      expect(tokens.brandPanelForeground, `${theme.id}: login brand panel foreground`).toMatch(/^#/)
      expect(
        tokens.brandPanelMutedForeground,
        `${theme.id}: login brand panel muted foreground`,
      ).toMatch(/^#/)
      expect(tokens.brandMarkSurface, `${theme.id}: standardized brand mark surface`).toMatch(/^#/)
      if (!tokens.brandPanel || !tokens.brandPanelForeground || !tokens.brandPanelMutedForeground) {
        continue
      }

      expect(
        contrastRatio(tokens.brandPanel, tokens.brandPanelForeground),
        `${theme.id}: login brand title on panel`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(tokens.brandPanel, tokens.brandPanelMutedForeground),
        `${theme.id}: login brand copy on panel`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('gives dark themes distinct depth systems, not accent-only recolors', () => {
    const darkThemes = themeRegistry.filter((theme) => theme.appearance === 'dark')

    expect(new Set(darkThemes.map((theme) => theme.radii.md)).size).toBe(darkThemes.length)
    expect(new Set(darkThemes.map((theme) => theme.shadows.md)).size).toBe(darkThemes.length)
    expect(
      new Set(
        darkThemes.map((theme) =>
          [theme.tokens.background, theme.tokens.card, theme.tokens.border].join(':'),
        ),
      ).size,
    ).toBe(darkThemes.length)
  })

  it('keeps first-paint CSS and bootstrap theme lists synchronized with the registry', () => {
    const themeIds = themeRegistry.map((theme) => theme.id)
    const darkThemeIds = themeRegistry
      .filter((theme) => theme.appearance === 'dark')
      .map((theme) => theme.id)

    expect(extractStringArray(indexHtml, 'ids')).toEqual(themeIds)
    expect(extractStringArray(indexHtml, 'appearance')).toEqual(darkThemeIds)

    const baseVariables = parseCssVariables(extractCssBlock(globalsCss, '@theme {'))
    const darkVariables = extractCssBlock(globalsCss, 'html:is(')
    const darkAppearanceBlock = extractCssBlock(globalsCss, 'html[data-appearance="dark"]')

    for (const theme of themeRegistry) {
      const effectiveVariables = new Map(baseVariables)
      if (theme.appearance === 'dark') mergeCssVariables(effectiveVariables, darkVariables)
      if (theme.id !== 'wave-light') {
        mergeCssVariables(
          effectiveVariables,
          extractCssBlock(globalsCss, `html[data-theme="${theme.id}"]`),
        )
      }
      if (theme.appearance === 'dark') {
        mergeCssVariables(effectiveVariables, darkAppearanceBlock)
      }

      for (const [variable, expectedValue] of Object.entries(themeToCssVariables(theme))) {
        const cssValue = effectiveVariables.get(variable)
        expect(cssValue, `${theme.id}: ${variable}`).toBeDefined()
        expect(
          resolveCssValue(cssValue as string, effectiveVariables),
          `${theme.id}: ${variable}`,
        ).toBe(expectedValue)
      }
    }

    expect(darkAppearanceBlock).toMatch(/color-scheme:\s*dark\s*;/)
  })
})

describe('theme preference', () => {
  it('resolves System to the matching Wave theme', () => {
    expect(resolveThemePreference('system', false).id).toBe('wave-light')
    expect(resolveThemePreference('system', true).id).toBe('wave-dark')
    expect(resolveThemePreference('forest', false).id).toBe('forest')
  })

  it('rejects stale or unknown persisted values', () => {
    const storage = {
      getItem: vi.fn(() => 'unknown-theme'),
    } as unknown as Storage

    expect(getStoredThemePreference(storage)).toBe(DEFAULT_THEME_PREFERENCE)
    expect(storage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY)
  })

  it('applies semantic variables and stable data attributes to the root', () => {
    const root = createRoot()
    const resolved = applyTheme('neo-yellow', { root, prefersDark: true })

    expect(resolved.id).toBe('neo-yellow')
    expect(root.dataset.themePreference).toBe('neo-yellow')
    expect(root.dataset.theme).toBe('neo-yellow')
    expect(root.dataset.appearance).toBe('light')
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.getPropertyValue('--color-primary')).toBe(resolved.tokens.primary)
    expect(root.style.getPropertyValue('--color-code-background')).toBe(
      resolved.tokens.codeBackground,
    )
    expect(root.style.getPropertyValue('--color-sidebar-active-background')).toBe(
      resolved.tokens.sidebarActiveBackground,
    )
    expect(root.style.getPropertyValue('--color-brand-panel')).toBe(resolved.tokens.brandPanel)
    expect(root.style.getPropertyValue('--color-brand-panel-foreground')).toBe(
      resolved.tokens.brandPanelForeground,
    )
    expect(root.style.getPropertyValue('--radius-lg')).toBe(resolved.radii.lg)
    expect(root.style.getPropertyValue('--shadow-md')).toBe(resolved.shadows.md)
  })

  it('marks dark themes for Tailwind variants and native controls', () => {
    const root = createRoot()
    applyTheme('midnight', { root, prefersDark: false })

    expect(root.dataset.appearance).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
  })
})
