import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stagingRootHolder = { path: '' }
const homesRootHolder = { path: '' }

vi.mock('../settings.js', () => ({
  getAttachmentSettings: () => ({
    stagingPath: stagingRootHolder.path,
    stagingTtlHours: 24,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFilesPerRequest: 10,
    allowedExtensions: new Set(['png', 'pdf', 'txt']),
  }),
}))

// materializeForRun 登记反查表；这里 mock 掉，本套件只测落盘/提示逻辑（登记单测在 attachment-access）。
const recordedTokens: string[] = []
vi.mock('../attachment-access.js', () => ({
  recordAttachmentRefs: (_runId: string, tokens: string[] | undefined) => {
    if (tokens) recordedTokens.push(...tokens)
  },
}))

import {
  buildFileHint,
  buildImageHint,
  cleanupMaterializedRoot,
  materializeAttachments,
  materializeForRun,
  mergeAttachmentsIntoPrompt,
  refsToSources,
} from '../attachment-materializer.js'
import { stageAttachment } from '../attachment-storage.js'

beforeEach(() => {
  stagingRootHolder.path = mkdtempSync(join(tmpdir(), 'att-mat-stage-'))
  homesRootHolder.path = mkdtempSync(join(tmpdir(), 'att-mat-homes-'))
  process.env.A2WAVE_AGENT_HOMES_DIR = homesRootHolder.path
})

afterEach(() => {
  delete process.env.A2WAVE_AGENT_HOMES_DIR
  vi.restoreAllMocks()
})

// ── Golden parity: hint strings MUST match feishu-service.ts byte-for-byte ──────
describe('buildImageHint (feishu golden parity)', () => {
  it('single image → [图片]', async () => {
    expect(buildImageHint(['/tmp/a.jpg'])).toBe('[图片]\n图片路径：/tmp/a.jpg')
  })
  it('multiple images → [图片 N] joined by \\n\\n', async () => {
    expect(buildImageHint(['/tmp/a.jpg', '/tmp/b.jpg'])).toBe(
      '[图片 1]\n图片路径：/tmp/a.jpg\n\n[图片 2]\n图片路径：/tmp/b.jpg',
    )
  })
})

describe('buildFileHint (feishu golden parity)', () => {
  it('named file', async () => {
    expect(buildFileHint('report.pdf', '/tmp/report.pdf')).toBe(
      '[文件] report.pdf\n文件路径：/tmp/report.pdf',
    )
  })
  it('unnamed file → [文件]', async () => {
    expect(buildFileHint(undefined, '/tmp/x')).toBe('[文件]\n文件路径：/tmp/x')
  })
  it('basename-strips path in name', async () => {
    expect(buildFileHint('dir/report.pdf', '/tmp/report.pdf')).toBe(
      '[文件] report.pdf\n文件路径：/tmp/report.pdf',
    )
  })
})

describe('mergeAttachmentsIntoPrompt', () => {
  it('files then images, joined by \\n\\n---\\n', async () => {
    const merged = mergeAttachmentsIntoPrompt('hello', [
      { path: '/t/a.png', name: 'a.png', mimeType: 'image/png', isImage: true },
      { path: '/t/b.pdf', name: 'b.pdf', mimeType: 'application/pdf', isImage: false },
    ])
    expect(merged).toBe(
      'hello\n\n---\n[文件] b.pdf\n文件路径：/t/b.pdf\n\n---\n[图片]\n图片路径：/t/a.png',
    )
  })
  it('empty base text starts with the hint', async () => {
    const merged = mergeAttachmentsIntoPrompt('', [
      { path: '/t/a.png', name: 'a.png', mimeType: 'image/png', isImage: true },
    ])
    expect(merged).toBe('[图片]\n图片路径：/t/a.png')
  })
})

