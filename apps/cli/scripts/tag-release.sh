#!/usr/bin/env bash
set -euo pipefail

# tag-release.sh — tag a release and push it, triggering the release workflows.
#
# The platform and the CLI share one version line, so a single `v<version>` tag
# drives Release + Docker + the npm publish of the `a2wave` package. There is no
# separate `cli-v*` tag.
#
# Usage:
#   bash apps/cli/scripts/tag-release.sh <version>
# Example:
#   bash apps/cli/scripts/tag-release.sh 0.7.1

cd "$(dirname "$0")/../../.."

if [ $# -lt 1 ]; then
  echo "Usage: $0 <version>   (e.g. 0.7.1)" >&2
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"
CLI_PACKAGE_JSON="apps/cli/package.json"
ROOT_PACKAGE_JSON="package.json"

# 1. Version must be semver.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: version must be semver (X.Y.Z or X.Y.Z-pre), got: $VERSION" >&2
  exit 1
fi

# 2. Both manifests must already carry this version. They share one line, so a
#    mismatch means the release would ship a tag that names a version neither
#    package actually has.
CLI_VERSION="$(node -p "require('./${CLI_PACKAGE_JSON}').version")"
ROOT_VERSION="$(node -p "require('./${ROOT_PACKAGE_JSON}').version")"
if [ "$CLI_VERSION" != "$VERSION" ]; then
  echo "Error: $CLI_PACKAGE_JSON version ($CLI_VERSION) does not match tag version ($VERSION)." >&2
  echo "Run 'npm version <version> --no-git-tag-version' in apps/cli before tagging." >&2
  exit 1
fi
if [ "$ROOT_VERSION" != "$VERSION" ]; then
  echo "Error: $ROOT_PACKAGE_JSON version ($ROOT_VERSION) does not match tag version ($VERSION)." >&2
  echo "The platform and CLI share one version line; update both manifests." >&2
  exit 1
fi

# 3. Must be on main.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "Error: must be on main branch (current: $BRANCH)" >&2
  exit 1
fi

# 4. Clean working tree.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is not clean. Commit or stash first." >&2
  exit 1
fi

# 5. Local in sync with origin.
git fetch origin main --quiet
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "Error: local main is not in sync with origin/main." >&2
  echo "  local:  $LOCAL"
  echo "  origin: $REMOTE"
  echo "Run 'git pull --ff-only origin main' first." >&2
  exit 1
fi

# 6. Tag must not already exist on the remote.
if git ls-remote --tags origin "refs/tags/${TAG}" | grep -q "$TAG"; then
  echo "Error: tag $TAG already exists on origin." >&2
  exit 1
fi

# 7. Show a change summary and confirm.
PREV_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1 || true)"
echo ""
echo "About to release: $TAG"
echo "Commit:           $LOCAL"
echo ""
if [ -n "$PREV_TAG" ]; then
  echo "Changes since $PREV_TAG:"
  git log --oneline "${PREV_TAG}..HEAD" | sed 's/^/  /'
else
  echo "(no previous v* tag found)"
fi
echo ""
read -rp "Create and push tag $TAG? [y/N] " CONFIRM
case "$CONFIRM" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

# 8. Tag and push.
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"

echo ""
echo "✓ Tag pushed. Release, Docker and CLI Publish workflows will run."
