import { describe, expect, it } from 'vitest'
import {
  MASKED_URL_WITHOUT_SOURCE_ERROR,
  SCM_SECRET_MASK,
  UNRESOLVABLE_MASKED_URL_ERROR,
  isMaskedOrBlank,
  isMaskedRepoUrl,
  maskScmConfig,
  maskScmSourceRow,
  redactRepoUrlCredential,
  rehydrateScmConfigSecrets,
  restoreMaskedGitUrls,
  scmConfigEquals,
  unresolvableMaskedGitUrls,
} from '../scm-secret-mask.js'

describe('scm-secret-mask', () => {
  describe('maskScmConfig — P4', () => {
    it('masks a non-empty p4passwd', async () => {
      const masked = maskScmConfig({
        type: 'p4',
        p4port: 'localhost:1666',
        p4user: 'admin',
        p4passwd: 'super-secret-password',
        p4client: 'ws',
      }) as Record<string, unknown>
      expect(masked.p4passwd).toBe(SCM_SECRET_MASK)
      // Non-secret fields are preserved.
      expect(masked.p4port).toBe('localhost:1666')
      expect(masked.p4user).toBe('admin')
    })

    it('leaves an empty p4passwd untouched (nothing to hide)', async () => {
      const masked = maskScmConfig({
        type: 'p4',
        p4port: 'localhost:1666',
        p4user: 'admin',
        p4passwd: '',
        p4client: 'ws',
      }) as Record<string, unknown>
      expect(masked.p4passwd).toBe('')
    })
  })

  describe('maskScmConfig — Git', () => {
    it('masks a non-empty pat', async () => {
      const masked = maskScmConfig({
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'main',
        pat: 'ghp_realtoken',
      }) as Record<string, unknown>
      expect(masked.pat).toBe(SCM_SECRET_MASK)
    })

    it('redacts credentials embedded in repoUrl', async () => {
      const masked = maskScmConfig({
        type: 'git',
        repoUrl: 'https://alice:ghp_secret@github.com/org/repo.git',
        branch: 'main',
      }) as Record<string, unknown>
      expect(masked.repoUrl).not.toContain('ghp_secret')
      expect(masked.repoUrl).toContain('github.com/org/repo.git')
    })

    it('redacts credentials in every entry of repos[]', async () => {
      const masked = maskScmConfig({
        type: 'git',
        repoUrl: 'https://github.com/org/main.git',
        branch: 'main',
        repos: [
          { repoUrl: 'https://bob:tok1@github.com/org/a.git', branch: 'main', directory: 'a' },
          { repoUrl: 'https://carol:tok2@github.com/org/b.git', branch: 'main', directory: 'b' },
        ],
      }) as { repos: Array<{ repoUrl: string }> }
      expect(masked.repos[0].repoUrl).not.toContain('tok1')
      expect(masked.repos[1].repoUrl).not.toContain('tok2')
    })

    it('leaves a credential-free repoUrl unchanged', async () => {
      const url = 'https://github.com/org/repo.git'
      const masked = maskScmConfig({ type: 'git', repoUrl: url, branch: 'main' }) as Record<
        string,
        unknown
      >
      expect(masked.repoUrl).toBe(url)
    })
  })

  describe('maskScmConfig — defence in depth', () => {
    it('returns non-object configs unchanged', async () => {
      expect(maskScmConfig(null)).toBeNull()
      expect(maskScmConfig(undefined)).toBeUndefined()
      expect(maskScmConfig('nope')).toBe('nope')
    })

    it('returns unknown-type configs unchanged (never throws)', async () => {
      const cfg = { type: 'svn', whatever: 1 }
      expect(maskScmConfig(cfg)).toEqual(cfg)
    })
  })

  describe('redactRepoUrlCredential', () => {
    it('drops the inline password but keeps the (masked) username marker', async () => {
      const out = redactRepoUrlCredential('https://user:pass@host/repo.git')
      expect(out).not.toContain('pass')
    })

    it('returns scp-style git@host URLs unchanged (no inline password)', async () => {
      const scp = 'git@github.com:org/repo.git'
      expect(redactRepoUrlCredential(scp)).toBe(scp)
    })

    it('returns empty string unchanged', async () => {
      expect(redactRepoUrlCredential('')).toBe('')
    })
  })

  describe('isMaskedOrBlank', () => {
    it('treats null/undefined/empty/sentinel as unchanged', async () => {
      expect(isMaskedOrBlank(null)).toBe(true)
      expect(isMaskedOrBlank(undefined)).toBe(true)
      expect(isMaskedOrBlank('')).toBe(true)
      expect(isMaskedOrBlank(SCM_SECRET_MASK)).toBe(true)
    })

    it('treats a real value as changed', async () => {
      expect(isMaskedOrBlank('real-secret')).toBe(false)
    })
  })

  describe('isMaskedRepoUrl', () => {
    it('detects a URL masked by redactRepoUrlCredential', async () => {
      const masked = redactRepoUrlCredential('https://user:tok@github.com/o/r.git')
      expect(isMaskedRepoUrl(masked)).toBe(true)
    })

    it('treats blank/undefined as masked (keep stored)', async () => {
      expect(isMaskedRepoUrl('')).toBe(true)
      expect(isMaskedRepoUrl(undefined)).toBe(true)
    })

    it('is false for a genuine user-changed URL and for scp-style', async () => {
      expect(isMaskedRepoUrl('https://github.com/o/new.git')).toBe(false)
      expect(isMaskedRepoUrl('git@github.com:o/r.git')).toBe(false)
    })
  })

  describe('restoreMaskedGitUrls', () => {
    it('restores a masked top-level repoUrl from existing', async () => {
      const existing = {
        type: 'git' as const,
        repoUrl: 'https://user:realtok@github.com/o/r.git',
        branch: 'main',
      }
      const maskedUrl = redactRepoUrlCredential(existing.repoUrl)
      const incoming = { type: 'git' as const, repoUrl: maskedUrl, branch: 'main' }
      const out = restoreMaskedGitUrls(incoming, existing)
      expect(out.repoUrl).toBe(existing.repoUrl)
    })

    it('keeps a genuinely changed repoUrl as submitted', async () => {
      const existing = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/old.git',
        branch: 'main',
      }
      const incoming = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/new.git',
        branch: 'main',
      }
      const out = restoreMaskedGitUrls(incoming, existing)
      expect(out.repoUrl).toBe('https://github.com/o/new.git')
    })

    it('restores masked repos[] entries by masked-value match (not by directory)', async () => {
      const existing = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/main.git',
        branch: 'main',
        repos: [
          { repoUrl: 'https://u:tokA@github.com/o/a.git', branch: 'main', directory: 'a' },
          { repoUrl: 'https://u:tokB@github.com/o/b.git', branch: 'main', directory: 'b' },
        ],
      }
      const incoming = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/main.git',
        branch: 'main',
        repos: [
          {
            repoUrl: redactRepoUrlCredential(existing.repos[0].repoUrl),
            branch: 'main',
            directory: 'a',
          },
          { repoUrl: 'https://github.com/o/b-changed.git', branch: 'main', directory: 'b' },
        ],
      }
      const out = restoreMaskedGitUrls(incoming, existing)
      expect(out.repos?.[0].repoUrl).toBe(existing.repos[0].repoUrl)
      expect(out.repos?.[1].repoUrl).toBe('https://github.com/o/b-changed.git')
    })

    it('restores correctly when the directory was RENAMED (Codex P1)', async () => {
      // The user only renamed the directory; repoUrl stayed masked. Directory-keyed
      // matching would miss it; value-based matching still finds the stored URL.
      const existing = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/main.git',
        branch: 'main',
        repos: [
          { repoUrl: 'https://u:realtok@github.com/o/a.git', branch: 'main', directory: 'old' },
        ],
      }
      const incoming = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/main.git',
        branch: 'main',
        repos: [
          {
            repoUrl: redactRepoUrlCredential(existing.repos[0].repoUrl),
            branch: 'main',
            directory: 'renamed', // ← directory changed, URL still masked
          },
        ],
      }
      const out = restoreMaskedGitUrls(incoming, existing)
      // Real credential recovered despite the rename; sentinel never persisted.
      expect(out.repos?.[0].repoUrl).toBe(existing.repos[0].repoUrl)
      expect(out.repos?.[0].directory).toBe('renamed')
    })

    it('restores the right stored URL on a multi→single switch (Codex P1)', async () => {
      // Switching to single-repo: incoming top-level URL is the masked value of the
      // SELECTED repo, not the old top-level. Value matching restores the correct one.
      const existing = {
        type: 'git' as const,
        repoUrl: 'https://u:legacytok@github.com/o/legacy.git', // old top-level
        branch: 'main',
        repos: [
          { repoUrl: 'https://u:tokA@github.com/o/a.git', branch: 'main', directory: 'a' },
          { repoUrl: 'https://u:tokB@github.com/o/b.git', branch: 'main', directory: 'b' },
        ],
      }
      // User picks repo 'b' as the single repo → submits its masked URL at top level.
      const incoming = {
        type: 'git' as const,
        repoUrl: redactRepoUrlCredential(existing.repos[1].repoUrl),
        branch: 'main',
      }
      const out = restoreMaskedGitUrls(incoming, existing)
      // Restores repo B's URL, NOT the old top-level legacy.git.
      expect(out.repoUrl).toBe(existing.repos[1].repoUrl)
    })

    it('leaves the sentinel when no stored URL matches (caller must reject)', async () => {
      const existing = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/main.git',
        branch: 'main',
      }
      // A masked URL that corresponds to no stored URL (e.g. host changed too).
      const incoming = {
        type: 'git' as const,
        repoUrl: 'https://********@elsewhere.com/o/x.git',
        branch: 'main',
      }
      const out = restoreMaskedGitUrls(incoming, existing)
      // Unrecoverable → sentinel preserved so unresolvableMaskedGitUrls flags it.
      expect(out.repoUrl).toBe('https://********@elsewhere.com/o/x.git')
    })

    it('does NOT guess when the masked value is ambiguous across repos (Codex P1)', async () => {
      // Two stored repos on the same host but with DIFFERENT credentials mask to
      // the identical `********@host/repo` value. Restoring must NOT silently pick
      // the first (which would graft repo A's token onto repo B) — it leaves the
      // sentinel on both so the route rejects the update.
      const existing = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/main.git',
        branch: 'main',
        repos: [
          { repoUrl: 'https://alice:token-a@example.com/o/r.git', branch: 'a', directory: 'a' },
          { repoUrl: 'https://bob:token-b@example.com/o/r.git', branch: 'b', directory: 'b' },
        ],
      }
      const maskedShared = redactRepoUrlCredential(existing.repos[0].repoUrl)
      // Both mask to the same value — precondition of the ambiguity.
      expect(redactRepoUrlCredential(existing.repos[1].repoUrl)).toBe(maskedShared)

      const incoming = {
        type: 'git' as const,
        repoUrl: 'https://github.com/o/main.git',
        branch: 'main',
        repos: [
          { repoUrl: maskedShared, branch: 'a', directory: 'a' },
          { repoUrl: maskedShared, branch: 'b', directory: 'b' },
        ],
      }
      const out = restoreMaskedGitUrls(incoming, existing)
      // Neither entry is silently attributed — both keep the sentinel.
      expect(out.repos?.[0].repoUrl).toBe(maskedShared)
      expect(out.repos?.[1].repoUrl).toBe(maskedShared)
      // And the route-level guard flags them as unresolvable.
      expect(unresolvableMaskedGitUrls(out).length).toBeGreaterThan(0)
    })
  })

  describe('unresolvableMaskedGitUrls', () => {
    it('flags a sentinel URL that could not be restored', async () => {
      const bad = unresolvableMaskedGitUrls({
        repoUrl: 'https://********@elsewhere.com/o/x.git',
      })
      expect(bad).toHaveLength(1)
    })

    it('flags sentinel URLs inside repos[]', async () => {
      const bad = unresolvableMaskedGitUrls({
        repoUrl: 'https://github.com/o/main.git',
        repos: [
          { repoUrl: 'https://github.com/o/a.git', directory: 'a' },
          { repoUrl: 'https://********@github.com/o/b.git', directory: 'b' },
        ],
      })
      expect(bad).toEqual(['https://********@github.com/o/b.git'])
    })

    it('does NOT flag blank or fully-resolved URLs', async () => {
      expect(unresolvableMaskedGitUrls({ repoUrl: 'https://github.com/o/r.git' })).toHaveLength(0)
      expect(unresolvableMaskedGitUrls({ repoUrl: '' })).toHaveLength(0)
    })
  })

  describe('maskScmSourceRow', () => {
    it('masks the config field and preserves the rest of the row', async () => {
      const row = {
        id: 'scm_1',
        name: 'Repo',
        type: 'git',
        config: {
          type: 'git',
          repoUrl: 'https://u:tok@github.com/org/repo.git',
          branch: 'main',
          pat: 'ghp_real',
        },
      }
      const masked = maskScmSourceRow(row)!
      expect(masked.id).toBe('scm_1')
      expect(masked.name).toBe('Repo')
      expect((masked.config as Record<string, unknown>).pat).toBe(SCM_SECRET_MASK)
      expect((masked.config as Record<string, unknown>).repoUrl).not.toContain('tok')
      // Original row is not mutated.
      expect((row.config as Record<string, unknown>).pat).toBe('ghp_real')
    })

    it('is safe on rows without a config field', async () => {
      const row = { id: 'scm_1', name: 'Repo' } as { id: string; name: string; config?: unknown }
      expect(maskScmSourceRow(row)).toEqual(row)
    })
  })

  describe('rehydrateScmConfigSecrets', () => {
    /** Schema defaults: inferred config types mark these required. */
    const syncDefaults = { autoSync: false, syncIntervalMin: 30, initialSyncTimeoutMin: 60 }
    const p4Base = {
      ...syncDefaults,
      type: 'p4' as const,
      p4port: 'ssl:1666',
      p4user: 'u',
      p4client: 'c',
    }
    const gitBase = { ...syncDefaults, type: 'git' as const, branch: 'main' }

    it('restores a masked p4 password from the stored config', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...p4Base, p4passwd: SCM_SECRET_MASK },
        { ...p4Base, p4passwd: 'real-pw' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).p4passwd).toBe('real-pw')
    })

    it('keeps a genuinely changed p4 password', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...p4Base, p4passwd: 'new-pw' },
        { ...p4Base, p4passwd: 'old-pw' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).p4passwd).toBe('new-pw')
    })

    it('restores a masked git pat and masked repoUrl from the stored config', async () => {
      const result = rehydrateScmConfigSecrets(
        {
          ...gitBase,
          repoUrl: `https://${SCM_SECRET_MASK}@github.com/org/repo.git`,
          pat: SCM_SECRET_MASK,
        },
        {
          ...gitBase,
          repoUrl: 'https://alice:ghp_real@github.com/org/repo.git',
          pat: 'ghp_real',
        },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const config = result.config as Record<string, unknown>
      expect(config.pat).toBe('ghp_real')
      expect(config.repoUrl).toBe('https://alice:ghp_real@github.com/org/repo.git')
    })

    it('rejects a masked repoUrl that matches no stored URL', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: `https://${SCM_SECRET_MASK}@github.com/org/renamed.git` },
        { ...gitBase, repoUrl: 'https://alice:tok@github.com/org/original.git' },
      )
      expect(result.ok).toBe(false)
    })

    it('passes a config through untouched when there is no stored config (create mode)', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_typed_by_user' },
        undefined,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).pat).toBe('ghp_typed_by_user')
    })

    /**
     * The sentinel means "keep the stored secret" — so when there is no stored
     * secret to keep, it must resolve to *no credential*, never to itself.
     *
     * Reads mask on every path, so the form loads `********` into the credential
     * field of any source and submits it back verbatim. Letting it through made
     * the literal string the credential: `buildAuthUrlFromParts` embeds it as the
     * HTTPS password, so probing a source with no PAT dialed out with
     * `********` as a password — a spurious auth failure on a repo that is
     * actually reachable anonymously, plus the sentinel written into the remote's
     * auth log. The save path is the same shape, one step earlier: it persisted
     * the sentinel as the stored credential.
     */
    it('drops a masked git pat when the stored config has none to restore', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: SCM_SECRET_MASK },
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).pat).toBeUndefined()
    })

    it('drops a masked git pat in create mode, where there is nothing to restore from', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: SCM_SECRET_MASK },
        undefined,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).pat).toBeUndefined()
    })

    it('drops a masked p4 password when the stored config has none to restore', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...p4Base, p4passwd: SCM_SECRET_MASK },
        { ...p4Base, p4passwd: '' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // `p4passwd` is `.default('')`, so "no credential" is the empty string
      // here rather than undefined as it is for git's optional `pat`.
      expect((result.config as Record<string, unknown>).p4passwd).toBe('')
    })

    /**
     * A row already polluted by the pre-fix save path holds the sentinel as its
     * *stored* credential. Restoring it verbatim would keep dialing out with
     * `********` forever, and a blank submission cannot clear it because blank
     * means "keep stored" — so the value has to be rejected on the way out too,
     * not merely on the way in.
     */
    it('drops a stored pat that is itself the sentinel (row corrupted before the fix)', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: SCM_SECRET_MASK },
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: SCM_SECRET_MASK },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).pat).toBeUndefined()
    })

    it('drops a stored p4 password that is itself the sentinel', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...p4Base, p4passwd: SCM_SECRET_MASK },
        { ...p4Base, p4passwd: SCM_SECRET_MASK },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).p4passwd).toBe('')
    })

    /**
     * Resolving a credential must not invent a key that was never there.
     * `scmConfigEquals` sorts `Object.keys`, and `JSON.stringify(undefined)`
     * serializes an own-but-undefined property as `null` — so adding a bare
     * `pat: undefined` makes a pure round-trip compare unequal, and `PATCH /:id`
     * treats a no-op save as a config change: sync bookkeeping is reset, or the
     * request 409s while a sync holds the row.
     */
    it('does not add a pat key to a config that never had one', async () => {
      const stored = { ...gitBase, repoUrl: 'https://github.com/org/repo.git' }
      const result = rehydrateScmConfigSecrets({ ...stored }, stored)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(Object.hasOwn(result.config, 'pat')).toBe(false)
      expect(scmConfigEquals(result.config, stored)).toBe(true)
    })

    /**
     * `POST /scm-sources` has no stored row to rehydrate against, so it used to
     * skip this helper and insert the submitted config verbatim — persisting a
     * sentinel that arrives from a legacy client or a hand-rolled API call. The
     * create route now runs the same normalization with `existing = undefined`,
     * which is exactly this call shape.
     */
    it('strips a sentinel from a create-mode git config with no stored row', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: SCM_SECRET_MASK },
        undefined,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(Object.hasOwn(result.config, 'pat')).toBe(false)
    })

    it('strips a sentinel from a create-mode p4 config with no stored row', async () => {
      const result = rehydrateScmConfigSecrets({ ...p4Base, p4passwd: SCM_SECRET_MASK }, undefined)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).p4passwd).toBe('')
    })

    /**
     * Refusing is right, but the edit-mode wording blames a rename or layout
     * change — a history that cannot exist when there is no stored row. This is
     * reachable: the edit form renders the masked value into the repoUrl input,
     * so copying a URL from an existing source into the create form lands here.
     */
    it('explains a sentinel URL without blaming a stored row that never existed', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: `https://${SCM_SECRET_MASK}@github.com/org/repo.git` },
        undefined,
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe(MASKED_URL_WITHOUT_SOURCE_ERROR)
      expect(result.error).not.toContain('renamed')
    })

    it('keeps the rename wording when there IS a stored row to have matched', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: `https://${SCM_SECRET_MASK}@github.com/org/renamed.git` },
        { ...gitBase, repoUrl: 'https://alice:tok@github.com/org/original.git' },
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe(UNRESOLVABLE_MASKED_URL_ERROR)
    })

    /**
     * The blank-restore branch exists for the single-repo shape, where an empty
     * `repoUrl` can only be a masked round-trip. In multi-repo mode the top-level
     * `repoUrl` is *legitimately* empty — the form hardcodes `repoUrl: ''` — so
     * restoring it from the one stored URL is wrong twice over:
     *
     *  - a pure round-trip stops comparing equal, so `PATCH /:id` reads a no-op
     *    save as a config change and clears `initialSyncCompletedAt`, which makes
     *    every Agent bound to the source fail with SCM_INITIAL_SYNC_REQUIRED
     *    until a full resync finishes;
     *  - switching single→multi silently resurrects the URL the user just
     *    cleared, credential and all, and persists it.
     *
     * Only reproduces when a multi-repo source happens to hold exactly one repo
     * (two stored URLs make `distinctStored.length === 1` false) — and sources
     * grow one repo at a time, so that is an ordinary state, not a corner.
     */
    it('does not backfill the top-level repoUrl in multi-repo mode', async () => {
      const stored = {
        ...gitBase,
        repoUrl: '',
        repos: [{ repoUrl: 'https://alice:tok@host/a.git', branch: 'main', directory: 'a' }],
      }
      const result = rehydrateScmConfigSecrets(
        {
          ...gitBase,
          repoUrl: '',
          repos: [
            { repoUrl: `https://${SCM_SECRET_MASK}@host/a.git`, branch: 'main', directory: 'a' },
          ],
        },
        stored,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).repoUrl).toBe('')
      // The whole point: a masked round-trip must still read as "unchanged".
      expect(scmConfigEquals(result.config, stored)).toBe(true)
    })

    it('does not resurrect a cleared repoUrl when switching single to multi repo', async () => {
      const result = rehydrateScmConfigSecrets(
        {
          ...gitBase,
          repoUrl: '',
          repos: [
            { repoUrl: `https://${SCM_SECRET_MASK}@host/a.git`, branch: 'main', directory: 'a' },
          ],
        },
        { ...gitBase, repoUrl: 'https://alice:tok@host/a.git' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).repoUrl).toBe('')
      // The repos[] entry still resolves — only the top-level backfill is wrong.
      const repos = (result.config as { repos?: { repoUrl: string }[] }).repos
      expect(repos?.[0]?.repoUrl).toBe('https://alice:tok@host/a.git')
    })

    /** Single-repo mode still restores a blank round-trip, which is its purpose. */
    it('still restores a blank repoUrl in single-repo mode', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: '' },
        { ...gitBase, repoUrl: 'https://alice:tok@host/a.git' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).repoUrl).toBe(
        'https://alice:tok@host/a.git',
      )
    })

    /**
     * A stored config of a different type is ignored for restoration, so its
     * secret must not accidentally keep the sentinel alive either.
     */
    it('drops a masked git pat when the stored config is a different type', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: SCM_SECRET_MASK },
        { ...p4Base, p4passwd: 'real-pw' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect((result.config as Record<string, unknown>).pat).toBeUndefined()
    })

    /**
     * Endpoint binding (`requireSameEndpoint`) — the invariant that keeps the
     * stateless probe from turning a stored credential into an exfiltration
     * primitive. A restored secret belongs to the endpoint it was stored
     * against; dialing a caller-supplied host with it would send the victim's
     * PAT / P4 password wherever the caller points. Note this is opt-in: the
     * PATCH save path deliberately does NOT bind, because re-pointing a source
     * at a new URL while keeping its credential is a legitimate edit that is
     * persisted, audited, and never dialed out mid-request.
     */
    describe('requireSameEndpoint', () => {
      const bound = { requireSameEndpoint: true }

      it('restores a masked git pat when host and path are unchanged', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: SCM_SECRET_MASK },
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_real' },
          bound,
        )
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect((result.config as Record<string, unknown>).pat).toBe('ghp_real')
      })

      /**
       * Scheme is part of the endpoint identity. Dropping it made `ssh://` and
       * `http://` collide with a stored `https://` on the same host — and the
       * collision is not inert in the upgrade direction: `buildAuthUrlFromParts`
       * embeds the PAT for any `https://` URL, so a source keyed on SSH (or
       * plaintext http) could have its stored PAT forced onto an HTTPS request.
       * Same host only, never an arbitrary one, but still a credential reaching
       * a channel it was not issued for.
       */
      it('refuses to replay a stored pat over a different scheme on the same host', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: SCM_SECRET_MASK },
          { ...gitBase, repoUrl: 'ssh://git@github.com/org/repo.git', pat: 'ghp_real' },
          bound,
        )
        expect(result.ok).toBe(false)
      })

      it('refuses an http downgrade of a stored https endpoint', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...gitBase, repoUrl: 'http://github.com/org/repo.git', pat: SCM_SECRET_MASK },
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_real' },
          bound,
        )
        expect(result.ok).toBe(false)
      })

      /**
       * The guard must protect the whole config, not just the branch that
       * restores `pat`. Submitting a non-masked pat skipped it entirely, leaving
       * safety to rest on an unrelated detail of how `checkGitConnection`
       * branches between `repoUrl` and `repos[]`.
       */
      it('binds the endpoint even when the submitted pat is not masked', async () => {
        const result = rehydrateScmConfigSecrets(
          {
            ...gitBase,
            repoUrl: `https://${SCM_SECRET_MASK}@github.com/org/repo.git`,
            pat: 'attacker_typed',
            repos: [{ repoUrl: 'https://attacker.example/x.git', branch: 'main', directory: 'x' }],
          },
          { ...gitBase, repoUrl: 'https://victim:ghp_inurl@github.com/org/repo.git' },
          bound,
        )
        expect(result.ok).toBe(false)
      })

      it('refuses to send a stored git pat to a different host', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...gitBase, repoUrl: 'https://attacker.example/x.git', pat: SCM_SECRET_MASK },
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_real' },
          bound,
        )
        expect(result.ok).toBe(false)
      })

      it('refuses to send a stored git pat to a different path on the same host', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...gitBase, repoUrl: 'https://github.com/attacker/evil.git', pat: SCM_SECRET_MASK },
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_real' },
          bound,
        )
        expect(result.ok).toBe(false)
      })

      it('refuses when any repos[] entry points at an endpoint with no stored counterpart', async () => {
        const result = rehydrateScmConfigSecrets(
          {
            ...gitBase,
            repoUrl: '',
            pat: SCM_SECRET_MASK,
            repos: [
              { repoUrl: 'https://github.com/org/a.git', branch: 'main', directory: 'a' },
              { repoUrl: 'https://attacker.example/b.git', branch: 'main', directory: 'b' },
            ],
          },
          {
            ...gitBase,
            repoUrl: '',
            pat: 'ghp_real',
            repos: [{ repoUrl: 'https://github.com/org/a.git', branch: 'main', directory: 'a' }],
          },
          bound,
        )
        expect(result.ok).toBe(false)
      })

      it('refuses to send a stored p4 password to a different p4port', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...p4Base, p4port: 'attacker.example:1666', p4passwd: SCM_SECRET_MASK },
          { ...p4Base, p4passwd: 'real-pw' },
          bound,
        )
        expect(result.ok).toBe(false)
      })

      it('refuses to send a stored p4 password under a different p4user', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...p4Base, p4user: 'someone-else', p4passwd: SCM_SECRET_MASK },
          { ...p4Base, p4passwd: 'real-pw' },
          bound,
        )
        expect(result.ok).toBe(false)
      })

      it('restores a masked p4 password when p4port and p4user are unchanged', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...p4Base, p4passwd: SCM_SECRET_MASK },
          { ...p4Base, p4passwd: 'real-pw' },
          bound,
        )
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect((result.config as Record<string, unknown>).p4passwd).toBe('real-pw')
      })

      it('allows a freshly typed credential to reach a new endpoint', async () => {
        // Nothing is restored, so there is no stored secret to misdirect.
        const result = rehydrateScmConfigSecrets(
          { ...gitBase, repoUrl: 'https://elsewhere.example/x.git', pat: 'ghp_typed_now' },
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_real' },
          bound,
        )
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect((result.config as Record<string, unknown>).pat).toBe('ghp_typed_now')
      })

      it('still binds when the stored source has no credential to leak', async () => {
        // A public repo with no pat: changing the URL is harmless, so allow it.
        const result = rehydrateScmConfigSecrets(
          { ...gitBase, repoUrl: 'https://elsewhere.example/x.git', pat: '' },
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git' },
          bound,
        )
        expect(result.ok).toBe(true)
      })

      it('does not bind the save path (default), so a source can be re-pointed', async () => {
        const result = rehydrateScmConfigSecrets(
          { ...gitBase, repoUrl: 'https://github.com/org/moved.git', pat: SCM_SECRET_MASK },
          { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_real' },
        )
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect((result.config as Record<string, unknown>).pat).toBe('ghp_real')
      })
    })

    it('does not restore across a type change', async () => {
      const result = rehydrateScmConfigSecrets(
        { ...gitBase, repoUrl: 'https://github.com/org/repo.git', pat: '' },
        { ...p4Base, p4passwd: 'real-pw' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const config = result.config as Record<string, unknown>
      expect(config.p4passwd).toBeUndefined()
      // Blank normalizes to undefined rather than round-tripping as `''`: both
      // mean "no credential" to every consumer (`pat` is `.optional()`, and
      // `buildAuthUrlFromParts` guards on falsiness), and collapsing them keeps
      // "absent" a single representation instead of two.
      expect(config.pat).toBeUndefined()
    })
  })
})
