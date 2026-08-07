# Changelog

All notable changes to this project are documented in this file.

## v0.7.1

First public release, shipping the `a2wave` CLI to npm and multi-arch container images to GHCR.

- **Agent orchestration platform**: create, configure and orchestrate Agents in natural language. Execution capability comes from the underlying Agent CLIs (Cursor Agent / Claude Code / Codex); the platform does not intervene in an Agent's runtime decisions.
- **Publish Agents over many channels**: API, Feishu, Slack, Discord, A2A, schedules, a built-in chat page, and GitLab / GitHub repository triggers — repository triggers start a run only when a watched merge/pull request actually moves, instead of polling unconditionally.
- **Extend through Skills and MCP Servers**: compose Agent capability from Skills and MCP Servers (stdio / sse / http / group). A Skill is creator-private by default; an administrator may publish it to all users.
- **Providers and model discovery**: models are probed per bound credential rather than kept as a static catalog that drifts from what the account can actually run.
- **Agent CLIs installed at runtime**: the image preinstalls no Agent CLI. They are installed on demand from `provider-cli-lock.json` with pinned versions and SHA-256 verification, cutting over 1GB from the image; installation state is always probed from `PATH`, never trusted from the database.
- **Evaluation**: replay Case sets against an Agent's current configuration, freezing a provider / model / prompt snapshot for comparison across versions. The evaluation queue is isolated from the run queue, so a large evaluation cannot starve interactive chat.
- **Knowledge bases and workspaces**: connect Git and Perforce sources; runs and evaluations execute in isolated workspaces.
- **Enterprise capabilities**: password and SSO login, per-Agent owner / editor / viewer permissions, audit logging, rate limiting, and health/readiness probes.
- **Database backends**: SQLite single-file deployment by default. PostgreSQL is experimental, aimed at multi-instance deployments, not yet recommended for production, and has no SQLite → PostgreSQL data migration path.
- **In-app user manual**: a manual at `/wiki`, with a bilingual (Chinese / English) interface.
- **Documentation and CI**: streamlined README with configuration extracted into its own reference; the dependency license inventory check is now host-independent, and secret scanning uses the repository's own ruleset.
