# e2e/ — Playwright E2E Navigation

For global conventions and the E2E testing system, see the root [AGENTS.md](../AGENTS.md); for how to run and environment setup, see [docs/agent/e2e.md](../docs/agent/e2e.md).

This directory only supplements the root docs with **local file anchors**: which file to start from, what each entry point is responsible for, and what must not be touched.

## Where to start when writing/modifying tests

- **`tests/<domain>/<feature>.spec.ts`** — tests are organized by functional domain, one directory per domain, file name = the feature under test. When adding a test, put it in the right place first:
  - `admin/` (audit-logs / mcp-servers-group / users), `agents/` (provider-chain, memory, schedule-trigger, feishu-*, and other agent lifecycle tests), `artifacts/`, `auth/` (login), `pages/` (pure pages such as wiki), `runs/`, `scm-sources/`, `settings/` (public-base-url), `skills/`.
  - **`tests/smoke/`** is cross-cutting smoke testing: `api-health` / `critical-paths` / `crud-flows` / `observability`, verifying "service reachable + core paths work" without binding to specific data state. Cross-domain health/path assertions go here — don't stuff them into a single domain.
- **`live-check.spec.ts`** (at the root, not under `tests/`) is a single live smoke test against a **real running environment** (the ask-mode toggle on the agent creation page), with non-isolated data. Only touch it when adding a temporary "manual live verification" case; regular isolated cases always go into `tests/`.

## Preconditions you must know (don't trip over these)

- **`global-setup.ts`** runs once before all tests: waits for `/api/health` to be ready, then checks `/api/auth/status`; if `needSetup`, it calls `/api/auth/setup` with `E2E_ADMIN_PASSWORD` to create the admin. **Therefore all tests assume the admin can already log in** — do not set up the password yourself inside a test case, and do not depend on some pre-existing account; a missing `E2E_ADMIN_PASSWORD` throws immediately.
- **`fixtures/bin/`** = fake CLI executables `fake-claude.mjs` / `fake-codex.mjs`, injected by `scripts/e2e-dev-server.mjs` as `CLAUDE_CODE_PATH` / `CODEX_PATH` under `FAKE_PROVIDER_E2E`, so run/agent-related cases can pass and assert deterministic output without a real LLM. When testing provider/run behavior, change the output contract of these two fake CLIs instead of mocking the network.
- **`playwright.config.ts` (repo root)**: `testDir: ./e2e`, `baseURL` points to the web dev server (`WEB_PORT`, default 3501), `webServer` launches `scripts/e2e-dev-server.mjs` with `reuseExistingServer`. Currently there is only a single `chromium` project, with no separate isolated/in-place projects — all specs share the same environment.

## Page objects

- **`pages/base.page.ts`** is the page object base class scaffold (`sidebar`/`mainContent`/`brandTitle`, `navigateTo(name)`, `waitForLoad`). **There are currently no subclasses** — it is a reserved pattern; when consolidating reusable page navigation, prefer `extends BasePage` instead of repeatedly hardcoding `aside` / `#main-content` selectors in each spec.

## Hard constraints

- Navigation/menu copy must not be hardcoded — go through `utils/test-constants.ts`, aligned with `nav` in `apps/web/src/locales/zh.json` (route/copy changes must be synced).
- Each test case creates and cleans up its own data, without depending on state left by previous cases (the `smoke` cases already follow this).
