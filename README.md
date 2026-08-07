<div align="center">

<img src="apps/web/public/brand-icons/default.svg" alt="a2wave" width="72" height="72" />

# a2wave

**Turn the agent CLIs you already use into shared services your whole team can call.**

Describe an Agent in plain language, bind a model provider, publish it to Feishu,
Slack, Discord, an HTTP API, or a schedule. No flowcharts, no glue code.

[![CI](https://github.com/LilithGames/a2wave/actions/workflows/ci.yml/badge.svg)](https://github.com/LilithGames/a2wave/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[Core Concepts](./docs/core-concepts.md) · [Project Guide](./AGENTS.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

**English** | [简体中文](./README.zh-CN.md)

</div>

## What is a2wave?

a2wave turns the agent CLIs you already use — **Claude Code, Cursor Agent, OpenAI
Codex, and more** — into shared, governed services your whole team can reach from
Feishu, Slack, Discord, an HTTP API, or a scheduled trigger.

You describe an Agent in natural language, bind it to a model provider, extend it
with Skills and MCP servers, and publish it. a2wave handles the rest: credential
injection, run queueing, audit trails, permissions, and delivery to whichever
channel your colleagues actually live in.

**a2wave orchestrates; it does not execute.** There is no bundled LLM inference,
no sandbox runtime, and no drag-and-drop DAG editor — execution capability comes
from the underlying CLIs, and orchestration is written in natural language rather
than wired together in a flowchart. These boundaries are deliberate and enforced;
see the [Iron Rules](./AGENTS.md#product-identity--iron-rules).

### How it compares

|  | a2wave | Workflow builders (n8n, Dify, Flowise) | A bare agent CLI |
|---|---|---|---|
| **How logic is expressed** | Natural language | Nodes, edges, variable mapping | Natural language |
| **Who can run it** | Your whole team, via the channels they already use | Whoever opens the builder | Whoever has the terminal |
| **Model execution** | Your existing CLI + your credentials | Vendor-managed runtimes | Local only |
| **Governance** | Per-Agent permissions, audit trail, run queue | Varies | None |

a2wave is the right fit when your team already trusts a coding agent CLI and needs
to *share* it — with access control, an audit trail, and delivery into Feishu or
Slack — rather than rebuild its reasoning as a graph.

## Features

- 🤖 **Bring your own agent CLI** — Claude Code, Cursor Agent, OpenAI Codex,
  OpenCode, Qoder, Trae, Kimi, and Pi run as interchangeable execution engines.
  CLIs install on demand from a pinned, checksum-verified lockfile, so the base
  image stays small.
- 🌊 **Publish to multiple channels** — one Agent, reachable via HTTP API, Feishu,
  Slack, Discord, the A2A protocol, scheduled triggers, GitLab / GitHub repository
  triggers, and a first-party chat page.
- 🧩 **Extend by composition** — add capabilities through Skills and MCP servers
  (stdio / SSE / HTTP / proxy groups) instead of forking the platform.
- 🔗 **Agent-to-agent calls** — Agents reach other Agents over the A2A protocol,
  including agents hosted outside your deployment.
- 📚 **Persistent memory** — per-Agent memory with progressive disclosure, plus
  keyword, vector, and hybrid search.
- 🧪 **Built-in evaluation** — replay curated case sets against an Agent's current
  config, with a frozen provider/model/prompt snapshot for honest comparison.
- 📦 **Git & Perforce workspaces** — Agents operate on real checkouts, with
  isolated worktrees per evaluation run.
- 🔐 **Enterprise auth** — OIDC and SAML SSO, per-Agent owner/editor/viewer
  permissions, rate limiting, and an audit entry behind every write.

## Trust Model

a2wave is designed for **internal enterprise teams**, assuming that the people who
create Agents and the people who use them are **trusted colleagues acting in good
faith**.

This shapes the product's boundaries. Agents run CLIs with real capabilities
(filesystem access, shell execution, injected credentials) *by design*. The platform
deliberately does **not** sandbox authors from each other, nor defend against a
malicious insider crafting a hostile Agent. Its security controls — authentication,
per-Agent permissions, audit logging, rate limiting — enforce **accountability and
least privilege among cooperating teammates**, not containment of an adversary
already inside the trust boundary.

> [!IMPORTANT]
> If you plan to expose a2wave to untrusted users or run untrusted Agent
> configurations, that is out of scope for the current design — add your own
> isolation layer. Full statement: [SECURITY.md](./SECURITY.md).

## Quick Start (Docker)

```bash
# 1. Copy the environment template (no edits needed to get started)
cp .env.example .env

# 2. Build and start
docker compose up -d --build
```

After the service starts, visit **http://localhost:3502** — or the port you set as
`A2WAVE_HOST_PORT` in `.env`, which remaps the host side only (the container always
listens on 3502, because the image's `EXPOSE`, `PORT` default and `HEALTHCHECK` all
hardcode it).

> If `ADMIN_PASSWORD` is left empty, the first person to reach the setup page claims
> the admin account — no token required. Set `ADMIN_PASSWORD` in `.env` to initialize
> the admin during boot and close that window entirely.

> [!IMPORTANT]
> **On macOS**, add these to `.env` before starting. Docker Desktop does not share
> `/data`, and it reports bind mounts as root-owned — which the entrypoint refuses to
> adopt, so the container crash-loops without them.
>
> ```bash
> A2WAVE_WORKSPACE_DIR=$HOME/a2wave-workspace
> A2WAVE_RUN_AS_UID=10001
> A2WAVE_RUN_AS_GID=10001
> ```

Next: create an Agent, bind a model provider, and publish it to a channel. The
in-app user manual at `/wiki` walks through the first Agent end to end.

### Database Backend

The backend is selected by `DATABASE_URL` alone: a `postgres://` scheme means
PostgreSQL, anything else is a SQLite file path.

**SQLite (default, supported)** — nothing to configure. The commands above give
you one container with the database on a named volume.

**PostgreSQL ≥ 9.6 (experimental)** — set the URL in `.env` and start with the
`postgres` profile, which adds the bundled database container:

```bash
# PostgreSQL requires an explicit AUTH_SECRET — see the note below. Generate one
# and append it, rather than pasting the command itself as the value:
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "DATABASE_URL=postgres://a2wave:a2wave@postgres:5432/a2wave" >> .env

docker compose --profile postgres up -d
```

Migrations run automatically on boot and pick the matching lineage; the API
waits for the database healthcheck first, so a cold start is safe. The database
port is not published to the host — change `POSTGRES_PASSWORD` before using this
outside a local trial.

> [!IMPORTANT]
> `postgres` in that URL is the **compose service name**, which resolves only on
> the compose network. The same `.env` is read by host-run commands (`pnpm run
> dev`, `pnpm db:migrate`), so leaving the line uncommented points them at a
> hostname the host cannot resolve. To run a containerised PostgreSQL instance
> *and* a local SQLite one side by side, keep `DATABASE_URL` out of `.env` and
> pass it per command instead — see
> [docs/agent/postgresql.md](./docs/agent/postgresql.md#running-docker-postgresql-alongside-a-local-sqlite-instance).

Verify it came up on the right backend — the API prints an experimental-backend
warning at startup, and the tables land in PostgreSQL rather than a `.db` file:

```bash
docker compose logs a2wave | grep -i postgres
docker compose exec postgres psql -U a2wave -d a2wave -c '\dt'
```

> [!WARNING]
> PostgreSQL is **experimental** and not yet recommended for production: it
> passes the full suite and an end-to-end smoke test, but has no production soak
> time. There is **no SQLite → PostgreSQL data migration path** — switching
> starts from an empty database. It exists for multi-instance deployments, where
> a single SQLite file cannot be shared safely. Details, including the
> per-process cache caveats that matter when running replicas:
> [docs/agent/postgresql.md](./docs/agent/postgresql.md).

### Environment Variables

**Nothing is required for the default SQLite setup.** `cp .env.example .env` and go —
every variable below has a working default. Running more than one replica is the one
exception; see the note under `AUTH_SECRET`.

| Variable | Default | Description |
|------|------|------|
| `AUTH_SECRET` | auto-generated | Signing secret for sessions and tokens. Left empty, `pnpm dev` writes one into `.env` and the container persists one in its data volume, so restarts keep you logged in. Set it explicitly (`openssl rand -hex 32`) to control the value — an explicit secret is never overwritten. **Required when running more than one replica** (see below). |

> [!IMPORTANT]
> **Multi-replica deployments must set `AUTH_SECRET` explicitly, to the same value on every
> replica.** A generated secret is private to the instance that made it, so replicas would
> sign tokens the others reject and encrypt SSO settings the others cannot read. Because
> PostgreSQL is the multi-instance backend, the container refuses to start rather than
> generate one when `DATABASE_URL` points at PostgreSQL.

> **Provider API Keys** (`CURSOR_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) are **not**
> configured here — set them per Agent, on the Agent detail page → Environment Variables.

<details>
<summary><b>Optional variables</b> — auth, networking, and trusted-host allowlists</summary>



| Variable | Default | Description |
|------|--------|------|
| `A2WAVE_HOST_PORT` | `3502` | Host port the Docker deployment publishes on. Remaps the **host** side only — the container always listens on 3502 |
| `ADMIN_PASSWORD` | empty | Optional initial admin password, applied on first boot only and never overwritten. **Left empty, the first person to reach the setup page claims the admin account — no token guards it.** Set it if you cannot accept that window |
| `AUTH_SESSION_TTL_DAYS` | `1` | Login session lifetime (days) for browser cookies and API/CLI bearer tokens, range `1~365`; leaving it unset keeps the original 24-hour behavior |
| `CORS_ORIGIN` | `http://localhost:3501` | Frontend origin, when it is served from a **different** origin than the API (the dev two-port setup). It grants both cross-origin reads and cookie-authenticated writes. The single-container deployment serves the frontend from the API itself, so same-origin requests are always allowed and this needs no change |
| `TRUSTED_PROXY` | `false` | Trust `X-Forwarded-For` only when the direct TCP peer is allowlisted below |
| `TRUSTED_PROXY_ADDRESSES` | empty | Comma-separated exact proxy IPv4/IPv6 addresses or CIDRs; proxies must overwrite XFF or append each hop |
| `TRUSTED_IMPORT_HOSTS` | empty | Exact Agent-export DNS hostnames allowed to resolve to controlled enterprise-private addresses during URL import |
| `TRUSTED_MCP_HOSTS` | empty | Exact remote MCP DNS hostnames allowed to resolve to controlled enterprise-private addresses |
| `TRUSTED_A2A_ROUTE_HOSTS` | empty | Exact remote A2A DNS hostnames allowed as private-address exceptions when public-only mode is enabled |
| `SCM_WORKSPACES_ALLOWED_ROOTS` | empty | Comma-separated absolute roots approved for non-admin custom Git workspaces; the built-in `~/.a2wave/workspaces` root is always allowed |
| `ALLOW_PRIVATE_ROUTE_TARGETS` | `true` | Allow ordinary private/CGNAT/ULA remote A2A targets with per-hop validation and DNS pinning; set `false` for public-only mode (exact hostname exceptions remain available) |

> Adjusting `AUTH_SESSION_TTL_DAYS` only affects new logins / newly issued tokens; to immediately tighten already-issued tokens, combine it with logout, password change, or `tokenVersion` revocation.

</details>

<details>
<summary><b>SCM sources & settings overrides</b> — bootstrap Git/Perforce checkouts from env</summary>

#### P4 SCM Source (created automatically once all fields are filled in)

| Variable | Description |
|------|------|
| `SCM_P4_PORT` | P4 server address (Perforce native protocol, not HTTP). Plaintext: `host:1666`, SSL: `ssl:host:1666` |
| `SCM_P4_USER` | P4 username |
| `SCM_P4_PASSWD` | P4 password |
| `SCM_P4_CLIENT` | P4 Workspace name |
| `SCM_P4_DEPOT_PATH` | Depot path, e.g. `//depot/main/...` |
| `SCM_P4_LOCAL_PATH` | Local sync directory, defaults to `/app/data/p4-workspace` |
| `SCM_P4_AUTO_SYNC` | Whether to auto-sync, defaults to `true` |

#### Git SCM Source (created automatically once the URL is set)

| Variable | Description |
|------|------|
| `SCM_GIT_REPO_URL` | Repository address |
| `SCM_GIT_BRANCH` | Branch, defaults to `main` |
| `SCM_GIT_USERNAME` | Username (HTTPS authentication) |
| `SCM_GIT_PAT` | Personal Access Token |
| `SCM_GIT_LOCAL_PATH` | Local clone directory, defaults to `/app/data/git-workspace` |
| `SCM_GIT_AUTO_SYNC` | Whether to auto-sync, defaults to `true` |

#### Settings Override (optional)

| Variable | Description |
|------|------|
| `SETTINGS_GENERAL_WORKSPACE_PATH` | Workspace path |
| `SETTINGS_GENERAL_TIMEOUT_MINUTES` | Global timeout (minutes) |
| `SETTINGS_BRANDING_SUBTITLE` | Branding subtitle |
| `SETTINGS_BRANDING_FAVICON_URL` | Favicon address |

</details>

## Local Development

### Prerequisites

- Node.js >= 22 (matches the `node:22-slim` runtime in the Docker image)
- pnpm >= 9

```bash
pnpm install

# Create a local .env. Leave AUTH_SECRET empty — `pnpm dev` generates one
# into .env on first start.
cp .env.example .env

# Start frontend and backend together (API :3502 + Web :3501 by default;
# override with PORT / WEB_PORT in .env)
pnpm dev

# Free the ports if a previous run left orphaned servers behind
pnpm stop
```

For more development guides, API documentation, and database operations, see [AGENTS.md](./AGENTS.md).

For CLI installation, upgrade, and publishing workflows, see [CLI Installation & Publishing](./docs/agent/cli-install-publish.md).

## Channels

A published Agent can be reached through multiple channels: HTTP API, Feishu, Slack,
Discord, the A2A protocol, scheduled triggers, GitLab / GitHub repository triggers,
and the first-party chat page.

> The Feishu channel currently supports Feishu (feishu.cn) apps; Lark international
> (larksuite.com) is not configurable yet.

## Documentation

| Document | Contents |
|------|------|
| [Core Concepts](./docs/core-concepts.md) | Agent, Provider, Skill, MCP Server, SCM Source, Run, Evaluation |
| [Project Guide](./AGENTS.md) | Architecture, full API reference, testing strategy, conventions |
| [CLI Installation & Publishing](./docs/agent/cli-install-publish.md) | Installing, upgrading, and publishing the `a2wave` CLI |
| [Contributing](./CONTRIBUTING.md) | Dev setup, commit convention, quality gates, AI policy |
| [Security Policy](./SECURITY.md) | Trust model and vulnerability disclosure |

The running instance also serves an interactive API reference at `/api/docs`
(Swagger UI) and an in-app user manual at `/wiki`.

## Built with AI

a2wave is built extensively with AI coding agents — a fitting way to build a
platform that orchestrates them. Every change lands through a full test
pyramid (unit / integration / E2E), hard lint and typecheck gates, and human
review. AI-assisted contributions are held to the same bar; see the
[AI Contribution Policy](./CONTRIBUTING.md#ai-contribution-policy).

## Contributing

Issues, discussions and pull requests are welcome. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md) — it covers the development setup, the commit convention, the
quality gates a change must pass, and the AI contribution policy. Note that a2wave has explicit
product boundaries (the Iron Rules in [AGENTS.md](./AGENTS.md)); features that cross them need
maintainer discussion first. By participating you agree to the
[Code of Conduct](./CODE_OF_CONDUCT.md).

> [!WARNING]
> Please do **not** report security vulnerabilities through public issues or pull requests — follow
> [SECURITY.md](./SECURITY.md) to disclose privately.

## Contributors

Thanks to everyone who has contributed to a2wave!

<a href="https://github.com/LilithGames/a2wave/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=LilithGames/a2wave" alt="a2wave contributors" />
</a>

## License

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Lilith Games — see
[NOTICE](./NOTICE) for attribution and bundled third-party material.
