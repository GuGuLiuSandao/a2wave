import { describe, expect, it } from 'vitest'
import { applyTemplatePreset } from '../template-preset'

const template = { name: 'tpl', providerName: 'Claude Code' }

describe('applyTemplatePreset', () => {
  it('returns the template untouched when no preset is configured', () => {
    expect(applyTemplatePreset(template, undefined)).toEqual(template)
    expect(applyTemplatePreset(template, {})).toEqual(template)
    expect(applyTemplatePreset(template, { providerBaseUrl: '', providerModel: '  ' })).toEqual(
      template,
    )
  })

  it('prefills baseUrl and model from configured settings', () => {
    expect(
      applyTemplatePreset(template, {
        providerBaseUrl: 'https://llm-gateway.example.com',
        providerModel: 'my-model',
      }),
    ).toEqual({ ...template, baseUrl: 'https://llm-gateway.example.com', model: 'my-model' })
  })

  it('applies partial presets independently and trims whitespace', () => {
    expect(applyTemplatePreset(template, { providerModel: ' my-model ' })).toEqual({
      ...template,
      model: 'my-model',
    })
    expect(applyTemplatePreset(template, { providerBaseUrl: 'https://g.example.com' })).toEqual({
      ...template,
      baseUrl: 'https://g.example.com',
    })
  })
})
