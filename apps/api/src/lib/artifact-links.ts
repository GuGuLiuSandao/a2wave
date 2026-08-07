/**
 * Artifact link-line builders — shared by run-lifecycle and feishu-service.
 * When the agent has autoShare enabled, html/md/directory artifacts get a share created
 * automatically and an online-view link appended.
 */
import type { ArtifactPolicy } from '@a2wave/shared'
import { createArtifactShare, hasActiveShare, listSharesForArtifact } from './artifact-share.js'
import type { RegisteredArtifact } from './artifact-storage.js'
import { logger } from './logger.js'
import { getArtifactDownloadUrl, getShareUrl } from './server-url.js'

const SHAREABLE_MIMES = new Set(['text/html', 'text/markdown'])

export async function buildArtifactLinkLine(
  artifact: RegisteredArtifact,
  userId: string | null,
  policy?: ArtifactPolicy | null,
): Promise<string> {
  const downloadUrl = await getArtifactDownloadUrl(artifact.id)
  const autoShareEnabled = policy?.autoShare === 'on'
  const isShareable =
    artifact.kind === 'directory' ||
    (artifact.mimeType != null && SHAREABLE_MIMES.has(artifact.mimeType))

  if (autoShareEnabled && isShareable) {
    const accessLevel = policy?.shareAccessLevel ?? 'authenticated'
    const expiryDays = policy?.shareExpiryDays ?? 7
    try {
      const share = await createArtifactShare({
        artifactId: artifact.id,
        createdBy: userId,
        accessLevel,
        expiryDays,
      })
      const shareLink = await getShareUrl(artifact.agentId, share.id)
      return `- [${artifact.filename}](${downloadUrl}) · [在线查看](${shareLink})`
    } catch (err) {
      logger.warn({ err, artifactId: artifact.id }, 'Auto-share creation failed, falling back')
    }
  }

  return `- [${artifact.filename}](${downloadUrl})`
}

export async function buildArtifactLinkLines(
  artifacts: RegisteredArtifact[],
  userId: string | null,
  policy?: ArtifactPolicy | null,
): Promise<string> {
  const lines = await Promise.all(artifacts.map((a) => buildArtifactLinkLine(a, userId, policy)))
  return lines.join('\n')
}

/**
 * Look up an artifact's existing active share URL (never creates a new share).
 * Called by feishu-service and friends after run-lifecycle has already created the
 * auto-share, so it is not created twice.
 * Returning null tells the caller to fall back to the download link.
 */
export async function getExistingShareUrl(
  agentId: string | null,
  artifactId: string,
): Promise<string | null> {
  if (!(await hasActiveShare(artifactId))) return null
  const shares = (await listSharesForArtifact(artifactId))
    .filter((s) => !s.revokedAt && s.expiresAt > new Date())
    // When one artifact has several active shares, take the most recently created one so
    // the link stays deterministic.
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
  if (shares.length === 0) return null
  return await getShareUrl(agentId, shares[0].id)
}

/** Build artifact link lines for a Feishu message (reuses the existing auto-share; never creates one) */
export async function buildArtifactLinkLineSync(artifact: RegisteredArtifact): Promise<string> {
  const downloadUrl = await getArtifactDownloadUrl(artifact.id)
  const shareUrl = await getExistingShareUrl(artifact.agentId, artifact.id)
  if (shareUrl) {
    return `- [${artifact.filename}](${downloadUrl}) · [在线查看](${shareUrl})`
  }
  return `- [${artifact.filename}](${downloadUrl})`
}

export async function buildArtifactLinkLinesSync(artifacts: RegisteredArtifact[]): Promise<string> {
  const lines = await Promise.all(artifacts.map((a) => buildArtifactLinkLineSync(a)))
  return lines.join('\n')
}

/**
 * Build the artifact block to append to a Feishu reply (reuses the existing auto-share;
 * never creates one):
 * - When artifacts are sent as files (wantSendFiles): they already ship as attachments, so no
 *   download link is needed; an online-preview block is appended only when a share exists.
 * - Otherwise: append the download block with download links (each line also carrying an
 *   online-view link when autoShare is on).
 * Returns null when no block should be appended.
 */
export async function buildFeishuArtifactSection(
  artifacts: RegisteredArtifact[],
  wantSendFiles: boolean,
): Promise<string | null> {
  if (artifacts.length === 0) return null
  if (!wantSendFiles) {
    return `**产物下载**\n${await buildArtifactLinkLinesSync(artifacts)}`
  }
  const previewLines = (
    await Promise.all(
      artifacts.map(async (a) => {
        const shareUrl = await getExistingShareUrl(a.agentId, a.id)
        return shareUrl ? `- ${a.filename} · [在线查看](${shareUrl})` : null
      }),
    )
  ).filter((line): line is string => line != null)
  return previewLines.length > 0 ? `**在线预览**\n${previewLines.join('\n')}` : null
}
