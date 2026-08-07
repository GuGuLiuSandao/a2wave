#!/usr/bin/env bash
# Scenario 02: A run inserted with status='pending' but never claimed a slot
# (crash between INSERT runs and tryAcquireSlot) is older than the
# PENDING_ORPHAN_TIMEOUT_MS. Startup recovery must mark it failed with
# PENDING_ORPHAN_ON_STARTUP, and must not touch runs that are still fresh
# enough to be legitimate.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
e2e::setup

OLD_RUN_ID="run_e2e_old_$$"
FRESH_RUN_ID="run_e2e_fresh_$$"

# PENDING_ORPHAN_TIMEOUT_MS is 30s — seed one row 5 min old, one fresh.
e2e::sql "
  INSERT INTO runs (id, intent, status, trigger_source, initiator_agent_id, created_at, updated_at)
    VALUES ('$OLD_RUN_ID', 'orphan', 'pending', 'api', '$E2E_AGENT_ID', unixepoch() - 300, unixepoch() - 300);
  INSERT INTO runs (id, intent, status, trigger_source, initiator_agent_id, created_at, updated_at)
    VALUES ('$FRESH_RUN_ID', 'fresh', 'pending', 'api', '$E2E_AGENT_ID', unixepoch(), unixepoch());
"

e2e::start_api

OLD_STATUS="$(e2e::sql "SELECT status FROM runs WHERE id = '$OLD_RUN_ID';")"
e2e::assert_eq "$OLD_STATUS" "failed" "orphaned pending run transitioned to failed"

OLD_REASON="$(e2e::sql "SELECT json_extract(result, '\$.error.code') FROM runs WHERE id = '$OLD_RUN_ID';")"
e2e::assert_eq "$OLD_REASON" "PENDING_ORPHAN_ON_STARTUP" "failure code is PENDING_ORPHAN_ON_STARTUP"

FRESH_STATUS="$(e2e::sql "SELECT status FROM runs WHERE id = '$FRESH_RUN_ID';")"
e2e::assert_eq "$FRESH_STATUS" "pending" "fresh pending run untouched (outside orphan window)"

ORPHANED_COUNT="$(e2e::log_json_field 'Startup task recovery completed' 'pendingOrphaned')"
e2e::assert_eq "$ORPHANED_COUNT" "1" "recovery stats: pendingOrphaned == 1"

e2e::stop_api
