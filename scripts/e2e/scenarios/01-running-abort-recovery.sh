#!/usr/bin/env bash
# Scenario 01: A run that was 'running' when the server died must be marked
# failed with SERVER_RESTART_DURING_EXEC on restart, and — if it was an A2A
# run — the matching a2a_tasks row must also transition to 'failed' so that
# A2A clients calling `tasks/get` see the truth.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
e2e::setup

RUN_ID="run_e2e_running_$$"
TASK_ID="task_e2e_$$"

# ── Seed: an A2A run stuck in 'running' state (simulates pre-crash state) ──
e2e::sql "
  INSERT INTO runs (id, intent, status, trigger_source, trigger_session_id, initiator_agent_id, created_at, updated_at)
    VALUES ('$RUN_ID', 'simulated', 'running', 'a2a', '$TASK_ID', '$E2E_AGENT_ID', unixepoch() - 5, unixepoch() - 5);
  INSERT INTO run_steps (id, run_id, agent_id, \"order\", input, status, created_at)
    VALUES ('rst_e2e_$$', '$RUN_ID', '$E2E_AGENT_ID', 1, '{}', 'running', unixepoch() - 5);
  INSERT INTO a2a_tasks (id, data, created_at, updated_at)
    VALUES ('$TASK_ID', json_object(
      'id', '$TASK_ID',
      'contextId', 'ctx_e2e',
      'status', json_object('state', 'working', 'timestamp', '2026-01-01T00:00:00.000Z')
    ), unixepoch() * 1000, unixepoch() * 1000);
"

# ── Start API: recoverOnStartup runs during boot and should reconcile ──
e2e::start_api

# ── Assertions ──
RUN_STATUS="$(e2e::sql "SELECT status FROM runs WHERE id = '$RUN_ID';")"
e2e::assert_eq "$RUN_STATUS" "failed" "runs.status transitioned to failed"

RUN_REASON="$(e2e::sql "SELECT json_extract(result, '\$.error.code') FROM runs WHERE id = '$RUN_ID';")"
e2e::assert_eq "$RUN_REASON" "SERVER_RESTART_DURING_EXEC" "runs.result.error.code is SERVER_RESTART_DURING_EXEC"

STEP_STATUS="$(e2e::sql "SELECT status FROM run_steps WHERE run_id = '$RUN_ID';")"
e2e::assert_eq "$STEP_STATUS" "failed" "run_steps.status propagated to failed"

A2A_STATE="$(e2e::sql "SELECT json_extract(data, '\$.status.state') FROM a2a_tasks WHERE id = '$TASK_ID';")"
e2e::assert_eq "$A2A_STATE" "failed" "a2a_tasks.state synced to failed via markTaskFailed hook"

e2e::log_contains 'Startup task recovery completed' \
  || e2e::fail "expected 'Startup task recovery completed' log line"
ABORTED_COUNT="$(e2e::log_json_field 'Startup task recovery completed' 'runningAborted')"
e2e::assert_eq "$ABORTED_COUNT" "1" "recovery stats: runningAborted == 1"

e2e::stop_api
