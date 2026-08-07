#!/usr/bin/env bash
# pre-tool-guard.sh — a2wave 危险命令拦截
# 退出码 2 = 阻断；0 = 放行

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('command', ''))
" 2>/dev/null || echo "")

BLOCKED=0
REASON=""

block() {
  BLOCKED=1
  REASON="$1"
}

# 递归强制删除
if echo "$COMMAND" | grep -qE '\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r'; then
  block "rm -rf 被 Harness 拦截。如确需删除，请在终端手动执行。"
fi

# git push --force
if echo "$COMMAND" | grep -qE 'git\s+push\s+.*--force\b|git\s+push\s+.*\s+-f\b'; then
  block "git push --force 被 Harness 拦截。请改用 --force-with-lease。"
fi

# git reset --hard origin/
if echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard\s+origin/'; then
  block "git reset --hard origin/... 被 Harness 拦截。请确认本地改动已保存。"
fi

# drizzle-kit push（禁止直接推 schema，须走 generate + migrate）
if echo "$COMMAND" | grep -qE 'db:push|drizzle-kit\s+push'; then
  block "db:push 被 Harness 拦截。请使用 db:generate + db:migrate 流程。"
fi

# 手动修改 drizzle/meta/（须由 db:generate 生成）
if echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
path = data.get('file_path', data.get('path', ''))
print('drizzle/meta/' in path or '_journal.json' in path)
" 2>/dev/null | grep -q "True"; then
  block "drizzle/meta/ 被 Harness 拦截。请通过 pnpm db:generate 生成，勿手动修改。"
fi

# kubectl delete 在 a2wave namespace
if echo "$COMMAND" | grep -qE 'kubectl\s+delete.*-n\s+a2wave|kubectl\s+delete.*--all'; then
  block "kubectl delete 在 a2wave namespace 被 Harness 拦截。生产变更请人工确认。"
fi

if [ "$BLOCKED" -eq 1 ]; then
  python3 -c "
import json, sys
print(json.dumps({'decision': 'block', 'reason': sys.argv[1]}))" "$REASON"
  exit 2
fi

exit 0
