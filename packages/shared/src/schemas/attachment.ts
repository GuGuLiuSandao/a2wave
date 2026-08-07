/**
 * Attachment reference schema — the cross-channel contract for file/image inputs.
 *
 * Callers upload bytes to `POST /api/attachments` (two-step flow), receive an
 * opaque `token`, then pass `attachments: [{ token, name, mimeType, size? }]` in
 * the invoke/chat JSON body. The API materializes the staged bytes into the
 * agent's runtime tmp dir and injects absolute-path hints into the prompt —
 * identical to how Feishu already delivers attachments.
 *
 * The allow-list constants below are the SINGLE SOURCE OF TRUTH shared between the
 * upload endpoint's server-side validation and the web `<input accept>` string.
 */
import { z } from 'zod'

// ── Allow-list (single source of truth) ────────────────────────────────────────
/** Image extensions (previewable in the UI). No leading dot, lowercase. */
export const ATTACHMENT_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
/** Document extensions. */
export const ATTACHMENT_DOC_EXTS = ['pdf', 'txt', 'md', 'csv', 'docx', 'xlsx'] as const
/** All accepted extensions (images + docs). */
export const ATTACHMENT_ALL_EXTS = [...ATTACHMENT_IMAGE_EXTS, ...ATTACHMENT_DOC_EXTS] as const

/**
 * Default per-file size limit (10MB). The authoritative limit is the
 * `attachments.maxFileSizeBytes` setting (admin-editable); this constant is the
 * default and a client-side pre-check hint so the browser can reject oversized
 * files before uploading. Keep in sync with SETTINGS_DEFAULTS.attachments.
 */
export const ATTACHMENT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

/** Hard cap on attachments per invoke (matches `.max(10)` on attachmentsInputSchema).
 * The web composer caps selection with it so a user cannot pick 11, upload them all,
 * have the schema reject the send, and find the composer already cleared. */
export const ATTACHMENT_MAX_FILES = 10

/** ext → MIME type. Mirrors the shape of uploads.ts MIME_MAP. */
export const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** Distinct MIME types accepted, derived from the ext map (deduped). Used by A2A agent-card input modes. */
export const ATTACHMENT_MIME_TYPES: string[] = [...new Set(Object.values(ATTACHMENT_MIME_BY_EXT))]

/** True when an extension (no dot, any case) denotes a previewable image. */
export function isAttachmentImageExt(ext: string): boolean {
  return (ATTACHMENT_IMAGE_EXTS as readonly string[]).includes(ext.replace(/^\./, '').toLowerCase())
}

// ── Reference schema ────────────────────────────────────────────────────────────
export const attachmentRefSchema = z.object({
  /** Opaque staging reference returned by POST /api/attachments. */
  token: z.string().min(1).max(200),
  /** Original filename — used for display and as the on-disk name hint. */
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().nonnegative().optional(),
})
export type AttachmentRef = z.infer<typeof attachmentRefSchema>

/**
 * Invoke/chat body field. The `.max(10)` here is a hard schema ceiling (input
 * validation / abuse ceiling). The admin-tunable `attachments.maxFilesPerRequest`
 * setting is enforced downstream at materialization time (attachment-materializer),
 * which can lower the effective count below this ceiling for all channels (incl.
 * A2A FileParts, which bypass this schema).
 */
export const attachmentsInputSchema = z.array(attachmentRefSchema).max(10).optional()
