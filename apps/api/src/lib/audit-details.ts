import { maskScmConfig } from './scm-secret-mask.js'

/**
 * Builders for the `details` payload of an audit entry.
 *
 * `details` is what makes a row answerable: without it the audit page shows a
 * bare resource id, so "who created a source pointing at which repo" cannot be
 * answered without cross-referencing a database that may no longer hold the row
 * (deletes especially). See docs/agent/audit-logging.md.
 *
 * Every builder here is responsible for keeping credentials out of its own
 * output — `details` is stored as plaintext JSON and rendered verbatim to every
 * admin.
 */

interface ScmSourceLike {
  name: string
  type: string
  localPath: string
  config?: unknown
}

/**
 * Identifying fields for an SCM source: which source, of what kind, checked out
 * where, and pointing at which repo/depot.
 *
 * The config is passed through `maskScmConfig`, which redacts the Git PAT, the
 * P4 password, and any credential embedded in a repo URL's userinfo — while
 * leaving the repo address readable, since that address is the whole point of
 * the entry.
 */
export function scmSourceAuditDetails(source: ScmSourceLike): Record<string, unknown> {
  return {
    name: source.name,
    type: source.type,
    localPath: source.localPath,
    config: maskScmConfig(source.config),
  }
}
