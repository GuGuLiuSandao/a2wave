#!/bin/sh
# a2wave container entrypoint.
#
# The problem: the service runs as the non-root appuser (UID 10001 by default), but bind-mounted
# host directories (typically ~/.claude/.credentials.json, mode 600) are owned by the host OS
# user's UID (typically 1000). When the two differ, appuser is not the owner, cannot read the
# mode-600 file, and every localSession model probe / agent run fails with EACCES.
#
# The fix: the entrypoint starts briefly as root, reads the owner UID of the mounted ~/.claude,
# remaps appuser's UID/GID to match, re-chowns the paths the service must write, then execs gosu
# to drop to appuser for the main process. This is the standard Docker community template (see the
# official postgres / redis / mysql images' docker-entrypoint.sh): the service still runs as
# non-root, and the root window is only the ~30ms this entrypoint takes.
#
# Explicit override: set A2WAVE_RUN_AS_UID / A2WAVE_RUN_AS_GID to skip the adaptive mount probe and
# pin the UID/GID (suits operators who don't want adaptive behaviour to change implicitly;
# linuxserver.io style).

set -e

# === PATH hardening for the root phase (must come before any external command) ===
# The Provider CLI runtime install directory /home/appuser/.a2wave/bin lives on a persistent volume
# and is writable by the service user (appuser). The first half of this script runs as root and
# invokes bare command names such as id / stat / chown / find / git. If those directories appear on
# root's PATH, appuser can drop in an executable of the same name and have it run as root on the
# next restart — this was verified in practice to yield euid=0. A symlink check does not stop it
# (a plain file is not a symlink), and the check itself would run after the first `id` anyway.
#
# The image's global PATH no longer contains those directories (see Dockerfile); the root phase
# still pins the system PATH explicitly as defence in depth, so this stays safe even if someone
# later adds them back to the image PATH or overrides it via `docker run -e PATH=...`. The CLI
# directories the service needs are appended at the end of this file, at drop-privileges time.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

CLAUDE_DIR="/home/appuser/.claude"
CLI_HOME="/home/appuser"
# Persisted volume shared with the SQLite database, so a generated AUTH_SECRET and the
# sessions it signs survive a restart together.
A2WAVE_DATA_DIR="${A2WAVE_DATA_DIR:-/app/data}"
CLI_HOME_OWNER_MARKER="/home/appuser/.a2wave-home-owner"
CURRENT_UID="$(id -u appuser)"
CURRENT_GID="$(id -g appuser)"

# === Decide the target UID/GID ===
if [ -n "$A2WAVE_RUN_AS_UID" ] && [ -n "$A2WAVE_RUN_AS_GID" ]; then
  # Explicitly pinned by the operator; takes precedence
  TARGET_UID="$A2WAVE_RUN_AS_UID"
  TARGET_GID="$A2WAVE_RUN_AS_GID"
  REASON="A2WAVE_RUN_AS_UID/GID env"
elif [ -d "$CLAUDE_DIR" ] && [ "$(ls -A "$CLAUDE_DIR" 2>/dev/null)" ]; then
  # Adaptive: stat the owner of the mounted, non-empty .claude directory (the typical localSession case)
  TARGET_UID="$(stat -c '%u' "$CLAUDE_DIR")"
  TARGET_GID="$(stat -c '%g' "$CLAUDE_DIR")"
  REASON="auto-detected from $CLAUDE_DIR owner"
else
  # Neither an env override nor a probeable mount → keep the default UID
  TARGET_UID="$CURRENT_UID"
  TARGET_GID="$CURRENT_GID"
  REASON="no mount + no override → keep default"
fi

