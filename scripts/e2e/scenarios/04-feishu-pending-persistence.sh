#!/usr/bin/env bash
# Scenario 04: The DB-backed Feishu pending-message table survives a server
# restart and the replay loop runs on boot. Since we don't have a real Lark
# WebSocket in CI, we verify: (a) seeded rows remain after restart, (b) the
# replay log fires, and (c) rows whose connection is not restored are left in
# place for a later retry.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
e2e::setup

MSG_ID="msg_e2e_pending_$$"

e2e::sql "
  INSERT INTO feishu_pending_messages (message_id, agent_id, run_id, payload, created_at)
    VALUES ('$MSG_ID', '$E2E_AGENT_ID', NULL,
      json_object('message', json_object('message_id', '$MSG_ID', 'chat_id', 'chat_1', 'message_type', 'text', 'content', '{\"text\":\"hi\"}'),
                  'sender', json_object('sender_id', json_object('open_id', 'usr_e2e'))),
      unixepoch() * 1000);
"

e2e::start_api

# Row is preserved when the Feishu connection cannot be rebuilt (no creds in CI).
# The replay loop should log completion and leave the row for the next restart.
ROW_COUNT="$(e2e::sql "SELECT count(*) FROM feishu_pending_messages WHERE message_id = '$MSG_ID';")"
e2e::assert_eq "$ROW_COUNT" "1" "pending Feishu row preserved when no connection available"

e2e::log_contains 'Feishu pending message replay completed' \
  || e2e::fail "expected 'Feishu pending message replay completed' log line"

SKIPPED_COUNT="$(e2e::log_json_field 'Feishu pending message replay completed' 'skipped')"
e2e::assert_eq "$SKIPPED_COUNT" "1" "replay skipped == 1 (no Lark connection in CI)"

e2e::stop_api
