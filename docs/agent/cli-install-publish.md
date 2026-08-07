# a2wave CLI Installation and Publishing

This document describes the installation, upgrade, and maintainer publishing flow for the a2wave CLI.

## Package Info

| Item | Value |
|---|---|
| npm package name | `a2wave` |
| Command name | `a2wave` |
| Registry | The public npm registry (`https://registry.npmjs.org`) |
| Companion Skill | `a2wave-cli` (source files in `skills/a2wave-cli/`) |
| CI Tag trigger | `vX.Y.Z` |

The platform and the CLI share **one version line**: `package.json` and `apps/cli/package.json` always carry the same version, and a single `vX.Y.Z` tag drives the Release, the Docker image, and the npm publish. There is no separate `cli-v*` tag.

The CLI package publishes the `dist/` build output together with its dedicated `README.md`, Apache `LICENSE`, and `NOTICE`. The publish workflow uses `npm pack --dry-run` to require those distribution files while forbidding `src/` / tests / coverage / `scripts/` from being packaged.

> The package deliberately does **not** set `publishConfig.registry`. That field takes precedence over both `npm publish --registry` and the registry `actions/setup-node` writes into the runner's `.npmrc`, so pinning one would silently redirect every release. A regression test in `apps/cli/src/__tests__/package.test.ts` enforces its absence.

---

## User Installation

Install from the public npm registry (no extra configuration needed):

```bash
npm i -g a2wave
```


If your organization fronts npm with a private/mirror registry, point npm at it in the usual way:

```bash
npm i -g a2wave --registry https://npm-mirror.example.com
```

Verify:

```bash
a2wave --version
a2wave status
```

Upgrade (either works):

```bash
a2wave update
# or
npm i -g a2wave@latest
```

`a2wave update` checks the latest published version and upgrades in place. It queries the npm default registry unless `$A2WAVE_NPM_REGISTRY` is set:

```bash
A2WAVE_NPM_REGISTRY=https://npm-mirror.example.com a2wave update
```

### `a2wave update` vs `a2wave setup --upgrade`

Two different things are called "upgrade"; they are not interchangeable:

| Target | Command | Effect |
|---|---|---|
| The **CLI binary** on your machine | `a2wave update` | Upgrades the `a2wave` npm package in place |
| The **platform** (the dockerized server) | `a2wave setup --upgrade --image <ref>` | Moves an existing install to a new container image, in place |

```bash
a2wave setup --upgrade --image a2wave:1.4.0            # default install dir (~/a2wave)
a2wave setup --upgrade --image a2wave:1.4.0 --dir /srv/a2wave
```

`--upgrade` is the supported path for moving an install to a new image — do **not** hand-edit the generated `docker-compose.yml`. It rewrites only the `A2WAVE_IMAGE` key in `.env` (the compose file reads the image through that variable), snapshots the data volume to a tarball in the install directory first, then pulls and recreates only the a2wave service and waits for both `/api/health` and `/api/health/ready`. It never passes `-v` to compose and never touches the rest of `.env`, so the data volume, `AUTH_SECRET` and `COMPOSE_PROJECT_NAME` all survive. On a failed start or health check the previous image is restored in `.env`, brought back up, and health-verified before the rollback is reported as successful. (The compose file is deliberately left on the variable form — it reads the image from `.env`, so restoring that value is what actually reverts the image.)

---

## Maintainer Release

### Recommended path: tag triggers the CI release

Push a `vX.Y.Z` tag → the **CLI Publish** workflow (`.github/workflows/cli-publish.yml`) runs → publishes to npm. The same tag also drives the **Release** and **Docker** workflows, so one tag cuts the whole release.

#### Prerequisites (one-time)

| Item | Notes |
|---|---|
| Repository secret `NPM_TOKEN` | An npm **automation** token with publish rights on `a2wave` |
| Workflow permissions | `contents: write` (Release) + `id-token: write` (provenance); already declared in the workflow |

