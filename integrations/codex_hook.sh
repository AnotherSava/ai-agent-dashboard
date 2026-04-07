#!/bin/bash
# Codex status hook — reports to AI Status Dashboard
# Add to your shell profile or use as a wrapper: ./codex_hook.sh "my task"
#
# Usage:
#   source codex_hook.sh   # loads the wrapper function
#   codex "fix the bug"    # auto-reports working/done to dashboard

DASHBOARD="http://127.0.0.1:7890/api/status"

_status_post() {
  curl -s -X POST "$DASHBOARD" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"set\",\"id\":\"$1\",\"status\":\"$2\",\"label\":\"$3\",\"source\":\"codex\",\"updated\":$(date +%s)000}" \
    > /dev/null 2>&1 &
}

codex() {
  local task_id="codex-$$"
  local label="${*:0:40}"
  _status_post "$task_id" "working" "$label"
  command codex "$@"
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then
    _status_post "$task_id" "done" "$label"
  else
    _status_post "$task_id" "error" "exit $exit_code"
  fi
  return $exit_code
}
