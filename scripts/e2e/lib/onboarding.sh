#!/usr/bin/env bash
# Shared helpers for the onboarding (first-time developer) E2E harness.
#
# Unlike lib/common.sh, which seeds a sandbox DB against the *current* checkout,
# these helpers drive a genuinely fresh clone: the point is to catch the failures
# a newcomer hits and a resident developer never does — a missing build artifact
# that only exists because it was built months ago, a setup step documented in
# the README but absent from the repo, an install that needs a network fetch
# nobody noticed was cached.
#
# Every stage is expected to:
#   1. source this file
#   2. call `onboarding::setup` (temp workspace, port allocation, traps)
#   3. drive the README steps via `onboarding::clone` / `install` / `copy_env` / `start_dev`
#   4. assert with `onboarding::assert_*`
#   5. rely on the EXIT trap for teardown

set -euo pipefail

ONBOARDING_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # scripts/e2e/lib
REPO_ROOT="$(cd "$ONBOARDING_LIB_DIR/../../.." && pwd)"             # repo root

if [[ -t 1 ]]; then
  ONBOARDING_GREEN=$'\e[32m'
  ONBOARDING_RED=$'\e[31m'
  ONBOARDING_YELLOW=$'\e[33m'
  ONBOARDING_RESET=$'\e[0m'
else
  ONBOARDING_GREEN=''
  ONBOARDING_RED=''
  ONBOARDING_YELLOW=''
  ONBOARDING_RESET=''
fi

onboarding::log() {
  printf '%s[onboarding]%s %s\n' "$ONBOARDING_GREEN" "$ONBOARDING_RESET" "$*" >&2
}
onboarding::warn() {
  printf '%s[onboarding warn]%s %s\n' "$ONBOARDING_YELLOW" "$ONBOARDING_RESET" "$*" >&2
}

# Marks the start of a README step, so a failure report can name the step a
# newcomer would have been on when it broke.
onboarding::step() {
  ONBOARDING_CURRENT_STEP="$*"
  printf '\n%s──▶ %s%s\n' "$ONBOARDING_GREEN" "$*" "$ONBOARDING_RESET" >&2
}

onboarding::fail() {
  printf '%s[onboarding FAIL]%s %s\n' "$ONBOARDING_RED" "$ONBOARDING_RESET" "$*" >&2
  if [[ -n "${ONBOARDING_CURRENT_STEP:-}" ]]; then
    printf '%s  failing step: %s%s\n' "$ONBOARDING_YELLOW" "$ONBOARDING_CURRENT_STEP" "$ONBOARDING_RESET" >&2
  fi
  onboarding::dump_logs
  exit 1
}

onboarding::dump_logs() {
  local log
  for log in "${ONBOARDING_DEV_LOG:-}" "${ONBOARDING_INSTALL_LOG:-}"; do
    [[ -n "$log" && -f "$log" ]] || continue
    printf '%s--- %s (last 60 lines) ---%s\n' \
      "$ONBOARDING_YELLOW" "$(basename "$log")" "$ONBOARDING_RESET" >&2
    tail -60 "$log" >&2 || true
  done
}

# --- State shared between setup / teardown ---
ONBOARDING_WORKDIR=""
ONBOARDING_CLONE_DIR=""
ONBOARDING_DEV_LOG=""
ONBOARDING_INSTALL_LOG=""
ONBOARDING_DEV_PID=""
ONBOARDING_API_PORT=""
ONBOARDING_WEB_PORT=""
ONBOARDING_CURRENT_STEP=""

# Whether to keep the temp clone for inspection after a run.
ONBOARDING_KEEP="${ONBOARDING_KEEP:-0}"

onboarding::require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 \
      || onboarding::fail "required command '$cmd' not found on PATH"
  done
}

# Pick a free TCP port, deliberately away from the 3501/3502 dev pair and the
# 3503/3504 worktree pair reserved by AGENTS.md, so a running dev server or a
# parallel worktree e2e run is never disturbed.
onboarding::free_port() {
  local port
  for _ in $(seq 1 50); do
    port=$(( 34000 + RANDOM % 1000 ))
    if ! onboarding::port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
  done
  onboarding::fail "could not find a free port in 34000-34999"
}

onboarding::port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti ":$port" >/dev/null 2>&1
  else
    # nc -z is the portable fallback when lsof is absent (slim CI images).
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
  fi
}

