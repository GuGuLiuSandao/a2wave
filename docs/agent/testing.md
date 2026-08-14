# Testing

**All tests must pass before a feature is done or anything lands on main.**
Per-app test conventions, commands and coverage rules live in each app's own
`AGENTS.md`; E2E layout and fixtures in [e2e/AGENTS.md](../../e2e/AGENTS.md); E2E
environment prep and troubleshooting in [e2e.md](./e2e.md). CI pipeline, hooks and
architecture rules: [ci-pipeline.md](./ci-pipeline.md).

## TDD is mandatory

Red (failing test stating the expected behavior) → Green (minimum code to pass) →
Refactor.

- **Production code not validated by a failing test must never be committed.**
- Bug fix ⇒ regression test reproducing the bug.
- New route or page ⇒ ships with E2E.
- New utility / pure function / React hook ⇒ unit test required. New API route ⇒
  integration test required. Route or navigation change ⇒ E2E required.

## Gates — non-negotiable, `--no-verify` forbidden

| Gate | Command | Bar |
|------|------|------|
| Lint | `pnpm lint` | 0 errors. Warnings are debt; an MR must add none |
| Typecheck | `pnpm typecheck` | Fully green, **test files included** — type drift with nobody running tsc is how tests rot. Use the root script, not bare `pnpm -r typecheck`: it builds `@a2wave/shared` first, which every app resolves through its gitignored build output |
| Test | `pnpm test` | All pass; changed code ships with tests |
| E2E (recovery / task-queue / Feishu paths) | `bash scripts/e2e/restart-recovery.sh` | 4/4 scenarios |

Never mask a pre-existing typecheck error with `@ts-ignore` / `@ts-nocheck`; if one
is coupled to your change, fix it.

## Coverage is advisory

Code coverage is **advisory**, not a merge gate. `pnpm test:coverage` remains
available for targeted review, but CI does not enforce a repository-wide
percentage: observable behavior and regression tests are the required bar. This
does not relax the TDD or changed-code testing requirements above.

### Thresholds

Defined per app in `vitest.config.ts`: api 82/77/74/81, web 48/35/43/46, cli
80/82/72/78 (lines/functions/branches/statements).

Thresholds are a **ratchet against regression**, set just under measured coverage —
not a target to aim down to. Raise them as tests land; **never lower one to make a
red run green**. New modules aim for 80%+ lines. Enforced only in coverage mode, so
`pnpm test:coverage` checks them and the plain CI runs do not — run it locally
before pushing.

## E2E does not gate a PR

Lint, typecheck and test gate every PR in CI. **E2E does not gate a PR** —
Playwright needs web + api running together, which would several-fold the
~2-minute pipeline the merge gate is built around. It runs instead in
`post-merge.yml`, a scheduled workflow that is **not** a required check: a red run
tells the maintainer main needs attention, it does not block merges. Keep running
`pnpm test:all` locally before pushing — the daily run is a backstop, not a
substitute, and it reports a break a day late and possibly several commits wide.

**Onboarding E2E** (`pnpm test:e2e:onboarding`) is not a per-MR gate — it clones,
installs and boots from scratch, so it costs minutes. It runs weekly in
`post-merge.yml`; run it by hand as well before a release, and whenever a change
touches `.env.example`, `scripts/dev.mjs`, the install/build wiring, or the
README's Local Development section: it is the only test that sees what a newcomer
sees, since a resident working tree already has the `node_modules`,
`packages/shared/dist` and `.env` a fresh clone lacks. Details:
[e2e.md](./e2e.md#onboarding-e2e-fresh-clone-first-run-flow).

## Shared test utilities

`apps/api/src/test/` (barrel: `index.ts`) — `factories.ts` builds entities,
`mock-db.ts` mocks the Drizzle chain, `test-app.ts` builds a Hono app with mock
auth. **Unit tests never connect to a real DB.**

`apps/web/src/test/` — `setup.ts` (DOM globals), `render.tsx`
(`renderWithProviders()` wrapping QueryClient + Router + i18n).

`e2e/utils/` — `auth.ts` (`loginAsAdmin()`, promise-cached so parallel specs do not
trip rate limiting), `api-helpers.ts`, `test-constants.ts`.

**Mock policy**: external SDKs (Feishu, Anthropic) **must** be mocked; time via
`vi.useFakeTimers()`; `createId()` mocked to deterministic ids; `logger` mocked.
Tests live in `__tests__/` beside the source, named `<source>.test.ts(x)`.
