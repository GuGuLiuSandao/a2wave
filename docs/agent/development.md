# Development Setup

```bash
pnpm install          # install
cp .env.example .env  # required: leave AUTH_SECRET empty — pnpm dev generates one into .env
pnpm run dev          # API :3502 + Web :3501 (override with PORT / WEB_PORT in .env)
pnpm stop             # free the ports if a previous run left orphans
```

**Important**: During development, prefer the **Agents Team** approach to fully
leverage multi-agent collaboration and improve decomposition and parallel
execution of complex tasks.

## Database (SQLite or PostgreSQL, via Drizzle)

```bash
pnpm db:generate   # generate migration files
pnpm db:migrate    # run migrations (reads DATABASE_URL, applies the matching lineage)
```

The backend is selected by `DATABASE_URL` alone: a `postgres://` scheme means
PostgreSQL (≥ 9.6), anything else is a SQLite file path. **SQLite is the supported
default** — one container, no external dependency.

> ⚠️ **PostgreSQL is EXPERIMENTAL** and not yet recommended for production: it
> passes the full suite and an end-to-end smoke test, but has no production soak
> time, and there is **no SQLite → PostgreSQL data migration path**. It exists for
> multi-instance deployments, where a single SQLite file cannot be shared safely.
> The process prints a warning on boot when it is selected.

The two dialects keep **separate migration lineages** (`drizzle/` vs `drizzle-pg/`)
because the generated DDL differs and a fresh PostgreSQL database must not replay
~100 migrations of SQLite history. `schema.pg.ts` is **generated** from the SQLite
schema (`pnpm db:generate:pg`), never hand-edited — that is what stops the dialects
drifting. There is **no SQLite → PostgreSQL data migration tool**; pick the backend
at deploy time.

Three rules keep application code dialect-neutral:

1. Transactions go through `withTransaction` (`src/db/transaction.ts`) and never
   `db.transaction()` directly — better-sqlite3 rejects an async callback outright.
2. Result counts come from `.returning()`, never the driver-specific
   `changes`/`rowCount`.
3. JSON / LIKE / time-bucket queries go through the `dialect-runtime.ts` helpers.

Full guide: [postgresql.md](./postgresql.md). Detailed database operation rules:
[apps/api/AGENTS.md](../../apps/api/AGENTS.md).

## Git Worktree Conventions

All git worktrees of this repository live **inside the repo** under
`.claude/worktrees/` (already gitignored) — never as a sibling directory of the
repo:

```bash
# Create (branch name mirrors the worktree name)
git worktree add -b <branch> .claude/worktrees/<name> origin/main

# Clean up when done
git worktree remove .claude/worktrees/<name>
```

- **Path**: always `.claude/worktrees/<name>`; `<name>` should describe the task
  (e.g. `repo-maintenance-2026-07-23`, `e2e`, `fix-oauth-401`).
- **Base ref**: branch from `origin/main` (run `git fetch origin main` first), so
  the worktree is not polluted by local uncommitted state.
- **Cleanup**: remove with `git worktree remove` — never `rm -rf`, which strands a
  stale worktree admin entry (then requires `git worktree prune`).
- **Setup inside a worktree**: run `pnpm install` there (hooks re-wire via
  `prepare`).
- **Ports**: the main tree owns the default `3501` (Web) / `3502` (API); a worktree
  running dev/e2e in parallel must use the **agreed `WEB_PORT=3503` / `PORT=3504`**
  (all configs — vite/playwright/e2e constants — read these env vars). Never start
  a second server on 3501/3502 — see [e2e.md](./e2e.md).
- **Database**: `DATABASE_URL` defaults to the **relative** path
  `./data/a2wave.db`, so each worktree naturally gets its own isolated SQLite file.
  When copying `.env` into a worktree, never set an absolute `DATABASE_URL`
  pointing at the main tree's DB — two processes on one SQLite file (even with WAL)
  risks lock contention and cross-polluted test data.
- Consumers of this convention: isolated e2e runs ([e2e.md](./e2e.md)), MR reviews
  (`mr-review` skill), and any agent/tool-created worktree (e.g. Claude Code's
  worktree isolation, which defaults to this path).
