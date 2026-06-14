#!/usr/bin/env bash
# Complete from-scratch rebuild + reinstall.
#
# What this does, in order:
#   1. Kills any running Nexus.app + sidecar (frees port 8001).
#   2. Removes /Applications/Nexus.app so the new install isn't merged
#      with the old one.
#   3. Runs build-macos.sh --clean --force-pyinstaller — wipes every
#      cache (server build/dist, node_modules, src-tauri/target, staged
#      sidecar binary) and forces a from-zero rebuild.
#   4. Sanity-checks the new .app contents — bundled resources, sidecar
#      binary, build identity stamp, LLM keys in default.env.
#   5. Opens the .dmg so you can drag-install the new Nexus.app.
#
# Use this when you've changed Python OR Rust OR frontend code and
# want to be 100% sure the install reflects the diff. For incremental
# rebuilds (just edited a .tsx file), regular `./scripts/build-macos.sh`
# is much faster — the source-hash check skips the Python step when
# nothing in server-side has actually changed.
#
# User data at ~/Library/Application Support/RuneProtocol/.env SURVIVES
# this — the Tauri seed/merge on launch preserves any local overrides.

set -euo pipefail

DESKTOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pushd "$DESKTOP_ROOT" >/dev/null

cyan()  { printf "\033[1;36m▶ %s\033[0m\n" "$*"; }
green() { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
red()   { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; }

# ── 1. Stop running Nexus ────────────────────────────────────────────
# Aggressive teardown — graceful TERM first, then SIGKILL the holdouts.
# Port :8001 sometimes lingers in TIME_WAIT or under a stray uvicorn
# spawned by `pnpm dev`; the wait-loop below guarantees it's free
# before the rebuild produces a new sidecar.
cyan "stopping any running Nexus"
osascript -e 'quit app "Nexus"' >/dev/null 2>&1 || true
sleep 1
pkill -TERM -f nexus-server >/dev/null 2>&1 || true
sleep 1
pkill -KILL -f nexus-server >/dev/null 2>&1 || true

for _i in 1 2 3 4 5; do
  pids="$(lsof -ti tcp:8001 2>/dev/null || true)"
  if [ -z "$pids" ]; then break; fi
  cyan "killing pid(s) on tcp:8001 → $pids"
  echo "$pids" | xargs kill -9 2>/dev/null || true
  sleep 1
done

# ── 2. Remove previous install ───────────────────────────────────────
if [ -d "/Applications/Nexus.app" ]; then
  cyan "removing /Applications/Nexus.app (previous install)"
  rm -rf "/Applications/Nexus.app"
fi

# ── 3. Clean + force rebuild ─────────────────────────────────────────
cyan "running build-macos.sh --clean --force-pyinstaller (this takes 5-15 min)"
LOG="/tmp/nexus-build-$(date +%s).log"
if ! ./scripts/build-macos.sh --clean --force-pyinstaller 2>&1 | tee "$LOG"; then
  red "build failed — full log at $LOG"
  exit 1
fi
green "build complete — log at $LOG"

# ── 4. Sanity-check the new .app ─────────────────────────────────────
APP="src-tauri/target/release/bundle/macos/Nexus.app"
DMG_DIR="src-tauri/target/release/bundle/dmg"

echo
cyan "── New .app contents ──"
[ -d "$APP" ] || { red "expected $APP, not found"; exit 1; }

# Resources directory
RES="$APP/Contents/Resources/resources"
echo "  Resources:"
ls -1 "$RES" 2>/dev/null | sed 's|^|    |'
for needed in default.env server.build_info; do
  if [ ! -f "$RES/$needed" ]; then
    red "  MISSING: $RES/$needed"
    exit 1
  fi
done
green "  default.env + server.build_info present"

# Sidecar binary
SIDECAR="$APP/Contents/Resources/nexus-server-aarch64-apple-darwin"
if [ ! -f "$SIDECAR" ]; then
  # Tauri may put it elsewhere across versions; fallback search.
  SIDECAR="$(find "$APP" -name 'nexus-server*' -type f | head -1)"
fi
if [ -z "$SIDECAR" ] || [ ! -f "$SIDECAR" ]; then
  red "  sidecar binary not bundled — Tauri sidecar registration failed"
  exit 1
fi
echo "  Sidecar: $SIDECAR ($(du -h "$SIDECAR" | cut -f1))"
green "  PyInstaller binary present"

# Build identity
echo
echo "  ── Build identity ──"
cat "$RES/server.build_info" | sed 's|^|    |'

# LLM keys check
echo
echo "  ── LLM keys shipped ──"
if ! grep -q "^GEMINI_API_KEY=." "$RES/default.env"; then
  red "  GEMINI_API_KEY not set in bundled default.env"
  exit 1
fi
grep -E "^(GEMINI|OPENAI|ANTHROPIC|TAVILY)_API_KEY=" "$RES/default.env" \
  | sed -E 's|^([A-Z_]+)=(....).*|    \1=\2…(redacted)|'
green "  bundled keys verified"

# ── 5. Open the .dmg ─────────────────────────────────────────────────
echo
DMG="$(ls "$DMG_DIR"/*.dmg 2>/dev/null | head -1)"
if [ -z "$DMG" ]; then
  red "no .dmg produced under $DMG_DIR"
  exit 1
fi
green "DMG: $DMG"

cat <<EOF

──────────────────────────────────────────────────────────────────────
  Next:
    1. A Finder window will open showing the new Nexus.app.
    2. Drag Nexus.app into the Applications folder.
       (macOS will prompt — click Replace.)
    3. Launch from /Applications:
         xattr -dr com.apple.quarantine /Applications/Nexus.app
         open /Applications/Nexus.app
    4. Tail the server log to verify env seed/merge:
         tail -F ~/Library/Logs/io.runeprotocol.nexus/nexus.log
──────────────────────────────────────────────────────────────────────
EOF

open "$DMG"
popd >/dev/null
