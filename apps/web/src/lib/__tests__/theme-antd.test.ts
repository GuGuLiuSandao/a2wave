import { describe, expect, it } from 'vitest'
import { getTheme } from '../themes'
import { createAntdTheme } from '../tokens'

function contrastRatio(first: string, second: string) {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)
      ?.map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${hex}`)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }

  const firstLuminance = luminance(first)
  const secondLuminance = luminance(second)
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  )
}

describe('createAntdTheme', () => {
  it('maps the active theme semantic tokens into Ant Design', () => {
    const theme = getTheme('forest')
    const config = createAntdTheme(theme)

    expect(config.token?.colorPrimary).toBe(theme.tokens.primary)
    expect(config.token?.colorLink).toBe(theme.tokens.interactiveForeground)
    expect(config.token?.colorBgContainer).toBe(theme.tokens.card)
    expect(config.token?.colorBgLayout).toBe(theme.tokens.background)
    expect(config.token?.colorText).toBe(theme.tokens.foreground)
    expect(config.token?.colorBorder).toBe(theme.tokens.border)
    expect(config.token?.borderRadius).toBe(theme.antd.borderRadius)
    expect(config.components?.Table?.rowHoverBg).toContain(theme.tokens.primary)
  })

  it('uses a dark algorithm for dark themes', () => {
    const lightConfig = createAntdTheme(getTheme('wave-light'))
    const darkConfig = createAntdTheme(getTheme('wave-dark'))

    expect(lightConfig.algorithm).toBeUndefined()
    expect(darkConfig.algorithm).toBeDefined()
    expect(darkConfig.cssVar).toEqual({ key: 'wave-dark' })
  })

  it('keeps form-control focus boundaries visible when the brand fill is bright', () => {
    const theme = getTheme('neo-yellow')
    const config = createAntdTheme(theme)

    for (const component of [
      config.components?.Input,
      config.components?.InputNumber,
      config.components?.Select,
      config.components?.DatePicker,
    ]) {
      expect(component?.activeBorderColor).toBe(theme.tokens.ring)
      expect(component?.hoverBorderColor).toBe(theme.tokens.ring)
    }
    expect(config.components?.Input?.activeShadow).toContain(theme.tokens.ring)
    expect(contrastRatio(theme.tokens.card, theme.tokens.ring)).toBeGreaterThanOrEqual(3)
  })
})