# === Remap only when needed, to avoid chowning large directories on every boot ===
if [ "$TARGET_UID" != "$CURRENT_UID" ] || [ "$TARGET_GID" != "$CURRENT_GID" ]; then
  if [ "$TARGET_UID" = "0" ]; then
    echo "[entrypoint] refusing to remap appuser to UID 0 (root). Source: $REASON" >&2
    exit 1
  fi
  echo "[entrypoint] remapping appuser: ${CURRENT_UID}:${CURRENT_GID} → ${TARGET_UID}:${TARGET_GID} (${REASON})"

  # -o permits colliding with an existing user UID (so the base image's node UID 1000 is not a conflict)
  groupmod -o -g "$TARGET_GID" appuser
  usermod  -o -u "$TARGET_UID" appuser

  # Re-chown the paths the service must write, otherwise sqlite / artifacts hit EACCES.
  # /app is the build output (Dockerfile sets its owner layer by layer via COPY --chown);
  # /home/appuser is HOME. The ~/.claude bind-mount itself is excluded — chowning it would
  # damage the permissions of the host's .credentials.json.
  chown -R "$TARGET_UID:$TARGET_GID" /app
  chown "$TARGET_UID:$TARGET_GID" /home/appuser

  # SCM workspace: the /data/workspace bind mount holds repositories cloned by a2wave SCM sync
  # (written under the old UID). But that host path may also be used by the host OS user directly
  # (dev working directories, cursor config, their own git repos) — a blanket chown -R would
  # pollute the host development environment.
  # So this is surgical: chown only files whose owner differs from TARGET_UID.
  #   - The host user's own files (UID 1000 = TARGET_UID) are skipped by find → left alone
  #   - Files left by an older a2wave under UID 10001 → taken over as TARGET_UID
  #   - Files a2wave writes from now on are already TARGET_UID → skipped (idempotent)
  # -h keeps chown from dereferencing a symlink and altering its target outside the tree.
  if [ -d /data/workspace ]; then
    find /data/workspace -not -uid "$TARGET_UID" -exec chown -h "$TARGET_UID:$TARGET_GID" {} + 2>/dev/null || true
  fi
else
  echo "[entrypoint] appuser UID/GID already ${CURRENT_UID}:${CURRENT_GID}, no remap needed"
fi

# A fresh Docker named volume is created as root:root even when appuser's UID did
# not change, so ownership repair cannot live only in the remap branch above.
# Refuse links before the root-phase chown; following a service-user-controlled
# link here could change ownership outside the dedicated SCM volume.
SCM_STORAGE_ROOT="${SCM_STORAGE_ROOT:-/home/appuser/.a2wave}"
if [ -L "$SCM_STORAGE_ROOT" ]; then
  echo "[entrypoint] refusing to start: $SCM_STORAGE_ROOT is a symlink" >&2
  exit 1
fi
mkdir -p "$SCM_STORAGE_ROOT"
if [ ! -d "$SCM_STORAGE_ROOT" ] || [ -L "$SCM_STORAGE_ROOT" ]; then
  echo "[entrypoint] refusing to start: $SCM_STORAGE_ROOT is not a regular directory" >&2
  exit 1
fi
chown -h "$TARGET_UID:$TARGET_GID" "$SCM_STORAGE_ROOT"

# Runtime install root for Provider CLIs (see the A2WAVE_CLI_INSTALL_ROOT comment in the Dockerfile).
# These are chowned here rather than relying on the ownership repair below: that block is guarded by
# a marker cache, so on a second boot it is skipped entirely and any newly created directory would
# be left owned by root, leaving appuser unable to install into it.
#
# Security note: these paths live on a persistent volume writable by the service user (appuser), so
# their type must NOT be trusted. If appuser replaced .a2wave/bin with a symlink to /usr/local/bin,
# root's chown on the next boot would follow the link and hand ownership of the target outside the
# tree to appuser — writing a privilege-escalation path straight into the entrypoint.
# Hence: use -h to touch only the link itself (no dereference), then verify each path really is a
# real directory and not a symlink, and refuse to start rather than silently repairing a tampered one.
for cli_dir in "" /bin /npm /opt; do
  cli_path="$CLI_HOME/.a2wave$cli_dir"
  if [ -L "$cli_path" ]; then
    echo "[entrypoint] refusing to start: $cli_path is a symlink" >&2
    exit 1
  fi
  mkdir -p "$cli_path"
  if [ ! -d "$cli_path" ] || [ -L "$cli_path" ]; then
    echo "[entrypoint] refusing to start: $cli_path is not a regular directory" >&2
    exit 1
  fi
  chown -h "$TARGET_UID:$TARGET_GID" "$cli_path"
done

