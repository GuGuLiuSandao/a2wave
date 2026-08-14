# Changelog

All notable changes to this project are documented in this file.

## v0.7.3-rc.1

> 🚧 **Release candidate.** Feature-complete and green on the full suite, but with no
> production soak time. It is published as a GitHub pre-release, so the `Latest` badge
> stays on the newest stable version; the Docker `latest` tag does not move to it either.
> Pull `ghcr.io/lilithgames/a2wave:0.7.3-rc.1` or install the exact npm version
> explicitly. Try it in a staging environment and report back; the stable cut will ship
> as `v0.7.3`.

> ⚠️ **This release is not rolling-upgrade safe. Stop every API replica before
> applying its migrations, then start only the upgraded version.** Two
> independent reasons, either sufficient on its own, and both fail silently:
>
> 1. A pre-upgrade replica deletes workspace-removal reservations by id alone,
>    erasing the newer attempt-token fence.
> 2. A pre-upgrade replica writes no `instance_heartbeats` row, so an upgraded
>    peer reads it as dead and may reclaim leases and Git worktrees out from
>    under a process that is still running.
>
> Single-container SQLite deployments are unaffected in practice — there is only
> one replica — but the migrations still apply.

- **Managed SCM storage for Git sources**: `localPath` is now optional for Git and allocated under the managed storage root; P4 still requires an explicit path covered by its client `Root`. Existing bind mounts, source paths and legacy worktree roots survive the upgrade.
- **Cross-replica workspace recovery**: a crashed or unreachable replica no longer strands its checkouts. Processes publish a liveness heartbeat, and a surviving replica settles the abandoned workload, releases its lease, and converges the leftover worktree removal — work that previously required an operator to run SQL by hand. An instance that cannot renew its own heartbeat stops itself before peers may reclaim its workspaces.
- **PostgreSQL deployment path**: `a2wave setup` can provision a PostgreSQL 16 sidecar or point at an external server. Still experimental and not recommended for production; there is no SQLite → PostgreSQL data migration.
- **Invitation links replace admin-set passwords**: administrators issue an expiring single-use link instead of typing someone else's password, and the invitee chooses their own and lands signed in. Links are copyable and revocable from the invitations drawer, and re-inviting an address supersedes the outstanding link so only one is ever live.
- **Git SCM Agents no longer share a working directory**: each Agent runs in its own worktree, where previously a run of one Agent could delete files a concurrent run of another was executing against. A worktree with unmerged agent commits or local modifications stays pinned (with a warning) and resumes following the source branch once that work lands upstream.
- **GitLab triggers can watch an entire group**: name a namespace instead of enumerating repositories, and newly created repositories are picked up with no config edit.
- **The CLI is now an agent-first entry point**: commands and output are shaped for a local Agent to drive directly, rather than for hand-typing.
- **The agent's Publish tab is now Channels**: a more accurate name for what it manages — API, Feishu, Slack, schedules, repository triggers and the rest.
- **A2A calls preserve caller provenance across hops**: run records show the full `user · calling Agent · source` chain even after a remote multi-hop invocation.
- **Chat and run recovery fixes**: restored chats accept follow-ups again, run state recovers and refreshes correctly after a server restart, and interrupted A2A remote tasks are resumable.
- **Feishu and Slack no longer process a message twice**: deduplication keys on the message's own identity rather than the delivery envelope, so one message starts one run.
- **Windows fixes**: Codex multiline prompts are preserved, and CLI status probes work.
- **Credentials survive an edit**: saving a form no longer persists the masked placeholder over the real secret.

## v0.7.2

- **`a2wave setup` now works with no flags**: `--image` is optional and defaults to the published image matching the CLI's own version (`ghcr.io/lilithgames/a2wave:<cli-version>`), so `npm i -g a2wave && a2wave setup` installs a running platform without cloning or building anything. Pass the flag only for a locally built or mirrored image.
- **`a2wave setup --upgrade` picks up the same default**: `a2wave update` followed by `a2wave setup --upgrade` moves an existing install to the matching release without retyping the image ref.
- **The container image is now public**: `ghcr.io/lilithgames/a2wave` can be pulled anonymously (tags `<version>` and `latest`); the READMEs document the CLI quick start and the direct `docker pull` path.

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
