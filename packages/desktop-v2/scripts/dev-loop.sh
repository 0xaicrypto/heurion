#!/usr/bin/env bash
# Fast iteration loop — NO .dmg builds, NO PyInstaller, NO Tauri bundle.
#
# Boots two long-running processes in the same terminal:
#
#   ① uvicorn nexus_server.main:create_app --factory --reload      (port 8001)
#      Auto-reloads on any Python file change.
#      Has every U3.3 endpoint (DELETE patient, /settings/llm,
#      /export/bundle) live from source.
#
#   ② pnpm tauri dev                              (port 1420 → Tauri shell)
#      Auto-reloads the React UI on .tsx save (Vite HMR).
#      Picks up Rust changes on next launch (Ctrl-C + restart).
#
# Ctrl-C kills both. Logs to /tmp/nexus-dev-{server,desktop}.log.
#
# What this avoids:
#   - The 5-15 min PyInstaller + Tauri release build.
#   - The "rebuild → reinstall .dmg → relaunch" cycle.
#   - The whole pnpm-ignored-builds gate (only fires during release build).
#
# Trade-off: this runs the source-tree Python directly, not a bundled
# binary. Differences: file paths, working dir, log location all match
# your dev shell, not what users see in production. Use the full
# clean-rebuild-reinstall.sh once you're ready to ship.

set -euo pipefail

DESKTOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_ROOT/../.." && pwd)"
SERVER_ROOT="$REPO_ROOT/packages/server"
VENV="$SERVER_ROOT/.venv"

cyan()  { printf "\033[1;36m▶ %s\033[0m\n" "$*"; }
green() { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
red()   { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; }

# ── Sanity: venv must exist
if [ ! -x "$VENV/bin/python3" ]; then
  red "no venv at $VENV — run ./scripts/build-macos.sh once to bootstrap"
  exit 1
fi

# ── Free up port 8001 if a previous run died holding it
if lsof -ti tcp:8001 >/dev/null 2>&1; then
  cyan "freeing port 8001"
  lsof -ti tcp:8001 | xargs kill -9 2>/dev/null || true
fi

# ── Boot the FastAPI server with auto-reload
SERVER_LOG="/tmp/nexus-dev-server.log"
DESKTOP_LOG="/tmp/nexus-dev-desktop.log"

cyan "starting nexus_server (auto-reload) → $SERVER_LOG"
(
  cd "$SERVER_ROOT"
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  # Mirror Tauri's spawn-env so the in-source server sees the user's keys
  export NEXUS_HOST=127.0.0.1
  export NEXUS_PORT=8001
  export CORS_ALLOW_ORIGINS="*"
  export RUNE_HOME="$HOME/Library/Application Support/RuneProtocol"
  # Source the user's .env so GEMINI_API_KEY etc reach the process.
  if [ -f "$RUNE_HOME/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$RUNE_HOME/.env"
    set +a
  fi
  exec python3 -m uvicorn nexus_server.main:create_app --factory \
        --host 127.0.0.1 --port 8001 --reload \
        --reload-dir nexus_server
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
green "server pid: $SERVER_PID"

# Wait for /healthz to come up
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8001/healthz >/dev/null 2>&1; then
    green "server reachable on http://127.0.0.1:8001"
    break
  fi
  sleep 1
done

# ── Boot Tauri dev shell
cyan "starting Tauri dev shell → $DESKTOP_LOG"
(
  cd "$DESKTOP_ROOT"
  exec pnpm tauri dev
) >"$DESKTOP_LOG" 2>&1 &
TAURI_PID=$!
green "tauri pid: $TAURI_PID"

cleanup() {
  echo
  cyan "stopping dev loop"
  kill "$SERVER_PID" "$TAURI_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  green "stopped."
}
trap cleanup INT TERM EXIT

cat <<EOF

──────────────────────────────────────────────────────────────────────
  Dev loop running.
  Server log:   tail -F $SERVER_LOG
  Desktop log:  tail -F $DESKTOP_LOG
  Server:       http://127.0.0.1:8001  (auto-reloads on Python edits)
  Tauri shell:  opens as a window (auto-reloads on .tsx edits)

  When something breaks, paste the last 30 lines of whichever log:
     tail -n 30 $SERVER_LOG
     tail -n 30 $DESKTOP_LOG

  Ctrl-C here stops both.
──────────────────────────────────────────────────────────────────────
EOF

# Block until either child dies or user Ctrl-Cs
wait