#### Release steps

Prerequisites: on the main branch, clean working tree, local in sync with origin/main (`git pull --ff-only`).

```bash
# 1. bump BOTH manifests to the same version — they share one version line
#    (don't let npm version auto commit/tag)
npm version 0.7.1 --no-git-tag-version
cd apps/cli && npm version 0.7.1 --no-git-tag-version && cd ../..

# 2. Prepend a section at the top of the repo-root CHANGELOG.md (follow the existing format):
#    ## v0.7.1
#    - Change summary 1
#    - Change summary 2

# 3. commit + push to main
git add package.json apps/cli/package.json CHANGELOG.md
git commit -m "chore: release v0.7.1"
git push origin main

# 4. create tag + push tag → trigger CI
git tag v0.7.1
git push origin v0.7.1
```

`bash apps/cli/scripts/tag-release.sh 0.7.1` performs step 4 with safety checks (both manifests agree / main branch / clean tree / local in sync / tag absent on the remote).

#### Verification

```bash
# Workflow progress
gh run list --workflow "CLI Publish"

# Check the new version on the registry
npm view a2wave versions --json

# The GitHub Release is created by the Release workflow from the same tag
gh release list | head
```

The publish job runs in order: `pnpm install --ignore-scripts --filter a2wave...` → **typecheck** → **test** → `build` → **pack-contents validation** → `npm publish --provenance --access public`. The GitHub Release itself is created by the separate Release workflow, which the same tag triggers. The gates run before publish because `npm publish` is irreversible — a bad version can only be deprecated, never replaced. If any step fails the workflow turns red and nothing is published (npm publish is atomic).

If this change touches CLI commands, authentication, YAML apply, Run logs, or the troubleshooting flow, also sync `skills/a2wave-cli/`.

---

### Fallback path: local manual publish

Use only when CI is unavailable and you need a hotfix.

```bash
# First time or token expired
npm login
npm whoami       # verify

# bump → commit (as above), then run the same gates CI runs
pnpm --filter a2wave typecheck
pnpm --filter a2wave test
pnpm --filter a2wave build
cd apps/cli && npm pack --dry-run   # confirm dist/ plus README, LICENSE, and NOTICE
npm publish --access public
```

⚠️ Manual publishing **does not create a tag or a GitHub Release**; do it afterward:

```bash
git tag v0.7.1 && git push origin v0.7.1
gh release create v0.7.1 --generate-notes
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|------|------|------|
| Workflow does not start after pushing `v*` | Tag does not match the trigger | The trigger is the anchored `v[0-9]+.[0-9]+.[0-9]+` pattern; check with `gh run list --workflow "CLI Publish"` |
| `ENEEDAUTH` / `401` in the publish step | `NPM_TOKEN` missing or expired | Regenerate the npm automation token and update the repository secret |
| `403 Forbidden` from npm | The token's account lacks publish rights on the package | Grant the account publish access, or regenerate the token |
| `409 Conflict: version already exists` | That version was already published | bump patch (`npm version patch --no-git-tag-version`) and rerun |
| Publish fails with a provenance error | Provenance requires publishing to registry.npmjs.org with `id-token: write` | Don't redirect the registry; keep `publishConfig.registry` unset |
| `package tarball contains non-runtime files` or is missing a distribution file | Source/test files were included, or README/license notices were omitted | Check the `files` field of `apps/cli/package.json`; it should contain only `dist`, `README.md`, `LICENSE`, and `NOTICE` |
| Workflow green but no new version | A gate before publish failed | Check the job log; reproduce locally with `pnpm --filter a2wave test` |

---

## Related

- [release-workflow skill](/.agents/skills/release-workflow/SKILL.md) — the unified `v*` tag release flow
- [`.github/workflows/cli-publish.yml`](/.github/workflows/cli-publish.yml) — the publish workflow
- [`apps/cli/scripts/tag-release.sh`](/apps/cli/scripts/tag-release.sh) — tagging helper