// ── Materialization from sources ────────────────────────────────────────────────
describe('materializeAttachments', () => {
  it('token source → copied under runtimeTmpDir/attachments/<runId>/<uuid>', async () => {
    const { token } = await stageAttachment(Buffer.from('img'), 'pic.png', 'image/png', 'usr_test')
    const { attachments, rootDir } = await materializeAttachments(
      [{ kind: 'token', token, name: 'pic.png', mimeType: 'image/png' }],
      {
        agentId: 'agt_1',
        runId: 'run_1',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['png', 'pdf', 'txt']),
      },
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0].isImage).toBe(true)
    expect(readFileSync(attachments[0].path, 'utf-8')).toBe('img')
    expect(rootDir).toContain(join('attachments', 'run_1'))
    await cleanupMaterializedRoot(rootDir)
  })

  it('bytes source → base64 decoded to disk', async () => {
    const { attachments } = await materializeAttachments(
      [
        {
          kind: 'bytes',
          bytes: Buffer.from('doc').toString('base64'),
          name: 'f.txt',
          mimeType: 'text/plain',
        },
      ],
      {
        agentId: 'agt_1',
        runId: 'run_2',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['png', 'pdf', 'txt']),
      },
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0].isImage).toBe(false)
    expect(readFileSync(attachments[0].path, 'utf-8')).toBe('doc')
  })

  it('over-limit inline bytes skipped', async () => {
    const big = Buffer.alloc(2048).toString('base64')
    const { attachments } = await materializeAttachments(
      [{ kind: 'bytes', bytes: big, name: 'big.txt', mimeType: 'text/plain' }],
      {
        agentId: 'agt_1',
        runId: 'run_3',
        consumerId: 'usr_test',
        maxBytes: 1024,
        maxCount: 10,
        allowedExtensions: new Set(['png', 'pdf', 'txt']),
      },
    )
    expect(attachments).toHaveLength(0)
  })

  it('missing token skipped, does not throw', async () => {
    const { attachments } = await materializeAttachments(
      [{ kind: 'token', token: 'att_nope', name: 'x.png', mimeType: 'image/png' }],
      {
        agentId: 'agt_1',
        runId: 'run_4',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['png', 'pdf', 'txt']),
      },
    )
    expect(attachments).toHaveLength(0)
  })

  it('uri pointing at own staging token resolves via local path', async () => {
    const { token } = await stageAttachment(
      Buffer.from('viauri'),
      'u.pdf',
      'application/pdf',
      'usr_test',
    )
    const { attachments } = await materializeAttachments(
      [{ kind: 'uri', uri: `https://host/api/attachments/${token}`, name: 'u.pdf' }],
      {
        agentId: 'agt_1',
        runId: 'run_5',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['png', 'pdf', 'txt']),
      },
    )
    expect(attachments).toHaveLength(1)
    expect(readFileSync(attachments[0].path, 'utf-8')).toBe('viauri')
    // staging uri 解析成 token 重放，不保留 uri（重放走 token 消费鉴权，与外部 uri 相反）。
    expect(attachments[0].token).toBeDefined()
    expect(attachments[0].uri).toBeUndefined()
  })

  it('enforces the count cap (extras dropped)', async () => {
    // Promise.all: stageAttachment writes to disk and is async now, so the map
    // yields promises that have to be resolved before use.
    const toks = await Promise.all(
      [1, 2, 3].map((i) =>
        stageAttachment(Buffer.from(`i${i}`), `p${i}.png`, 'image/png', 'usr_test'),
      ),
    )
    const { attachments } = await materializeAttachments(
      toks.map((t) => ({
        kind: 'token' as const,
        token: t.token,
        name: 'p.png',
        mimeType: 'image/png',
      })),
      {
        agentId: 'agt_1',
        runId: 'run_cap',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 2,
        allowedExtensions: new Set(['png']),
      },
    )
    expect(attachments).toHaveLength(2)
  })

  it('rejects extensions outside the allow-list', async () => {
    const { attachments } = await materializeAttachments(
      [
        {
          kind: 'bytes',
          bytes: Buffer.from('x').toString('base64'),
          name: 'evil.sh',
          mimeType: 'text/x-sh',
        },
      ],
      {
        agentId: 'agt_1',
        runId: 'run_ext',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['png', 'pdf']),
      },
    )
    expect(attachments).toHaveLength(0)
  })

  it('collision-safe: same sanitized name does not overwrite', async () => {
    const { attachments } = await materializeAttachments(
      [
        {
          kind: 'bytes',
          bytes: Buffer.from('first').toString('base64'),
          name: 'a b.txt',
          mimeType: 'text/plain',
        },
        {
          kind: 'bytes',
          bytes: Buffer.from('second').toString('base64'),
          name: 'a-b.txt',
          mimeType: 'text/plain',
        },
      ],
      {
        agentId: 'agt_1',
        runId: 'run_col',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['txt']),
      },
    )
    expect(attachments).toHaveLength(2)
    expect(attachments[0].path).not.toBe(attachments[1].path)
    expect(readFileSync(attachments[0].path, 'utf-8')).toBe('first')
    expect(readFileSync(attachments[1].path, 'utf-8')).toBe('second')
  })
})