onboarding::setup() {
  onboarding::require_cmd git pnpm curl node

  ONBOARDING_WORKDIR="$(mktemp -d -t a2wave-onboarding-XXXXXX)"
  ONBOARDING_CLONE_DIR="$ONBOARDING_WORKDIR/a2wave"
  ONBOARDING_DEV_LOG="$ONBOARDING_WORKDIR/dev.log"
  ONBOARDING_INSTALL_LOG="$ONBOARDING_WORKDIR/install.log"
  ONBOARDING_API_PORT="$(onboarding::free_port)"
  ONBOARDING_WEB_PORT="$(onboarding::free_port)"

  onboarding::log "workspace: $ONBOARDING_WORKDIR"
  onboarding::log "ports: api=$ONBOARDING_API_PORT web=$ONBOARDING_WEB_PORT"

  trap 'onboarding::cleanup' EXIT INT TERM
}

onboarding::cleanup() {
  # `|| true`: stop_dev ends in a bounded port-release wait that returns non-zero
  # on timeout, and under `set -e` that would abort the trap before the rm below,
  # leaving a ~700MB clone behind on exactly the failing runs that matter most.
  onboarding::stop_dev || true
  if [[ "$ONBOARDING_KEEP" == "1" ]]; then
    onboarding::warn "ONBOARDING_KEEP=1 — leaving $ONBOARDING_WORKDIR in place"
    return 0
  fi
  # Bounded to the mktemp directory this run created; never a caller-supplied path.
  if [[ -n "$ONBOARDING_WORKDIR" && -d "$ONBOARDING_WORKDIR" ]]; then
    if ! rm -rf "$ONBOARDING_WORKDIR" 2>/dev/null; then
      # "Directory not empty" here means a watcher is still writing into the
      # clone — i.e. teardown missed a process. Report it rather than leaving a
      # ~700MB directory behind with no explanation.
      onboarding::warn "could not remove $ONBOARDING_WORKDIR — a process may still be running in it"
      pgrep -fl "$ONBOARDING_WORKDIR" >&2 2>/dev/null || true
    fi
  fi
}

# ── README step 1: clone ──────────────────────────────────────────────────────
#
# Defaults to cloning the local checkout over file://, so the flow under test is
# the one in *this* working tree's HEAD — the commit about to be merged, not the
# published main. Override with ONBOARDING_CLONE_URL to rehearse against GitHub.
onboarding::clone() {
  local url="${ONBOARDING_CLONE_URL:-file://$REPO_ROOT}"
  onboarding::log "cloning from $url"
  git clone --quiet "$url" "$ONBOARDING_CLONE_DIR" \
    || onboarding::fail "git clone failed from $url"

  # A file:// clone copies committed history only, so anything gitignored —
  # node_modules, packages/shared/dist, .env, the SQLite file — is absent by
  # construction. That absence is the whole point: it is what a newcomer has.
  [[ -f "$ONBOARDING_CLONE_DIR/package.json" ]] \
    || onboarding::fail "clone produced no package.json"
  [[ ! -d "$ONBOARDING_CLONE_DIR/node_modules" ]] \
    || onboarding::fail "clone leaked node_modules — the fresh-clone premise is broken"
}

# ── README step 2: pnpm install ───────────────────────────────────────────────
onboarding::install() {
  onboarding::log "pnpm install (output → $ONBOARDING_INSTALL_LOG)"
  # --ignore-scripts is deliberately NOT passed: better-sqlite3 may build its
  # native addon here, and that build is part of what a newcomer must survive.
  ( cd "$ONBOARDING_CLONE_DIR" && pnpm install ) >"$ONBOARDING_INSTALL_LOG" 2>&1 \
    || onboarding::fail "pnpm install failed — see $ONBOARDING_INSTALL_LOG"
}

# ── README step 3: cp .env.example .env ───────────────────────────────────────
onboarding::copy_env() {
  [[ -f "$ONBOARDING_CLONE_DIR/.env.example" ]] \
    || onboarding::fail ".env.example is missing from the clone — README step 'cp .env.example .env' cannot work"
  cp "$ONBOARDING_CLONE_DIR/.env.example" "$ONBOARDING_CLONE_DIR/.env"

  # Ports: the sole deviation from a verbatim README run. A newcomer takes the
  # default 3501/3502; this harness must not fight a dev server already there.
  # Both vite.config.ts and env.ts read these from the root .env, so appending
  # them exercises the same configuration path a worktree run uses.
  cat >>"$ONBOARDING_CLONE_DIR/.env" <<EOF

PORT=$ONBOARDING_API_PORT
WEB_PORT=$ONBOARDING_WEB_PORT
CORS_ORIGIN=http://localhost:$ONBOARDING_WEB_PORT
EOF
}

onboarding::env_value() {
  local key="$1"
  sed -n "s/^[ \t]*${key}[ \t]*=[ \t]*\(.*\)$/\1/p" "$ONBOARDING_CLONE_DIR/.env" | tail -1
}

