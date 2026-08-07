# E2E Testing — Playwright

> Test entry: [`e2e/`](../../e2e/); config: [`playwright.config.ts`](../../playwright.config.ts). For run commands see [AGENTS.md#test-commands](../../AGENTS.md#test-commands).

## Preparation (required)

Playwright's browsers are downloaded per machine, not vendored in the repo, so a
fresh clone needs them once before any spec can run:

```bash
npx playwright install chromium
```

Skipping this fails at browser launch, not at a test assertion. A machine that
has run Playwright for another project already has the shared
`~/.cache/ms-playwright` (macOS: `~/Library/Caches/ms-playwright`) and will pass
without it — which is exactly why the gap is easy to miss locally.

E2E depends on the `E2E_ADMIN_PASSWORD` environment variable. On startup, `playwright.config.ts` **automatically loads the `.env` at the repo root** (a zero-dependency built-in parser, no dotenv), so before running `npx playwright test` / `pnpm test:e2e` **there is no need to manually `source`** — as long as `.env` has `E2E_ADMIN_PASSWORD`. A same-named variable already present on the command line takes higher priority (`E2E_ADMIN_PASSWORD=xxx pnpm test:e2e` can still override temporarily).

```bash
# First time: copy a local .env from the template (already in .gitignore, won't be committed)
cp .env.example .env

# AUTH_SECRET can stay empty: `pnpm dev` and the Isolated-mode webServer both generate one
# into .env on first start. Set it explicitly (openssl rand -hex 32) only to pin the value —
# an explicit secret is never overwritten. Starting the API directly (without `pnpm dev`)
# still requires one, since nothing has generated it yet.

# The default password E2eTest123@ is written in .env.example; if you have changed the admin password, sync it in .env
```

> 💡 Only when you want to also run `pnpm run dev` in the **same shell** (In-place mode reusing the dev server), or need to override `WEB_PORT`/`PORT` in the shell, do you need `set -a; source .env; set +a` to import the variables into the current shell too. Running e2e alone no longer requires this.

> ⚠️ **Never `git add .env`**. `.env` is already in `.gitignore`, but when adding files like `.env.local` / `.env.xxx`, also confirm they don't get committed.

## Two ways to run

| Mode | Use case | Data/env isolation | First-startup cost |
|---|---|---|---|
| **In-place** | Daily quick regression, smoke tests after UI-only changes | ❌ Shares dev DB / ports / server env | 0 (reuses dev server) |
| **Isolated** | Before release, CI, changing auth/permission/rate-limit paths | ✅ Independent SQLite / strict auth | Requires stopping the dev server so playwright can self-start |

> **Worktree is not required**, but if you want the same machine to keep doing dev and also run clean e2e, you can run in parallel in a worktree with **different ports**.

### In-place: reuse the current dev server

Prerequisite: `pnpm run dev` is already running on 3501/3502 (or the ports you override via `WEB_PORT`/`PORT`), and `.env` is sourced. A fresh database must be initialized before the suite logs in. `globalSetup` initializes it automatically — first-time setup takes no bootstrap credential, so nothing has to be copied out of the API logs:

```bash
npx playwright test
```

The `reuseExistingServer: true` in `playwright.config.ts` hits these two ports directly and won't restart the server. If the reused API is unreachable, its status endpoint fails, or first-time setup is rejected, global setup fails immediately with that cause instead of cascading into per-test login failures.

### Provider CLI strategy

Playwright's isolated mode uses deterministic fake Claude and Codex CLIs by default. This keeps the standard suite independent of local login state and makes usage/lifecycle assertions reproducible.

Set `A2WAVE_FAKE_PROVIDER_E2E=0` to intentionally exercise locally installed real CLIs. Real Claude Code cases default to `--model claude-sonnet-4-6`, overridable with `E2E_CLAUDE_MODEL`; real Codex cases default to `--model gpt-5.3-codex`, overridable with `E2E_CODEX_MODEL`.

```bash
A2WAVE_FAKE_PROVIDER_E2E=0 pnpm test:e2e -- e2e/tests/agents/feishu-command-lifecycle.spec.ts
```

Real-CLI execution remains the final acceptance basis for Provider compatibility; the fake path is the deterministic product regression suite.

**Known pitfalls**:

1. **Dev DB gets polluted** — smoke tests really create agents / MCP / runs, and after running you'll see `smoke-agent-*` / `e2e-smoke-*` leftovers on the dev pages. Clean up manually with SQL, or switch to Isolated mode.
2. **Auth behaves for real in dev** — the historical dev-bypass of [`authMiddleware`](../../apps/api/src/middleware/auth-middleware.ts:15) required `AUTH_SECRET` to equal the old default `dev-secret-change-me`; that value is now rejected outright, and `pnpm dev` generates a random secret when none is set, so the bypass is no longer reachable and every request goes through real JWT validation. `401`-type tests therefore behave the same In-place as in Isolated mode.
3. **Login rate limit 30/min** — the e2e utils [`e2e/utils/api-helpers.ts`](../../e2e/utils/api-helpers.ts) and [`e2e/utils/auth.ts`](../../e2e/utils/auth.ts) both do worker-level promise caching; new util functions that acquire tokens must cache likewise, otherwise running in parallel will hit 429.

### Isolated: let playwright start the server itself

Prerequisite: 3501/3502 are **not** running.

```bash
# Stop the dev server
pnpm stop

# Run e2e (playwright webServer uses scripts/e2e-dev-server.mjs to start a dev with E2E_STRICT_AUTH=1, and auto-sets up the admin password)
# .env is auto-loaded by playwright.config.ts, no manual source needed
npx playwright test
```

See the script at [`scripts/e2e-dev-server.mjs`](../../scripts/e2e-dev-server.mjs). After startup it will:

- Poll `/api/health` + web readiness
- Create a fresh temporary SQLite database and remove it when the server exits
- Initialize the fresh admin during API boot with `ADMIN_PASSWORD=E2E_ADMIN_PASSWORD`; if that invariant fails, abort before the test suite starts
- Pass `E2E_STRICT_AUTH=1` through to the api to guarantee strict auth behavior

### Isolated + Worktree (recommended: parallel without affecting the main directory's dev)

If the main directory's `pnpm run dev` is running on 3501/3502 and you also want to run clean e2e in a worktree, use the **agreed 3503/3504** ports:

- Web (Vite) = `WEB_PORT=3503`
- API (Hono) = `PORT=3504`

`vite.config.ts`, `playwright.config.ts`, `scripts/e2e-dev-server.mjs`, `e2e/utils/test-constants.ts` (and all `API_BASE`/`WEB_BASE` in specs) have all been changed to read these two environment variables, defaulting to fallback 3501/3502.

```bash
# 1) Create a worktree from the main directory
git worktree add .claude/worktrees/e2e

# 2) Enter the worktree, install deps, copy .env and override the ports
cd .claude/worktrees/e2e
pnpm install
cp ../../../.env .env
cat >> .env <<'EOF'
WEB_PORT=3503
PORT=3504
EOF
set -a; source .env; set +a

# 3) Run e2e (playwright webServer self-starts dev on 3503/3504, won't touch the main directory's 3501/3502)
npx playwright test
```

Clean up when done:

```bash
cd -
git worktree remove .claude/worktrees/e2e
```

## Failure Troubleshooting

| Symptom | Possible cause | Handling |
|---|---|---|
| Lots of `Login failed: 429` | Login rate limit | Wait 60s; or merge multiple login calls; add promise caching to new util functions |
| Server refuses to start: `AUTH_SECRET is required` | The API was started directly instead of through `pnpm dev`, so nothing generated a secret | Start via `pnpm dev` (it writes one into `.env`), or set `AUTH_SECRET` yourself (`openssl rand -hex 32`) |
| `dialog.getByPlaceholder(...)` timeout | The UI structure of the corresponding page changed | Open `test-results/<name>/error-context.md` to view the snapshot, and update the selector accordingly |
| webServer startup fails with `E2E_ADMIN_PASSWORD required` | `.env` is missing that key, or it's overridden by an empty value | Confirm `.env` has `E2E_ADMIN_PASSWORD` (config auto-loads it); or rerun with the `E2E_ADMIN_PASSWORD=xxx` temporary prefix |
| Port in use | The main directory's dev server isn't stopped | Switch to In-place mode, or worktree + 3503/3504 |
| Worktree still hits 3501/3502 | `WEB_PORT`/`PORT` didn't reach the current shell | `set -a; source .env; set +a` to re-import |

## Onboarding E2E (fresh-clone first-run flow)

Separate from the Playwright suite, [`scripts/e2e/onboarding.sh`](../../scripts/e2e/onboarding.sh) verifies the sequence README.md promises a newcomer, against a **genuinely fresh clone**:

```bash
pnpm test:e2e:onboarding
```

```
git clone → pnpm install → cp .env.example .env → pnpm dev
  → /api/health 200 → web dev server 200 → /api/health/ready = ready
  → first-time setup claims admin (no token) → login → authenticated /api/auth/me
```

Why it is not a Playwright spec: Playwright's `webServer` assumes an already-installed repo, and this flow's whole subject is *starting from nothing*. It reuses the bash harness style of `restart-recovery.sh` instead, with helpers in [`scripts/e2e/lib/onboarding.sh`](../../scripts/e2e/lib/onboarding.sh).

**What it catches that no other test can.** Every assertion here is invisible from a working tree set up months ago:

- `packages/shared/dist` is gitignored — a fresh clone has none, so `pnpm dev`'s pre-build step is genuinely exercised
- `.env.example` ships `AUTH_SECRET=` empty and `pnpm dev` must generate one into `.env` (asserted: present, ≥32 chars). This regressed once before
- migrations must create the schema on a database file that did not exist a moment ago
- `pnpm dev` must release both ports on SIGTERM, rather than orphaning vite/tsx grandchildren

**Isolation.** It clones to a `mktemp` directory and allocates two random ports in `34000-34999`, deliberately clear of the `3501/3502` dev pair and the `3503/3504` worktree pair, so it is safe to run while `pnpm dev` is up. The ambient `AUTH_SECRET` / `DATABASE_URL` are unset before `pnpm dev` starts, so the developer's own shell cannot mask a missing-secret regression.

| Environment | Effect |
|---|---|
| `ONBOARDING_CLONE_URL` | Clone source. Defaults to `file://<repo root>` — the local HEAD, i.e. the commit about to be merged. Point it at `https://github.com/LilithGames/a2wave.git` to rehearse published `main` |
| `ONBOARDING_KEEP=1` | Keep the temp clone after the run instead of deleting it |

Runtime is several minutes (`pnpm install` plus the first vite/tsup build dominate), so it is **not** part of `pnpm test` or the git hooks — run it before a release, and after changing `.env.example`, `scripts/dev.mjs`, the install/build wiring, or the README's Local Development section.

## Test Data Conventions

- Each test carries a timestamp suffix (`smoke-agent-${Date.now()}`) to avoid conflicts
- Resources created must be cleaned up via API at the end of the same test (see the cleanup pattern in `e2e/tests/smoke/crud-flows.spec.ts`)
- Must not depend on data left by other tests / execution order
