#!/bin/sh
# Resolve the container's AUTH_SECRET, printing it on stdout.
#
# The container counterpart of scripts/ensure-auth-secret.mjs, which does the same
# job for `pnpm dev`. Generating a random secret is mechanical and has exactly one
# correct answer, so the platform does it rather than stopping the documented
# quickstart (`cp .env.example .env` → `docker compose up`) on a value only the
# operator could supply.
#
# Two properties matter beyond "produce a value":
#   - Persisted, not per-boot. A fresh secret on every restart would invalidate
#     every cookie and bearer token, silently logging out the whole deployment.
#     It lives in the data directory, which is the same persisted volume as the
#     SQLite database, so the secret and the sessions it signs share a lifetime.
#   - Never overrides an explicit AUTH_SECRET. Production injects one; a stored
#     file must not shadow it, and an explicit value must not overwrite the file
#     (an operator temporarily passing one should not destroy the fallback).
#
# Deliberately no default value: a shipped constant would make every deployment
# that skipped configuration share one publicly-known signing key.

set -e

DATA_DIR="${1:?usage: ensure-container-auth-secret.sh <data-dir>}"
SECRET_FILE="$DATA_DIR/.auth-secret"

# A symlink is refused rather than followed: the data directory is writable by the
# service user, and following one would let a tampered link disclose an arbitrary
# root-readable file into the environment, or redirect the write below. Checked before
# the explicit-value return so a deployment that injects AUTH_SECRET still fails on a
# tampered path instead of skipping the check it never reaches.
if [ -L "$SECRET_FILE" ]; then
  echo "[auth-secret] refusing to use $SECRET_FILE: it is a symlink" >&2
  exit 1
fi

# An explicit value wins. Whitespace-only counts as unset: .env.example ships
# `AUTH_SECRET=` empty, and Compose forwards that as an empty string.
if [ -n "$(printf '%s' "${AUTH_SECRET:-}" | tr -d '[:space:]')" ]; then
  echo "[auth-secret] using the AUTH_SECRET supplied by the environment" >&2
  printf '%s\n' "$AUTH_SECRET"
  exit 0
fi

# Reuse a previously generated secret, so restarts keep existing sessions valid.
if [ -f "$SECRET_FILE" ]; then
  STORED="$(tr -d '[:space:]' < "$SECRET_FILE")"
  if [ -n "$STORED" ]; then
    echo "[auth-secret] reusing the generated secret stored in $SECRET_FILE" >&2
    printf '%s\n' "$STORED"
    exit 0
  fi
fi

# A generated secret is per-instance, and a PostgreSQL URL is the one signal that this
# instance may not be alone: PostgreSQL exists here for multi-replica deployments, where
# replicas share the database but each keeps its own /app/data. Minting a private secret
# there means tokens signed by one replica are rejected by the next, and SSO config
# encrypted by one cannot be decrypted by another — an intermittent failure that looks
# like anything but a key mismatch. AUTH_SECRET being mandatory used to force operators
# to supply a shared value; generating it removed that, so the guard has to be explicit.
# Normalized to match apps/api/src/db/dialect.ts, which tests
# /^postgres(ql)?:\/\//i against a trimmed string. A stricter test here would be worse
# than no guard at all: `PostgreSQL://…` would pass, the helper would report success,
# and the app would connect to PostgreSQL anyway with the per-instance secret this
# check exists to prevent.
DB_URL_NORMALIZED="$(
  printf '%s' "${DATABASE_URL:-}" | sed -e 's/^[[:space:]]*//' | tr '[:upper:]' '[:lower:]'
)"
case "$DB_URL_NORMALIZED" in
  postgres://* | postgresql://*)
    echo "[auth-secret] DATABASE_URL points at PostgreSQL, so AUTH_SECRET must be set explicitly." >&2
    echo "[auth-secret] PostgreSQL is the multi-replica backend, and a generated secret is private to this instance:" >&2
    echo "[auth-secret] every replica would sign tokens the others reject, and SSO settings encrypted by one could not be read by another." >&2
    echo "[auth-secret] set the same AUTH_SECRET on every replica (openssl rand -hex 32)." >&2
    exit 1
    ;;
esac

# Reaching here mints a NEW secret, which invalidates every existing cookie and bearer
# token. That is correct on a first boot and alarming on any later one: a deployment
# that injects AUTH_SECRET from a shell, CI variable, or Kubernetes Secret lands here
# only when that chain silently broke, and would otherwise log its whole user base out
# with no diagnostic. Compose's `${AUTH_SECRET:?}` used to catch it by refusing to
# start, so the warning has to carry that weight now.
echo "[auth-secret] no AUTH_SECRET in the environment and none stored — generating a new one." >&2
echo "[auth-secret] every existing session and API token will stop being valid." >&2
echo "[auth-secret] if this deployment is supposed to inject AUTH_SECRET, that injection is broken — check it before letting this instance serve traffic." >&2

# 32 bytes hex-encoded — 64 characters, comfortably above the 32-character
# production floor that apps/api/src/env.ts enforces.
GENERATED="$(od -An -vtx1 -N32 /dev/urandom | tr -d ' \n')"
if [ ${#GENERATED} -ne 64 ]; then
  echo "[auth-secret] failed to generate a secret from /dev/urandom" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
# umask before the write, so the secret is never briefly world-readable.
(umask 177 && printf '%s\n' "$GENERATED" > "$SECRET_FILE")
printf '%s\n' "$GENERATED"
