# Security Policy

a2wave is an enterprise-grade agent orchestration platform. Because it runs
authenticated workloads and injects credentials into agent subprocesses, we take
security reports seriously and appreciate responsible disclosure.

## Supported Versions

Security fixes are provided for the latest released minor version. Older versions
may receive fixes at the maintainers' discretion.

| Version | Supported          |
| ------- | ------------------ |
| 0.7.x   | :white_check_mark: |
| < 0.7   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use **GitHub Private Vulnerability Reporting** — open a report via the
**Security** tab of this repository (`Security` → `Report a vulnerability`). The
report stays private to you and the maintainers until an advisory is published.

Please include as much of the following as you can:

- The type of issue (e.g. authentication bypass, injection, SSRF, secret leakage).
- Affected component and version (API / Web / CLI).
- Step-by-step reproduction, proof-of-concept, or affected source paths.
- Impact assessment and any suggested remediation.

## What to Expect

- **Acknowledgement** within 3 business days.
- **Initial assessment** within 7 business days, including whether the report is
  accepted and an expected remediation timeline.
- We will keep you informed as we work on a fix and will credit you in the release
  notes unless you request otherwise.

## Trust Model & Threat Boundary

a2wave is built for **internal enterprise teams**, and its threat model assumes
that **Agent authors and Agent users are all trusted colleagues acting in good
faith** to do their work more efficiently. Agents run underlying CLIs with real
capabilities (filesystem, shell, injected credentials) by design; the platform
does not attempt to sandbox trusted authors against each other or to defend
against a malicious insider deliberately building a hostile Agent.

Security controls — authentication, per-Agent owner/editor/viewer permissions,
audit logging, rate limiting, per-run credential injection — exist to enforce
**accountability and least privilege among cooperating teammates**, not to contain
an adversary inside the trust boundary. Reports that assume a malicious
authenticated author, or that require running untrusted Agent configurations, fall
outside this model. Deployments that expose a2wave to untrusted users must add
their own isolation layer.

### Deployment isolation requirements

The environment-variable allowlist given to an Agent CLI limits normal inherited
process environment; it is **not an operating-system sandbox**. A CLI running as
the same OS user as the API may still be able to inspect readable process state,
the SQLite database, `.env`, logs, or persistent storage through the filesystem
and platform facilities such as `/proc` on Linux. Run untrusted or differently
trusted Agent configurations under a separate UID, container, or host with
appropriately scoped volumes. Do not rely on the subprocess environment filter as
the boundary between hostile tenants.

Likewise, DNS validation, redirect checks, and address pinning protect HTTP
connections initiated by a2wave itself. Third-party Agent CLIs are autonomous
executables and can initiate their own outbound connections. Deployments that
need network containment must apply host/container egress policy, network ACLs,
or a dedicated proxy to the Agent runtime.

## Scope

In-scope: authentication and authorization, credential/secret handling, the
gateway/OAuth/A2A invocation paths, agent subprocess isolation, and injection
vectors reachable through a normal deployment.

Out of scope: vulnerabilities in third-party agent CLIs (Claude Code, Cursor,
Codex, etc.) or in dependencies — please report those upstream — and issues that
require a pre-compromised host or privileged local access.

## Documented Design Decisions

These are intentional behaviors, called out so they are not re-filed as bugs:

- **Artifact downloads are public by default.** `GET /api/artifacts/:id/download`
  serves the artifact to anyone holding its unguessable `art_<cuid>` id, with no
  login, unless the `artifacts.requireAuthForDownload` setting is `true`. This is a
  deliberate shareable-link tradeoff for the trusted-internal-team model; the id is
  random and the storage path is traversal-guarded. Deployments with sensitive
  artifacts or broader exposure should enable that setting (Settings → Artifacts),
  which enforces owner/admin authorization on every download.

- **Log redaction is a backstop, not the primary control.** Call sites are expected
  not to log secrets; on top of that, the pino logger redacts known credential and
  PII field names (provider/gateway tokens, SCM `p4passwd`/`pat`, `A2WAVE_CHANNEL_B64`,
  auth headers, etc.) so an accidental `logger.info({ config })` does not leak. New
  secret-bearing field names must be added to the redact list in `apps/api/src/lib/logger.ts`.

- **Admin-only MCP access follows the runtime requester.** stdio and other
  admin-only MCP capabilities are injected only for Web/debug, direct Run, or
  evaluation work requested by a currently active administrator. Queued work
  stores the requester id and rechecks the live role when execution starts.
  Gateway, OAuth, A2A, native chat, and scheduled runs are never elevated because
  their Agent is admin-owned.