# ── README step 4: pnpm dev ───────────────────────────────────────────────────
#
# Started as its own session leader so teardown can signal the entire tree.
# `pnpm dev` fans out to tsx/vite/tsup/esbuild grandchildren, and signalling only
# the pnpm wrapper leaves all of them running: they keep the ports bound and the
# clone busy, so even `rm -rf` then fails with "Directory not empty". This was
# observed, not theorised.
#
# `setsid` is Linux-only, so use it when present and fall back to Perl's
# POSIX::setsid, which ships with the system Perl on macOS.
onboarding::start_dev() {
  onboarding::log "pnpm dev (output → $ONBOARDING_DEV_LOG)"
  (
    cd "$ONBOARDING_CLONE_DIR"
    # env -i is not used: pnpm needs PATH/HOME. But the ambient AUTH_SECRET (and
    # any DATABASE_URL) from the developer's own shell must not leak in — the
    # test asserts that `pnpm dev` generates a secret into the fresh .env itself.
    unset AUTH_SECRET DATABASE_URL PORT WEB_PORT CORS_ORIGIN
    if command -v setsid >/dev/null 2>&1; then
      exec setsid pnpm dev
    else
      exec perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die $!' pnpm dev
    fi
  ) >"$ONBOARDING_DEV_LOG" 2>&1 &
  ONBOARDING_DEV_PID=$!
  onboarding::log "dev orchestrator pid=$ONBOARDING_DEV_PID"
}

onboarding::stop_dev() {
  [[ -z "$ONBOARDING_DEV_PID" ]] && return 0

  # The session leader's pid doubles as its process-group id, so the negative
  # form reaches every descendant. Fall back to the bare pid if the group is
  # already gone, then escalate to SIGKILL for anything ignoring SIGTERM.
  kill -TERM "-$ONBOARDING_DEV_PID" 2>/dev/null \
    || kill -TERM "$ONBOARDING_DEV_PID" 2>/dev/null || true

  local deadline=$((SECONDS + 20))
  while (( SECONDS < deadline )); do
    kill -0 "$ONBOARDING_DEV_PID" 2>/dev/null || break
    sleep 0.3
  done

  kill -9 "-$ONBOARDING_DEV_PID" 2>/dev/null || true
  kill -9 "$ONBOARDING_DEV_PID" 2>/dev/null || true
  wait "$ONBOARDING_DEV_PID" 2>/dev/null || true
  ONBOARDING_DEV_PID=""

  # dev.mjs escalates to SIGKILL 3s after SIGTERM; give the watchers a moment to
  # unbind before the caller asserts the ports are free.
  onboarding::await_port_release "$ONBOARDING_API_PORT" "$ONBOARDING_WEB_PORT"
}

# Wait (bounded) for ports to be released, so a slow-but-correct shutdown is not
# reported as a leak.
onboarding::await_port_release() {
  local deadline=$((SECONDS + 15)) port held
  while (( SECONDS < deadline )); do
    held=0
    for port in "$@"; do
      [[ -n "$port" ]] && onboarding::port_in_use "$port" && held=1
    done
    (( held == 0 )) && return 0
    sleep 0.5
  done
  return 1
}

# Poll a URL until it answers 2xx, failing fast if the dev orchestrator dies —
# otherwise a crashed server burns the full timeout before reporting anything.
onboarding::wait_for_http() {
  local url="$1" label="$2" timeout="${3:-240}"
  local deadline=$((SECONDS + timeout))
  onboarding::log "waiting for $label at $url (timeout ${timeout}s)"
  while (( SECONDS < deadline )); do
    if curl -sf -o /dev/null "$url"; then
      onboarding::log "ok: $label is up"
      return 0
    fi
    if ! kill -0 "$ONBOARDING_DEV_PID" 2>/dev/null; then
      onboarding::fail "pnpm dev exited before $label became reachable"
    fi
    sleep 1
  done
  onboarding::fail "$label did not become reachable within ${timeout}s"
}

onboarding::assert_eq() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] \
    || onboarding::fail "$label: expected '$expected', got '$actual'"
  onboarding::log "ok: $label"
}

onboarding::assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] \
    || onboarding::fail "$label: '$haystack' does not contain '$needle'"
  onboarding::log "ok: $label"
}

onboarding::assert_file_exists() {
  local path="$1" label="$2"
  [[ -f "$path" ]] || onboarding::fail "$label: expected file at $path"
  onboarding::log "ok: $label"
}

onboarding::api_url() { printf 'http://127.0.0.1:%s%s' "$ONBOARDING_API_PORT" "$1"; }
onboarding::web_url() { printf 'http://127.0.0.1:%s%s' "$ONBOARDING_WEB_PORT" "$1"; }
