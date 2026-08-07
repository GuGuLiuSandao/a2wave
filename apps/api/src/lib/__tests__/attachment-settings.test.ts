import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@a2wave/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2wave/shared')>()
  return {
    ...actual,
    SETTINGS_DEFAULTS: {
      attachments: {
        stagingPath: './data/attachments',
        stagingTtlHours: '24',
        maxFileSizeBytes: '10485760',
        maxFilesPerRequest: '10',
        allowedExtensions: 'png,jpg,pdf',
      },
    },
  }
})

// Settings are served from a synchronous in-memory snapshot rather than a live
// query, so each case seeds its rows through the cache instead of a db mock.
import { invalidateSettingsCache, primeSettingsCache } from '../settings-cache.js'
import { getAttachmentSettings } from '../settings.js'

// Settings reads go through an in-memory cache; without a reset the first case's
// rows would answer every later assertion regardless of what it primed.
beforeEach(() => {
  invalidateSettingsCache()
})

describe('getAttachmentSettings', () => {
  it('returns parsed defaults when DB empty', () => {
    primeSettingsCache([])
    const s = getAttachmentSettings()
    expect(s.stagingPath).toBe('./data/attachments')
    expect(s.stagingTtlHours).toBe(24)
    expect(s.maxFileSizeBytes).toBe(10485760)
    expect(s.maxFilesPerRequest).toBe(10)
    expect(s.allowedExtensions).toEqual(new Set(['png', 'jpg', 'pdf']))
  })

  it('overrides from DB and parses CSV extensions', () => {
    primeSettingsCache([
      { category: 'attachments', key: 'stagingTtlHours', value: '72' },
      { category: 'attachments', key: 'maxFileSizeBytes', value: '5242880' },
      { category: 'attachments', key: 'allowedExtensions', value: '.PNG, .GIF ,docx' },
    ])
    const s = getAttachmentSettings()
    expect(s.stagingTtlHours).toBe(72)
    expect(s.maxFileSizeBytes).toBe(5242880)
    // trimmed, dot-stripped, lowercased
    expect(s.allowedExtensions).toEqual(new Set(['png', 'gif', 'docx']))
  })

  it('falls back to defaults on garbage numeric values', () => {
    primeSettingsCache([
      { category: 'attachments', key: 'stagingTtlHours', value: 'abc' },
      { category: 'attachments', key: 'maxFileSizeBytes', value: '-5' },
    ])
    const s = getAttachmentSettings()
    expect(s.stagingTtlHours).toBe(24)
    expect(s.maxFileSizeBytes).toBe(10485760)
  })

  it('falls back to default extensions when the stored value parses to empty (fail-closed guard)', () => {
    // 管理员误存空白/纯逗号：非 null 故 `??` 不触发，但解析后为空——必须回退默认扩展名，
    // 否则空白名单会 fail-closed 拒绝一切上传/materialize，全平台附件瘫痪（review [P1]）。
    for (const bad of [' ', ',,', ' , , ', '.', '  .  ']) {
      primeSettingsCache([{ category: 'attachments', key: 'allowedExtensions', value: bad }])
      const s = getAttachmentSettings()
      expect(s.allowedExtensions).toEqual(new Set(['png', 'jpg', 'pdf']))
    }
  })

  it('still honors a valid non-empty extension override (does not spuriously fall back)', () => {
    primeSettingsCache([{ category: 'attachments', key: 'allowedExtensions', value: 'webp' }])
    const s = getAttachmentSettings()
    expect(s.allowedExtensions).toEqual(new Set(['webp']))
  })
})