describe('materializeForRun', () => {
  it('no sources → passthrough, rootDir null', async () => {
    const r = await materializeForRun({
      agentId: 'agt_1',
      runId: 'run_6',
      message: 'hi',
      sources: undefined,
      consumerId: 'usr_test',
    })
    expect(r).toEqual({ mergedPrompt: 'hi', rootDir: null, materialized: [] })
  })

  it('all-failed sources → passthrough, empty root cleaned, materialized empty', async () => {
    const r = await materializeForRun({
      agentId: 'agt_1',
      runId: 'run_7',
      message: 'hi',
      sources: [{ kind: 'token', token: 'att_missing' }],
      consumerId: 'usr_test',
    })
    expect(r.mergedPrompt).toBe('hi')
    expect(r.rootDir).toBeNull()
    // 全丢时 materialized 为空——渠道据此不写 chip，历史不显示不存在的附件（review [P2]）。
    expect(r.materialized).toEqual([])
  })

  it('materialized reflects only actually-staged attachments', async () => {
    const { token } = await stageAttachment(Buffer.from('i'), 'p.png', 'image/png', 'usr_test')
    const r = await materializeForRun({
      agentId: 'agt_1',
      runId: 'run_mat',
      message: 'look',
      // 一个有效 token + 一个过期/不存在 token：只有前者应出现在 materialized。
      sources: [
        { kind: 'token', token, name: 'p.png', mimeType: 'image/png' },
        { kind: 'token', token: 'att_gone', name: 'x.png', mimeType: 'image/png' },
      ],
      consumerId: 'usr_test',
    })
    expect(r.materialized).toHaveLength(1)
    expect(r.materialized[0]).toMatchObject({ token, name: 'p.png', mimeType: 'image/png' })
    if (r.rootDir) await cleanupMaterializedRoot(r.rootDir)
  })

  it('successful merge injects hint + returns rootDir + registers token', async () => {
    recordedTokens.length = 0
    const { token } = await stageAttachment(Buffer.from('i'), 'p.png', 'image/png', 'usr_test')
    const r = await materializeForRun({
      agentId: 'agt_1',
      runId: 'run_8',
      message: 'look',
      sources: [{ kind: 'token', token, name: 'p.png', mimeType: 'image/png' }],
      consumerId: 'usr_test',
    })
    expect(r.mergedPrompt).toContain('图片路径：')
    expect(r.mergedPrompt.startsWith('look\n\n---\n[图片]')).toBe(true)
    expect(r.rootDir).not.toBeNull()
    // 反查表登记用**实际解析到的 token**（单点在 materializeForRun）。
    expect(recordedTokens).toContain(token)
    if (r.rootDir) await cleanupMaterializedRoot(r.rootDir)
  })

  it('registers token resolved via a staging uri (A2A uri→token 覆盖)', async () => {
    recordedTokens.length = 0
    const { token } = await stageAttachment(Buffer.from('u'), 'u.png', 'image/png', 'usr_test')
    const r = await materializeForRun({
      agentId: 'agt_1',
      runId: 'run_uri',
      message: 'hi',
      sources: [{ kind: 'uri', uri: `https://host/api/attachments/${token}`, name: 'u.png' }],
      consumerId: 'usr_test',
    })
    expect(recordedTokens).toContain(token)
    if (r.rootDir) await cleanupMaterializedRoot(r.rootDir)
  })

  it('never throws — infra error degrades to text-only (no slot leak)', async () => {
    // 把落盘根目录指到一个无法创建子目录的位置（settings mock 已固定）；用一个
    // 保证在 materializeAttachments 里抛错的场景：把 agent home 指向文件而非目录。
    const badRoot = join(homesRootHolder.path, 'blocker')
    writeFileSync(badRoot, 'x') // 让 <badRoot>/tmp/... 的 mkdir 抛 ENOTDIR
    process.env.A2WAVE_AGENT_HOMES_DIR = badRoot
    const r = await materializeForRun({
      agentId: 'agt_boom',
      runId: 'run_boom',
      message: 'hi',
      sources: [
        {
          kind: 'bytes',
          bytes: Buffer.from('x').toString('base64'),
          name: 'a.png',
          mimeType: 'image/png',
        },
      ],
      consumerId: 'usr_test',
    })
    // 不抛错，降级为纯文本，rootDir 为 null（调用方无需清理，也不会泄漏并发槽）。
    expect(r).toEqual({ mergedPrompt: 'hi', rootDir: null, materialized: [] })
  })
})