# /home/appuser may be a large persistent named volume. Repair ownership once per target UID/GID,
# then record the completed scan in the volume instead of traversing every CLI cache on each boot.
# The marker is recreated rather than followed so a service-user symlink cannot turn this root
# entrypoint write into an arbitrary-file overwrite. Claude remains pruned because Compose mounts
# the host credential directory read-only.
EXPECTED_CLI_HOME_OWNER="${TARGET_UID}:${TARGET_GID}"
RECORDED_CLI_HOME_OWNER=""
if [ -f "$CLI_HOME_OWNER_MARKER" ] && [ ! -L "$CLI_HOME_OWNER_MARKER" ]; then
  RECORDED_CLI_HOME_OWNER="$(cat "$CLI_HOME_OWNER_MARKER" 2>/dev/null || true)"
fi
CURRENT_CLI_HOME_OWNER="$(stat -c '%u:%g' "$CLI_HOME")"

if [ "$RECORDED_CLI_HOME_OWNER" != "$EXPECTED_CLI_HOME_OWNER" ] || \
   [ "$CURRENT_CLI_HOME_OWNER" != "$EXPECTED_CLI_HOME_OWNER" ]; then
  chown "$TARGET_UID:$TARGET_GID" "$CLI_HOME"
  find "$CLI_HOME" -mindepth 1 -path "$CLAUDE_DIR" -prune -o \
    \( ! -uid "$TARGET_UID" -o ! -gid "$TARGET_GID" \) \
    -exec chown -h "$TARGET_UID:$TARGET_GID" {} + 2>/dev/null || true
  rm -f "$CLI_HOME_OWNER_MARKER"
  printf '%s\n' "$EXPECTED_CLI_HOME_OWNER" > "$CLI_HOME_OWNER_MARKER"
  chown "$TARGET_UID:$TARGET_GID" "$CLI_HOME_OWNER_MARKER"
else
  echo "[entrypoint] CLI HOME ownership already verified for $EXPECTED_CLI_HOME_OWNER"
fi

# === Resolve AUTH_SECRET ===
# Generated and persisted on first boot when the operator supplied none, mirroring what
# scripts/ensure-auth-secret.mjs does for `pnpm dev`. Without this the documented quickstart
# (`cp .env.example .env` → `docker compose up`) stopped on the template's empty AUTH_SECRET=.
# Runs before the privilege drop, so the file is written and read as root at mode 600 and is
# deliberately NOT chowned to the service user: nothing in the runtime reads it — the secret
# reaches the process through the environment exported here — so handing it to the UID that
# also runs the Agent CLIs would widen its exposure for no benefit, in a directory that holds
# the SCM workspaces (CURSOR_AGENT_WORK_DIR=/app/data/workspaces) one level away.
AUTH_SECRET="$(/usr/local/bin/ensure-container-auth-secret.sh "$A2WAVE_DATA_DIR")"
export AUTH_SECRET

# === Globally trust git safe.directory ===
# After the UID remap, the service's runtime UID may differ from the owner UID of files already in
# the SCM workspace (/data/workspace and friends). git 2.35.2+ rejects such repositories by default
# with `fatal: detected dubious ownership` (the CVE-2022-24765 defence).
# The container is a single-tenant runtime where every git repository belongs to a2wave itself, so
# there is no hooks-path pollution attack surface → trust all paths. --system writes /etc/gitconfig
# so it applies across users (including the remapped appuser).
git config --system --add safe.directory '*' 2>/dev/null || true

# === Drop privileges to appuser and exec the main process ===
# `exec gosu` replaces the current root process (the PID is unchanged); gosu immediately setuids to
# appuser and then execs the real CMD. Once dropped, privileges cannot be regained (a Linux rule),
# which is equivalent in security level to `USER appuser`.
export HOME=/home/appuser
export USER=appuser
export LOGNAME=appuser
# Here, and only here, the Provider CLI install directory is appended to PATH.
# The image's global PATH does not contain it (removed in the Dockerfile), so this is the single
# point at which it enters any process environment — and the very next line execs gosu to drop
# privileges, so only the non-root service process can resolve these writable directories.
# ENTRYPOINT's tini and HEALTHCHECK's curl both run as root outside this script, using the global
# PATH without writable directories, and both were changed to absolute-path invocations.
#
# gosu is exec'd by absolute path and does not depend on PATH; this assignment affects only the
# child process it execs.
CLI_INSTALL_ROOT="${A2WAVE_CLI_INSTALL_ROOT:-/home/appuser/.a2wave}"
PATH="${CLI_INSTALL_ROOT}/bin:${PATH}"
export PATH
exec /usr/sbin/gosu appuser "$@"