- **First-time setup is unauthenticated while the admin has no password.** When
  `ADMIN_PASSWORD` is empty, `POST /auth/setup` takes the new admin password and
  nothing else — whoever reaches an uninitialized instance first claims the admin
  account. This is a trade a2wave accepts deliberately: the earlier one-time log
  token cost a `docker compose logs` round trip on every deployment to guard a
  window lasting seconds. **Deployments that cannot tolerate that window set
  `ADMIN_PASSWORD`**, which initializes the admin during boot and closes it
  entirely — and any instance reachable from an untrusted network should.

  What is *not* relaxed is the other half — the endpoint shuts for good the
  moment a password exists, enforced by two independent guards: a per-request
  `isSetupRequired()` read (never a cached or boot-time value, or an instance
  that booted uninitialized would accept setup forever) and the conditional
  `UPDATE ... WHERE passwordHash IS NULL`, which is what actually decides a race
  between two concurrent requests that both pass the pre-flight TOCTOU check.

- **Agent import archives have compressed and expanded budgets.** Normal uploads
  remain under the global 10 MiB request limit; URL downloads are capped at 50
  MiB and 120 seconds. Before entries are parsed, written, or used in a database
  transaction, the original central-directory paths and declared entry metadata
  are checked against limits of 10,000 entries, 10 MiB per entry and per Skill,
  500 files per Skill, and 100 MiB total uncompressed data. ZIP64/multi-disk
  archives, unsafe or duplicate paths, and symlinks are rejected.

- **Remote A2A supports enterprise-private networks without disabling safe
  fetch.** `ALLOW_PRIVATE_ROUTE_TARGETS=true` is the default and admits ordinary
  private, CGNAT, and ULA targets. HTTP(S)-only validation, per-hop redirect and
  DNS checks, connection pinning, and response limits remain active. Loopback,
  link-local, multicast, unspecified, reserved, and cloud metadata addresses —
  including `169.254.169.254`, Alibaba Cloud `100.100.100.200`, AWS IPv6
  `fd00:ec2::254`, and decodable mapped/NAT64/6to4 forms — remain blocked. Set
  the switch to `false` for public-only mode; exact `TRUSTED_A2A_ROUTE_HOSTS`
  entries can then admit controlled private DNS exceptions without weakening
  the hard deny. Other trusted-host lists retain the same exact-host behavior.

- **MCP Group credential carriers are execution-scoped.** Building or diagnosing
  an Agent keeps the already-filtered Group configuration in process memory and
  creates no temporary credential file. Each worker attempt and each Group gets
  an unpredictable directory (`0700`) and exclusive config file (`0600`) only at
  execution start. The proxy unlinks it after reading, and worker `finally`
  cleanup covers success, failure, cancellation, timeout, startup errors, retry,
  and Provider fallback. On startup, an upgrade cleanup also unlinks legacy
  deterministic carriers only for validated Group IDs present in the current
  database; it never scans or recursively removes temporary paths. These controls
  remove cross-run sharing and persistent residue; they are not an OS sandbox
  against another hostile process running as the same UID (see Deployment
  isolation requirements).

## Known Dependency Audit Exception

`pnpm audit --prod` currently reports
[GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2)
for React Router 7.18.2. The advisory explicitly affects only the unstable React
Server Components (RSC) APIs. a2wave is a Vite client-side SPA using
`createBrowserRouter`/`RouterProvider` and contains no RSC imports or server-action
handler, so the vulnerable path is not reachable.

The first patched release is React Router 8.3.0, which requires Node >=22.22 and
React/React DOM >=19.2.7; this repository supports Node >=22, and a matching
`react-router-dom` 8.3.0 package is not currently published. Forcing that upgrade
would break the supported runtime and routing package contract. Re-evaluate this
exception when a compatible patched 7.x release or complete 8.x DOM-router stack
is available. The production audit was revalidated on 2026-08-04 after upgrading
Hono to 4.12.34, Undici to 6.28.0 and 7.29.0, fast-uri to 3.1.5, and ip-address
to 10.3.1.

Revalidated on 2026-08-07: `pnpm audit --prod` reports no critical, moderate, or
low advisories and only this single known, unreachable high-severity advisory.
The same run also surfaced
[GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj)
(quadratic CPU consumption resolving `!!omap`) against js-yaml 3.15.0, reached
through `gray-matter`, which parses the YAML frontmatter of uploaded and remote
Skills. That one is **not** an exception — it was fixed by tightening the root
`pnpm.overrides` entry to `js-yaml@>=3.0.0 <3.15.1` → `>=3.15.1 <4`. The prior
selector stopped at `<3.15.0` and so pinned the tree to exactly 3.15.0, the
lowest still-affected version.

The command is therefore expected to exit non-zero until the React Router
exception can be removed. The a2wave maintainers own that exception and will
review it again by 2026-09-04, or sooner if a compatible patched 7.x release or a
complete 8.x DOM router stack becomes available.
