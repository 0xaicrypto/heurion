#!/usr/bin/env bash
# stop.sh — SIGTERM the backend processes named in runtime.json,
# then delete runtime.json. Safe to run when nothing is running.
#
# Lifecycle: the desktop calls this on graceful quit. If desktop
# crashes (no graceful exit), the next start.sh sees a stale
# runtime.json, detects the dead pid, and self-heals — so this script
# missing a call doesn't strand the user.

set -uo pipefail   # intentionally NOT -e — we want to TRY all kills
                   # even if one fails.

RUNE_HOME="$HOME/Library/Application Support/RuneProtocol"
RUNTIME_JSON="$RUNE_HOME/runtime.json"
STOP_LOG="$RUNE_HOME/stop.log"

exec > >(tee -a "$STOP_LOG") 2>&1
echo ""
echo "── stop.sh @ $(date -u +"%Y-%m-%dT%H:%M:%SZ") ──"

if [[ ! -f "$RUNTIME_JSON" ]]; then
  echo "  no runtime.json — nothing to stop"
  exit 0
fi

# Extract pids (may be null/missing)
SERVER_PID="$(python3 -c "
import json
d = json.load(open('$RUNTIME_JSON'))
print(d.get('server_pid') or '')
" 2>/dev/null || echo "")"

DAEMON_PID="$(python3 -c "
import json
d = json.load(open('$RUNTIME_JSON'))
print(d.get('daemon_pid') or '')
" 2>/dev/null || echo "")"

# Send SIGTERM, then wait up to 5s, then SIGKILL anything still alive.
kill_with_grace() {
  local pid="$1"
  local label="$2"
  if [[ -z "$pid" ]]; then return; fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "  $label pid $pid already gone"
    return
  fi
  echo "  $label pid $pid → SIGTERM"
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "  $label pid $pid exited gracefully"
      return
    fi
    sleep 0.5
  done
  echo "  $label pid $pid still alive after 5s → SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
}

kill_with_grace "$DAEMON_PID" "daemon"
kill_with_grace "$SERVER_PID" "server"

rm -f "$RUNTIME_JSON"
echo "  removed runtime.json"
echo "✓ backend stopped"
