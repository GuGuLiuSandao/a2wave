/**
 * Unit tests for lib/artifact-links.ts — 聚焦飞书产物区块构建。
 * artifact-share / server-url 用 mock 隔离，覆盖「以文件发送」时追加在线预览的行为。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockHasActiveShare = vi.fn<(artifactId: string) => boolean>()
const mockListSharesForArtifact = vi.fn<(artifactId: string) => unknown[]>()

// Both are async in production; the mocks stay synchronous and are wrapped here,
// so each test still configures a plain value while the callers still await.
vi.mock('../artifact-share.js', () => ({
  createArtifactShare: vi.fn(),
  hasActiveShare: async (id: string) => mockHasActiveShare(id),
  listSharesForArtifact: async (id: string) => mockListSharesForArtifact(id),
}))

vi.mock('../server-url.js', () => ({
  getArtifactDownloadUrl: (id: string) => `https://a2wave.example.com/api/artifacts/${id}/download`,
  getShareUrl: (_agentId: string | null, shareId: string) =>
    `https://a2wave.example.com/s/${shareId}`,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { buildFeishuArtifactSection } from '../artifact-links.js'

const future = new Date(Date.now() + 86_400_000)

beforeEach(() => {
  mockHasActiveShare.mockReset()
  mockListSharesForArtifact.mockReset()
  mockHasActiveShare.mockReturnValue(false)
  mockListSharesForArtifact.mockReturnValue([])
})

const withShare = (artifactId: string, shareId: string) => {
  mockHasActiveShare.mockImplementation((id) => id === artifactId)
  mockListSharesForArtifact.mockImplementation((id) =>
    id === artifactId
      ? [{ id: shareId, revokedAt: null, expiresAt: future, createdAt: future }]
      : [],
  )
}

const artifact = (over: Partial<{ id: string; filename: string; agentId: string }> = {}) =>
  ({
    id: over.id ?? 'art_1',
    filename: over.filename ?? 'cute-chick',
    agentId: over.agentId ?? 'agt_1',
  }) as never

describe('buildFeishuArtifactSection', () => {
  it('无产物时返回 null', async () => {
    await expect(buildFeishuArtifactSection([], false)).resolves.toBeNull()
    await expect(buildFeishuArtifactSection([], true)).resolves.toBeNull()
  })

  it('不以文件发送时返回 产物下载 区块（含下载链接）', async () => {
    const section = await buildFeishuArtifactSection([artifact()], false)
    expect(section).toContain('**产物下载**')
    expect(section).toContain('https://a2wave.example.com/api/artifacts/art_1/download')
  })

  it('以文件发送且存在在线分享时，返回 在线预览 区块（含在线查看链接，不含下载链接）', async () => {
    withShare('art_1', 'shr_1')
    const section = await buildFeishuArtifactSection([artifact()], true)
    expect(section).toContain('**在线预览**')
    expect(section).toContain('在线查看')
    expect(section).toContain('https://a2wave.example.com/s/shr_1')
    expect(section).not.toContain('/download')
  })

  it('以文件发送但无在线分享时返回 null（避免空区块）', async () => {
    await expect(buildFeishuArtifactSection([artifact()], true)).resolves.toBeNull()
  })

  it('以文件发送时只为有分享的产物生成在线查看行', async () => {
    withShare('art_1', 'shr_1')
    const section = await buildFeishuArtifactSection(
      [artifact({ id: 'art_1', filename: 'a' }), artifact({ id: 'art_2', filename: 'b' })],
      true,
    )
    expect(section).toContain('- a · [在线查看](https://a2wave.example.com/s/shr_1)')
    expect(section).not.toContain('- b ·')
  })
})
