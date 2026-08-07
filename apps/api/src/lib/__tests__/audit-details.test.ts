import { describe, expect, it } from 'vitest'
import { scmSourceAuditDetails } from '../audit-details.js'

describe('scmSourceAuditDetails', () => {
  it('records the name, type and paths an auditor needs to identify the source', async () => {
    const details = scmSourceAuditDetails({
      name: 'monorepo',
      type: 'git',
      localPath: '/srv/checkouts/monorepo',
      config: { type: 'git', repoUrl: 'https://github.com/acme/monorepo.git', branch: 'main' },
    })

    expect(details).toMatchObject({
      name: 'monorepo',
      type: 'git',
      localPath: '/srv/checkouts/monorepo',
    })
    expect(JSON.stringify(details)).toContain('github.com/acme/monorepo.git')
  })

  it('strips the PAT from a git config', async () => {
    const details = scmSourceAuditDetails({
      name: 'monorepo',
      type: 'git',
      localPath: '/srv/monorepo',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/acme/monorepo.git',
        pat: 'ghp_supersecrettoken',
      },
    })

    const serialised = JSON.stringify(details)
    expect(serialised).not.toContain('ghp_supersecrettoken')
    // The repo address itself must survive — identifying the source is the point.
    expect(serialised).toContain('github.com/acme/monorepo.git')
  })

  it('strips credentials embedded in a repo URL userinfo', async () => {
    const details = scmSourceAuditDetails({
      name: 'monorepo',
      type: 'git',
      localPath: '/srv/monorepo',
      config: { type: 'git', repoUrl: 'https://user:hunter2@gitlab.example.com/acme/monorepo.git' },
    })

    const serialised = JSON.stringify(details)
    expect(serialised).not.toContain('hunter2')
    expect(serialised).toContain('gitlab.example.com/acme/monorepo.git')
  })

  it('strips the p4 password', async () => {
    const details = scmSourceAuditDetails({
      name: 'depot',
      type: 'p4',
      localPath: '/srv/depot',
      config: {
        type: 'p4',
        p4port: 'perforce:1666',
        p4user: 'builder',
        p4passwd: 'topsecret',
        p4Path: '//depot/main/...',
      },
    })

    const serialised = JSON.stringify(details)
    expect(serialised).not.toContain('topsecret')
    expect(serialised).toContain('perforce:1666')
  })

  it('tolerates a missing config rather than throwing mid-request', async () => {
    // An audit write must never be the thing that fails a route.
    expect(() =>
      scmSourceAuditDetails({ name: 'x', type: 'git', localPath: '/srv/x', config: undefined }),
    ).not.toThrow()
  })
})
