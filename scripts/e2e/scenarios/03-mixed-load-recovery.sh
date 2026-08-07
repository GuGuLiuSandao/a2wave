#!/usr/bin/env bash
# Scenario 03: A realistic recovery with a mix of running / pending / queued /
# completed rows. Validates that each class is handled correctly and that the
# aggregate stats log is emitted accurately.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
e2e::setup

# 2 running (both should be aborted)
for i in 1 2; do
  e2e::sql "
    INSERT INTO runs (id, intent, status, trigger_source, trigger_session_id, initiator_agent_id, created_at, updated_at)
      VALUES ('run_r$i', 'r$i', 'running', 'a2a', 'tid_$i', '$E2E_AGENT_ID', unixepoch(), unixepoch());
    INSERT INTO a2a_tasks (id, data, created_at, updated_at)
      VALUES ('tid_$i', json_object(
        'id', 'tid_$i',
        'contextId', 'ctx_mix',
        'status', json_object('state', 'working', 'timestamp', '2026-01-01T00:00:00.000Z')
      ), unixepoch() * 1000, unixepoch() * 1000);
  "
done

# 1 pending orphan (>30s old) + 1 fresh pending (untouched)
e2e::sql "
  INSERT INTO runs (id, intent, status, trigger_source, initiator_agent_id, created_at, updated_at)
    VALUES ('run_p_old', 'po', 'pending', 'api', '$E2E_AGENT_ID', unixepoch() - 600, unixepoch() - 600);
  INSERT INTO runs (id, intent, status, trigger_source, initiator_agent_id, created_at, updated_at)
    VALUES ('run_p_fresh', 'pf', 'pending', 'api', '$E2E_AGENT_ID', unixepoch(), unixepoch());
"

# 1 completed (must remain completed)
e2e::sql "
  INSERT INTO runs (id, intent, status, trigger_source, initiator_agent_id, result, created_at, updated_at)
    VALUES ('run_done', 'done', 'completed', 'api', '$E2E_AGENT_ID', '{\"output\":\"ok\"}', unixepoch(), unixepoch());
"

e2e::start_api

# Running runs aborted
for i in 1 2; do
  status="$(e2e::sql "SELECT status FROM runs WHERE id = 'run_r$i';")"
  e2e::assert_eq "$status" "failed" "run_r$i transitioned to failed"
  a2a_state="$(e2e::sql "SELECT json_extract(data, '\$.status.state') FROM a2a_tasks WHERE id = 'tid_$i';")"
  e2e::assert_eq "$a2a_state" "failed" "a2a tid_$i state synced"
done

# Pending orphan aborted, fresh pending preserved
e2e::assert_eq "$(e2e::sql "SELECT status FROM runs WHERE id = 'run_p_old';")" "failed" "run_p_old aborted"
e2e::assert_eq "$(e2e::sql "SELECT status FROM runs WHERE id = 'run_p_fresh';")" "pending" "run_p_fresh preserved"

# Completed preserved
e2e::assert_eq "$(e2e::sql "SELECT status FROM runs WHERE id = 'run_done';")" "completed" "completed run preserved"

# Stats log
e2e::assert_eq "$(e2e::log_json_field 'Startup task recovery completed' 'runningAborted')" "2" "stats.runningAborted == 2"
e2e::assert_eq "$(e2e::log_json_field 'Startup task recovery completed' 'pendingOrphaned')" "1" "stats.pendingOrphaned == 1"

e2e::stop_api