describe('refsToSources（rerun/出队 refs → 源）', () => {
  it('token ref → kind token', async () => {
    expect(refsToSources([{ token: 'att_1', name: 'a.png', mimeType: 'image/png' }])).toEqual([
      { kind: 'token', token: 'att_1', name: 'a.png', mimeType: 'image/png' },
    ])
  })

  it('uri ref（无 token，外部 uri 重放）→ kind uri', async () => {
    expect(
      refsToSources([{ uri: 'https://example.com/p.png', name: 'p.png', mimeType: 'image/png' }]),
    ).toEqual([
      { kind: 'uri', uri: 'https://example.com/p.png', name: 'p.png', mimeType: 'image/png' },
    ])
  })

  it('token 与 uri 皆无的 ref 被丢弃（bytes 审计 ref 无法重放）', async () => {
    expect(
      refsToSources([
        { name: 'orphan.png', mimeType: 'image/png' },
        { token: 'att_2', name: 'ok.png', mimeType: 'image/png' },
      ]),
    ).toEqual([{ kind: 'token', token: 'att_2', name: 'ok.png', mimeType: 'image/png' }])
  })

  it('空/未定义 → undefined', async () => {
    expect(refsToSources(undefined)).toBeUndefined()
    expect(refsToSources([])).toBeUndefined()
  })
})

describe('token consume authz', () => {
  it('rejects token consumed by a non-uploader', async () => {
    const { token } = await stageAttachment(
      Buffer.from('secret'),
      's.png',
      'image/png',
      'usr_owner',
    )
    const { attachments } = await materializeAttachments(
      [{ kind: 'token', token, name: 's.png', mimeType: 'image/png' }],
      {
        agentId: 'agt_1',
        runId: 'run_theft',
        consumerId: 'usr_attacker', // 不是上传者
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['png']),
      },
    )
    expect(attachments).toHaveLength(0)
  })

  it('rejects staged token exceeding the current size limit (policy re-check)', async () => {
    const { token } = await stageAttachment(Buffer.alloc(2048), 'big.png', 'image/png', 'usr_test')
    const { attachments } = await materializeAttachments(
      [{ kind: 'token', token, name: 'big.png', mimeType: 'image/png' }],
      {
        agentId: 'agt_1',
        runId: 'run_shrunk',
        consumerId: 'usr_test',
        maxBytes: 1024, // 管理员事后调小
        maxCount: 10,
        allowedExtensions: new Set(['png']),
      },
    )
    expect(attachments).toHaveLength(0)
  })
})

describe('detectIsImage 以扩展名为准（MIME 欺骗防护）', () => {
  it('spoofed image/* on a .pdf is treated as a file, not an image', async () => {
    // 用扩展名判定：.pdf 即使 mimeType=image/png 也应走 [文件] 提示，不走 [图片]（review [P1]）。
    const { attachments } = await materializeAttachments(
      [
        {
          kind: 'bytes',
          bytes: Buffer.from('%PDF-1.4').toString('base64'),
          name: 'report.pdf',
          mimeType: 'image/png', // 伪造
        },
      ],
      {
        agentId: 'agt_1',
        runId: 'run_spoof',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['pdf']),
      },
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0].isImage).toBe(false)
    const merged = mergeAttachmentsIntoPrompt('hi', attachments)
    expect(merged).toContain('[文件] report.pdf')
    expect(merged).not.toContain('[图片]')
  })

  it('extensionless bytes fall back to MIME for image detection', async () => {
    const { attachments } = await materializeAttachments(
      [
        {
          kind: 'bytes',
          bytes: Buffer.from('x').toString('base64'),
          name: undefined,
          mimeType: 'image/png',
        },
      ],
      {
        agentId: 'agt_1',
        runId: 'run_noext',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(['png']),
      },
    )
    // 无 name 时用 mime 补 .png 扩展名，仍判为图片。
    expect(attachments).toHaveLength(1)
    expect(attachments[0].isImage).toBe(true)
  })
})

describe('fail-closed allow-list', () => {
  it('empty allowedExtensions rejects everything (not fail-open)', async () => {
    const { attachments } = await materializeAttachments(
      [
        {
          kind: 'bytes',
          bytes: Buffer.from('x').toString('base64'),
          name: 'a.png',
          mimeType: 'image/png',
        },
      ],
      {
        agentId: 'agt_1',
        runId: 'run_fc',
        consumerId: 'usr_test',
        maxBytes: 10 * 1024 * 1024,
        maxCount: 10,
        allowedExtensions: new Set(),
      },
    )
    expect(attachments).toHaveLength(0)
  })
})
