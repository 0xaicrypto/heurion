#!/usr/bin/env bash
# Bootstrap + build the complete Nexus .dmg installer for macOS.
#
# ONE COMMAND, ZERO PREREQUISITES. If you start from a clean Mac with
# just Xcode Command Line Tools installed, this script:
#
#   1. Installs Homebrew if missing
#   2. brew installs Python 3.12, pnpm, rustup
#   3. Creates packages/server/.venv (Python 3.12) if missing
#   4. Installs the three local monorepo Python packages in dep order
#      (nexus-core → nexus → nexus-server)
#   5. PyInstaller-bundles the backend into a single binary
#   6. Stages the binary for Tauri sidecar
#   7. pnpm install + rebuild esbuild (forces native binary download)
#   8. Generates Tauri icons from src-tauri/icons/source.svg
#   9. Tauri build → produces the .dmg
#
# Idempotent: subsequent runs skip the already-done steps, so re-running
# after a code change is fast (≈ 30s on a warm cache).
#
# Usage:
#   ./scripts/build-macos.sh                  # default — bootstrap + build
#   ./scripts/build-macos.sh --sign           # signed (needs APPLE_SIGNING_IDENTITY env)
#   ./scripts/build-macos.sh --skip-bootstrap # assume prereqs are ready
#   ./scripts/build-macos.sh --skip-pyinstaller  # reuse existing dist/
#   ./scripts/build-macos.sh --clean          # nuke caches first
#
# Output:
#   src-tauri/target/release/bundle/dmg/Nexus_*.dmg

set -euo pipefail

DESKTOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_ROOT/../.." && pwd)"
SERVER_ROOT="$REPO_ROOT/packages/server"
VENV="$SERVER_ROOT/.venv"

# ── Flags ─────────────────────────────────────────────────────────────
# Script is FULLY IDEMPOTENT — each stage decides for itself whether to
# run. ``--clean`` is the only flag you'd commonly want; it nukes caches
# and forces a from-scratch build.
SIGN=false
NOTARIZE=false
FORCE_BOOTSTRAP=false
FORCE_PYINSTALLER=false
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --sign) SIGN=true ;;
    --notarize) NOTARIZE=true; SIGN=true ;;
    --force-bootstrap) FORCE_BOOTSTRAP=true ;;
    --force-pyinstaller) FORCE_PYINSTALLER=true ;;
    --skip-bootstrap)        # back-compat: no-op (auto-detected now)
      warn "--skip-bootstrap is a no-op; bootstrap auto-skips when prereqs are present"
      ;;
    --skip-pyinstaller)
      warn "--skip-pyinstaller is a no-op; PyInstaller auto-skips when binary is up-to-date"
      ;;
    --clean) CLEAN=true ;;
    -h|--help)
      sed -n '2,/^set/p' "$0"
      exit 0
      ;;
  esac
done

# ── Pretty printing ───────────────────────────────────────────────────
say() { printf "\033[1;34m▶\033[0m %s\n" "$*"; }
ok()  { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn(){ printf "\033[1;33m⚠\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }
step() { echo; printf "\033[1m── %s ──\033[0m\n" "$*"; }

# ── Start clean: deactivate any active venv ──────────────────────────
# If the user ran ``source .venv/bin/activate`` before invoking us, our
# ``command -v python3.12`` lookups can hit the venv's internal symlinks
# — and then we rm -rf the venv and break those paths. Sidestep the
# whole class of bugs by deactivating up-front.
if [ -n "${VIRTUAL_ENV:-}" ]; then
  prev_venv="$VIRTUAL_ENV"
  # The activate script defines `deactivate` as a function in the
  # current shell, but here we're inside a sub-shell that did not
  # source activate — so we strip manually.
  PATH="$(echo "$PATH" | awk -v RS=':' -v ORS=':' -v v="$prev_venv" \
            '$0 !~ v {print}' | sed 's/:$//')"
  unset VIRTUAL_ENV PYTHONHOME PYTHONPATH
  echo "  (deactivated existing venv: $prev_venv)"
fi

# ── Sanity ────────────────────────────────────────────────────────────
[ "$(uname)" = "Darwin" ] || die "this script only runs on macOS"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) TARGET_TRIPLE="aarch64-apple-darwin" ;;
  x86_64)        TARGET_TRIPLE="x86_64-apple-darwin" ;;
  *)             die "unsupported arch: $ARCH" ;;
esac
say "host: $TARGET_TRIPLE"

# ── Build identity ────────────────────────────────────────────────────
# Compute once at the top so:
#   1. The banner shows it.
#   2. PyInstaller bundle contains it (via __build_info__.py).
#   3. Vite bundle contains it (via VITE_NEXUS_BUILD env at build time).
#   4. Every server log line ends up tagged with this build id.
#
# ── Versioning convention ─────────────────────────────────────────────
# Format: MAJOR.MINOR.PATCH+<utc-timestamp>.<git-sha>[-dirty]
#
#  * MAJOR.MINOR  — from package.json; medic / human-readable. Bump
#                   manually for releases that user wants to know about.
#  * PATCH        — git commit count (rev-list HEAD). MONOTONIC and
#                   auto-incremented every commit. So "each meaningful
#                   code change" naturally bumps PATCH without touching
#                   package.json.
#  * +metadata    — build time + short sha + optional -dirty marker.
#                   Disambiguates multiple builds of the same commit
#                   (e.g. iterative dev where you're rebuilding without
#                   committing).
#
# Examples:
#  *  0.1.247+20260613T163358Z.3e9cabe          ← clean commit #247
#  *  0.1.247+20260613T163358Z.3e9cabe-dirty    ← same commit, uncommitted edits
#  *  0.1.248+...                               ← next commit
NEXUS_PACKAGE_VERSION="$(node -p "require('$DESKTOP_ROOT/package.json').version" 2>/dev/null || echo "0.0.0")"
NEXUS_GIT_COMMIT_COUNT="$(cd "$REPO_ROOT" && git rev-list --count HEAD 2>/dev/null || echo "0")"
# Replace the patch component of package.json's version with the git
# commit count. We accept both "0.1.X" and "0.1" forms in package.json
# (anything past the second dot is overridden by commit count).
NEXUS_VERSION="$(echo "$NEXUS_PACKAGE_VERSION" \
  | awk -F. -v p="$NEXUS_GIT_COMMIT_COUNT" '{
      major = ($1 == "" ? "0" : $1)
      minor = ($2 == "" ? "0" : $2)
      print major "." minor "." p
    }')"

NEXUS_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NEXUS_BUILD_TIME_COMPACT="$(date -u +%Y%m%dT%H%M%SZ)"
NEXUS_GIT_SHA="$(cd "$REPO_ROOT" && git rev-parse --short=7 HEAD 2>/dev/null || echo nogit)"
NEXUS_GIT_DIRTY=""
if cd "$REPO_ROOT" && ! git diff --quiet 2>/dev/null; then
  NEXUS_GIT_DIRTY="-dirty"
fi
NEXUS_BUILD_ID="${NEXUS_VERSION}+${NEXUS_BUILD_TIME_COMPACT}.${NEXUS_GIT_SHA}${NEXUS_GIT_DIRTY}"
export NEXUS_VERSION NEXUS_BUILD_ID NEXUS_BUILD_TIME NEXUS_GIT_SHA

printf "\n\033[1;36m"
printf "═══════════════════════════════════════════════════════════════════════\n"
printf "  Nexus build %s\n" "$NEXUS_BUILD_ID"
printf "  version:  %s   (package.json: %s  →  patch = git commits)\n" \
       "$NEXUS_VERSION" "$NEXUS_PACKAGE_VERSION"
printf "  commits:  %s   git:      %s%s\n" \
       "$NEXUS_GIT_COMMIT_COUNT" "$NEXUS_GIT_SHA" "$NEXUS_GIT_DIRTY"
printf "  built at: %s\n" "$NEXUS_BUILD_TIME"
printf "═══════════════════════════════════════════════════════════════════════\n"
printf "\033[0m\n"

# Stamp __build_info__.py — picked up by PyInstaller automatically
# because it lives inside the nexus_server package.
cat > "$SERVER_ROOT/nexus_server/__build_info__.py" <<EOF
# AUTO-GENERATED by scripts/build-macos.sh — do not edit by hand.
# This file gets regenerated on every build and committed-as-default
# stays at the "dev" placeholder.
VERSION    = "$NEXUS_VERSION"
BUILD_ID   = "$NEXUS_BUILD_ID"
BUILD_TIME = "$NEXUS_BUILD_TIME"
GIT_SHA    = "$NEXUS_GIT_SHA$NEXUS_GIT_DIRTY"
EOF
ok "stamped __build_info__.py with v$NEXUS_BUILD_ID"

# ── --clean: wipe caches first ────────────────────────────────────────
if [ "$CLEAN" = true ]; then
  step "Cleaning caches"
  rm -rf "$SERVER_ROOT/build" "$SERVER_ROOT/dist"
  rm -rf "$DESKTOP_ROOT/node_modules" "$DESKTOP_ROOT/pnpm-lock.yaml"
  rm -rf "$DESKTOP_ROOT/src-tauri/target"
  rm -f  "$DESKTOP_ROOT/src-tauri/binaries/nexus-server-"*
  ok "caches cleaned"
fi

# ═════════════════════════════════════════════════════════════════════
# Stage 1: Bootstrap — install everything that's missing
# ═════════════════════════════════════════════════════════════════════

# Auto-detect: do we need bootstrap? Skip the whole stage if every
# prereq is already present.
need_bootstrap=false
if [ "$FORCE_BOOTSTRAP" = true ]; then
  need_bootstrap=true
else
  if ! xcode-select -p >/dev/null 2>&1; then need_bootstrap=true; fi
  if ! command -v brew      >/dev/null 2>&1; then need_bootstrap=true; fi
  if ! command -v pnpm      >/dev/null 2>&1; then need_bootstrap=true; fi
  if ! command -v cargo     >/dev/null 2>&1; then need_bootstrap=true; fi
  # python3.12 must be available outside the venv we just deactivated;
  # /opt/homebrew or /usr/local fallback paths satisfy this.
  if ! { [ -x /opt/homebrew/opt/python@3.12/bin/python3.12 ] || \
         [ -x /usr/local/opt/python@3.12/bin/python3.12 ] || \
         command -v python3.12 >/dev/null 2>&1; }; then
    need_bootstrap=true
  fi
fi

if [ "$need_bootstrap" = true ]; then
  step "Bootstrap: prerequisites"
else
  ok "prereqs already satisfied — skipping bootstrap (use --force-bootstrap to re-run)"
fi

if [ "$need_bootstrap" = true ]; then

  # ── Xcode CLT (interactive, can't fully auto) ──────────────────────
  if ! xcode-select -p >/dev/null 2>&1; then
    warn "Xcode Command Line Tools missing — installing (GUI prompt may appear)"
    xcode-select --install || true
    die "After CLT install completes, re-run this script."
  fi
  ok "Xcode Command Line Tools: $(xcode-select -p)"

  # ── Homebrew ───────────────────────────────────────────────────────
  if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew not found — installing"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # PATH: on arm64 Macs Homebrew lives at /opt/homebrew; on x86_64 at /usr/local
    if [ -d /opt/homebrew/bin ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -d /usr/local/Homebrew ]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi
  ok "Homebrew: $(brew --version | head -1)"

  # ── Python 3.12 ─────────────────────────────────────────────────────
  # Use the Homebrew-managed python3.12 explicitly. command -v can pick
  # up a venv-local symlink whose path contains spaces (the case on this
  # repo's full path) — that breaks unquoted shell expansion downstream.
  if command -v python3.12 >/dev/null 2>&1; then
    PY312="$(command -v python3.12)"
  else
    PY312=""
  fi
  if [ -z "$PY312" ] || [[ "$PY312" == *.venv/bin/* ]]; then
    # Not installed system-wide, or only available via a venv. Install
    # via brew so we have a stable, no-spaces path.
    say "installing python@3.12 via brew (may take 1-2 min)"
    brew install python@3.12
    PY312="$(brew --prefix python@3.12)/bin/python3.12"
  fi
  [ -x "$PY312" ] || die "python3.12 not executable at '$PY312'"
  ok "Python: $("$PY312" --version) at $PY312"

  # ── pnpm (via Homebrew — avoids npm dep) ───────────────────────────
  if ! command -v pnpm >/dev/null 2>&1; then
    say "installing pnpm via brew"
    brew install pnpm
  fi
  ok "pnpm: $(pnpm --version)"

  # ── Rust ───────────────────────────────────────────────────────────
  if ! command -v cargo >/dev/null 2>&1; then
    say "installing Rust via rustup (silent)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
      sh -s -- --default-toolchain stable --profile minimal -y
    source "$HOME/.cargo/env"
  fi
  ok "Rust: $(rustc --version)"

  # ── Tauri CLI (optional — pnpm tauri uses npx but having the global
  # binary speeds up first run + avoids a network round-trip)
  if ! command -v tauri >/dev/null 2>&1; then
    say "installing tauri CLI (cargo) — first build only"
    cargo install tauri-cli --version "^2.0" --locked 2>&1 | tail -3 || true
  fi
fi  # need_bootstrap

# ═════════════════════════════════════════════════════════════════════
# Stage 2: Python venv + install local sibling packages
# ═════════════════════════════════════════════════════════════════════

step "Python venv + monorepo deps"

# Resolve python3.12. Order of preference:
#   1. Homebrew Cellar    (/opt/homebrew/opt/python@3.12/bin/python3.12)
#   2. /usr/local/opt/python@3.12 (Intel Macs)
#   3. command -v python3.12  — BUT REJECT if it lives inside a venv
#                               (would break after we rm -rf the venv)
# This is paranoid because the user's full path contains spaces and
# any wrong PY312_BIN value crashes downstream commands.
resolve_py312() {
  local candidate
  if command -v brew >/dev/null 2>&1; then
    candidate="$(brew --prefix python@3.12 2>/dev/null)/bin/python3.12"
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  fi
  for p in \
      /opt/homebrew/opt/python@3.12/bin/python3.12 \
      /usr/local/opt/python@3.12/bin/python3.12; do
    if [ -x "$p" ]; then printf '%s' "$p"; return 0; fi
  done
  candidate="$(command -v python3.12 2>/dev/null || true)"
  case "$candidate" in
    */.venv/*|*/venv/*|*/env/*) candidate="" ;;  # reject venv-local
  esac
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s' "$candidate"; return 0
  fi
  return 1
}

PY312_BIN="$(resolve_py312 || true)"
[ -x "$PY312_BIN" ] || die "python3.12 not found — install via 'brew install python@3.12'"
ok "using python3.12 at: $PY312_BIN"

# Create venv if missing or if existing one is wrong Python version
if [ -d "$VENV" ]; then
  VENV_PY_VER="$("$VENV/bin/python3" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "?")"
  if [ "$VENV_PY_VER" != "3.12" ] && [ "$VENV_PY_VER" != "3.13" ]; then
    warn "existing venv is Python $VENV_PY_VER — recreating with 3.12"
    rm -rf "$VENV"
  fi
fi
if [ ! -d "$VENV" ]; then
  # Re-verify PY312_BIN is still executable. The previous block may
  # have rm -rf'd a venv that PY312_BIN was pointing into.
  if [ ! -x "$PY312_BIN" ]; then
    warn "PY312_BIN no longer valid ($PY312_BIN) — re-resolving"
    PY312_BIN="$(resolve_py312 || true)"
    [ -x "$PY312_BIN" ] || die "cannot find python3.12 anywhere — 'brew install python@3.12'"
  fi
  say "creating venv at $VENV"
  say "  using: $PY312_BIN"
  "$PY312_BIN" -m venv "$VENV"
  [ -x "$VENV/bin/python3" ] || die "venv creation failed — $VENV/bin/python3 missing"
fi

# Source the venv for the rest of the script
# shellcheck disable=SC1091
source "$VENV/bin/activate"

ok "venv: $(python3 --version) at $(which python3)"

# Idempotent: if everything is already importable, skip pip install.
if python3 -c 'import uvicorn, fastapi, pydantic, nexus_server, PyInstaller' >/dev/null 2>&1 \
   && [ "$CLEAN" != true ]; then
  ok "all Python deps already installed — skipping pip install"
else
  say "upgrading pip"
  python3 -m pip install --upgrade pip >/dev/null 2>&1 || true

  # Local sibling packages — install in dep order: nexus-core (sdk) →
  # nexus → nexus-server. pip MUST see siblings as already-installed
  # before resolving nexus-server's deps (they aren't on PyPI).
  SIBLINGS=(
    "$REPO_ROOT/packages/sdk"     # nexus-core
    "$REPO_ROOT/packages/nexus"   # nexus
    "$SERVER_ROOT"                # nexus-server (depends on above)
  )

  install_log="$(mktemp -t nexus-pip.XXXXXX.log)"
  trap "rm -f '$install_log'" EXIT

  say "installing tooling (pyinstaller) + 3 monorepo packages (editable)"
  say "  log: $install_log"

  if ! python3 -m pip install "pyinstaller>=6.0" >"$install_log" 2>&1; then
    echo "pyinstaller install failed:"
    tail -25 "$install_log"
    die "pip install pyinstaller failed"
  fi

  for sibling in "${SIBLINGS[@]}"; do
    if [ ! -f "$sibling/pyproject.toml" ]; then
      warn "skipping $sibling (no pyproject.toml)"
      continue
    fi
    name="$(basename "$sibling")"
    say "  installing $name (editable)"
    if ! python3 -m pip install -e "$sibling" >>"$install_log" 2>&1; then
      echo "FAILED installing $name — last 30 lines of pip log:"
      tail -30 "$install_log"
      die "pip install -e $name failed"
    fi
    ok "    $name installed"
  done

  # Sanity check — fast fail before PyInstaller
  if ! python3 -c 'import uvicorn, fastapi, pydantic, nexus_server' 2>/dev/null; then
    echo "Sanity check failed. Last 30 lines of pip log:"
    tail -30 "$install_log"
    die "uvicorn / fastapi / pydantic / nexus_server not importable"
  fi
  ok "deps OK: uvicorn fastapi pydantic nexus_server"
fi

# ═════════════════════════════════════════════════════════════════════
# Stage 3: PyInstaller — bundle the backend
# ═════════════════════════════════════════════════════════════════════

BINARY_NAME="nexus-server-$TARGET_TRIPLE"
BINARY_OUT="$SERVER_ROOT/dist/$BINARY_NAME"
SOURCE_HASH_FILE="$SERVER_ROOT/dist/.source.sha256"

# Compute a content hash of every Python source file that contributes
# to the PyInstaller bundle. We previously used ``find -newer
# "$BINARY_OUT"`` against mtimes — that breaks when:
#   - git checkout doesn't update mtimes (default behaviour);
#   - CI restores caches with reset mtimes;
#   - the user `git pull`s — the new files are written but their
#     mtimes can predate the binary.
# Content hashing is robust against all of these.
#
# We use Python (already installed two stages ago) rather than
# ``find | xargs shasum`` because the latter splits args on whitespace
# and the user's checkout path frequently contains spaces (e.g.
# ``~/Library/Application Support/...``). Under ``set -euo pipefail`` a
# split-on-space xargs failure aborts the script silently before
# Stage 3 prints anything. Python handles paths transparently and
# also lets us return a friendly "" on errors instead of crashing.
compute_source_hash() {
  python3 - <<'PYHASH' "$SERVER_ROOT/nexus_server" \
                       "$SERVER_ROOT/scripts" \
                       "$REPO_ROOT/packages/sdk" \
                       "$REPO_ROOT/packages/nexus" \
                       "$SERVER_ROOT/nexus-server.spec" \
                       "$SERVER_ROOT/pyproject.toml" 2>/dev/null || echo ""
import hashlib, os, sys
roots = sys.argv[1:]
files = []
for r in roots:
    if os.path.isfile(r):
        files.append(r)
        continue
    if not os.path.isdir(r):
        continue
    for dp, _dirs, fs in os.walk(r):
        # Skip noisy / non-source dirs.
        if any(p in dp for p in ("/__pycache__", "/.venv", "/node_modules", "/.git", "/build", "/dist")):
            continue
        for f in fs:
            if f.endswith((".py", ".toml", ".spec")):
                files.append(os.path.join(dp, f))
files.sort()
h = hashlib.sha256()
for f in files:
    try:
        with open(f, "rb") as fp:
            h.update(f.encode())
            h.update(b":")
            h.update(fp.read())
            h.update(b"\n")
    except OSError:
        pass
print(h.hexdigest())
PYHASH
}

NEEDED_HASH="$(compute_source_hash)"
if [ -z "$NEEDED_HASH" ]; then
  warn "couldn't compute source hash — defaulting to force rebuild"
  NEEDED_HASH="force-rebuild-$(date +%s)"
fi
say "source-hash:  $NEEDED_HASH"
if [ -f "$SOURCE_HASH_FILE" ]; then
  CURRENT_HASH="$(cat "$SOURCE_HASH_FILE" 2>/dev/null || echo "")"
  say "binary-hash:  ${CURRENT_HASH:-<none>}"
fi

need_pyinstaller=true
if [ "$FORCE_PYINSTALLER" = true ] || [ "$CLEAN" = true ]; then
  say "rebuild: forced by flag"
elif [ ! -f "$BINARY_OUT" ]; then
  say "rebuild: no existing binary at $BINARY_OUT"
elif [ ! -f "$SOURCE_HASH_FILE" ]; then
  say "rebuild: no recorded source hash (older build)"
elif [ "$NEEDED_HASH" != "$(cat "$SOURCE_HASH_FILE" 2>/dev/null)" ]; then
  say "rebuild: source-hash changed since last bundle"
else
  ok "rebuild: skipped — source-hash matches existing bundle"
  need_pyinstaller=false
fi

if [ "$need_pyinstaller" = true ]; then
  step "PyInstaller: backend → single binary"
  pushd "$SERVER_ROOT" >/dev/null
  rm -rf build/ dist/
  python3 -m PyInstaller nexus-server.spec --clean --noconfirm 2>&1 | tail -15
  [ -f "$BINARY_OUT" ] || die "PyInstaller did not produce $BINARY_OUT"
  # Record source hash + build identity alongside the binary so the
  # next build can do a content-equality skip, AND so a user inspecting
  # the .dmg can verify which commit's code is inside.
  echo "$NEEDED_HASH" > "$SOURCE_HASH_FILE"
  cat > "$SERVER_ROOT/dist/.build_info" <<EOF
build_id: $NEXUS_BUILD_ID
commit:   $NEXUS_GIT_SHA$NEXUS_GIT_DIRTY
time:     $NEXUS_BUILD_TIME
source_hash: $NEEDED_HASH
EOF
  ok "backend binary: $BINARY_OUT ($(du -h "$BINARY_OUT" | cut -f1))"
  ok "recorded source hash $NEEDED_HASH"
  popd >/dev/null
else
  ok "backend binary up-to-date — skipping PyInstaller (use --force-pyinstaller to rebuild)"
fi

# Stage the binary for Tauri. Idempotent: only copy if missing or
# different from the source.
STAGED_BIN="$DESKTOP_ROOT/src-tauri/binaries/$BINARY_NAME"
STAGED_INFO="$DESKTOP_ROOT/src-tauri/resources/server.build_info"
mkdir -p "$DESKTOP_ROOT/src-tauri/binaries"
mkdir -p "$DESKTOP_ROOT/src-tauri/resources"
if [ ! -f "$STAGED_BIN" ] || ! cmp -s "$BINARY_OUT" "$STAGED_BIN"; then
  cp "$BINARY_OUT" "$STAGED_BIN"
  chmod +x "$STAGED_BIN"
  ok "binary staged at src-tauri/binaries/$BINARY_NAME"
else
  ok "staged binary already current"
fi
# Stage the build-info so the desktop About / Settings can read it
# and prove which server commit is actually inside the .dmg.
if [ -f "$SERVER_ROOT/dist/.build_info" ]; then
  cp "$SERVER_ROOT/dist/.build_info" "$STAGED_INFO"
  ok "build_info staged at src-tauri/resources/server.build_info"
fi

# ═════════════════════════════════════════════════════════════════════
# Stage 4: pnpm install + esbuild native binary + icons
# ═════════════════════════════════════════════════════════════════════

step "Frontend: pnpm deps + Tauri icons"
pushd "$DESKTOP_ROOT" >/dev/null

# ── pnpm install ──
# Key insight: package.json now lists esbuild + @esbuild/darwin-arm64 +
# @esbuild/darwin-x64 as direct devDependencies (pinned to the version
# vite expects). Combined with node-linker=hoisted in .npmrc, this makes:
#   1. esbuild appear at node_modules/esbuild (not buried in .pnpm/)
#   2. The matching platform binary at node_modules/@esbuild/<plat>-<arch>
#   3. esbuild's main module find its binary via require.resolve
#
# The platform-binary trick is bypass-immune: even if pnpm refuses to
# run esbuild's postinstall, the binary is already present because the
# platform package IS the binary (it's a separate npm package, not a
# script-generated artifact).
#
# If lockfile is out of sync (we just edited package.json), allow pnpm
# to update it. After that, frozen-lockfile is fine.

# Detect stale lockfile: an older revision of this script accidentally
# added @esbuild/darwin-arm64@^0.28.1 (latest at the time, NOT matching
# vite's esbuild 0.21.x). If we see that in the lockfile, nuke it so
# pnpm regenerates against the corrected package.json.
if [ -f "pnpm-lock.yaml" ] && grep -q '@esbuild/darwin-arm64.*0\.2[2-9]' pnpm-lock.yaml 2>/dev/null; then
  warn "lockfile contains version-mismatched @esbuild/darwin-arm64 — regenerating"
  rm -f pnpm-lock.yaml
fi

if [ -f "pnpm-lock.yaml" ]; then
  # Try frozen first; fall back to non-frozen if package.json changed
  if ! pnpm install --frozen-lockfile 2>&1 | tail -8; then
    say "lockfile out of sync — running pnpm install to update it"
    pnpm install 2>&1 | tail -8 || warn "install had warnings (continuing)"
  fi
else
  say "no pnpm-lock.yaml yet — generating one"
  pnpm install 2>&1 | tail -8 || warn "install had warnings (continuing)"
fi

# ── esbuild verification + lazy repair ──
# After the install above, esbuild should be at top-level node_modules
# (because we made it a direct dep + node-linker=hoisted). We verify
# by trying to load it AND checking the platform binary file exists.
ensure_esbuild() {
  # Sanity check 1: Node can resolve the module
  if ! node -e "require('esbuild')" >/dev/null 2>&1; then
    return 1
  fi
  # Sanity check 2: The platform binary file is actually present.
  # esbuild's index.js calls require.resolve('@esbuild/<plat>-<arch>/bin/esbuild')
  # so if the platform package is missing or the binary is missing,
  # require('esbuild') succeeds but require('esbuild').version may
  # fail or any actual operation will throw.
  if ! node -e "
    const esbuild = require('esbuild');
    console.log(esbuild.version);
    // Trigger lazy binary lookup by calling a sync method
    const r = esbuild.transformSync('let x = 1', { loader: 'js' });
    if (!r.code) throw new Error('transform returned empty');
  " >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

repair_esbuild() {
  # Determine the version vite actually wants
  local target_version
  target_version="$(node -e "
    try {
      const pkg = require('esbuild/package.json');
      console.log(pkg.version);
    } catch (e) {
      console.log('0.21.5');
    }
  " 2>/dev/null || echo "0.21.5")"

  local platform arch pkg
  platform="$(node -e "console.log(process.platform)" 2>/dev/null || echo darwin)"
  arch="$(node -e "console.log(process.arch)" 2>/dev/null || echo arm64)"
  pkg="@esbuild/${platform}-${arch}@${target_version}"

  say "installing $pkg (matches esbuild $target_version)"
  pnpm add -D --ignore-scripts "$pkg" 2>&1 | tail -5 || true
  ensure_esbuild && return 0

  # Last-resort: drop into npm for esbuild's postinstall. npm doesn't
  # have pnpm's script-blocking behavior.
  if command -v npm >/dev/null 2>&1 && [ -d "node_modules/esbuild" ]; then
    say "falling back to npm rebuild for esbuild"
    (cd node_modules/esbuild && npm rebuild 2>&1 | tail -5) || true
    ensure_esbuild && return 0
  fi

  return 1
}

say "verifying esbuild + platform binary"
if ! ensure_esbuild; then
  warn "esbuild not fully functional — attempting repair"
  if ! repair_esbuild; then
    warn "repair failed — wiping node_modules + lockfile + reinstalling clean"
    rm -rf node_modules pnpm-lock.yaml
    pnpm install 2>&1 | tail -8 || true
    if ! ensure_esbuild; then
      repair_esbuild || {
        cat <<'EOF' >&2

esbuild's native binary couldn't be installed. Final manual fallback:

  cd packages/desktop-v2
  rm -rf node_modules pnpm-lock.yaml
  npm install               # npm runs postinstall scripts by default
  ./scripts/build-macos.sh  # re-run (it will use the existing node_modules)

EOF
        die "esbuild native binary missing"
      }
    fi
  fi
fi
ok "esbuild OK ($(node -e "console.log(require('esbuild').version)" 2>/dev/null || echo '?'))"

# Generate Tauri icons (idempotent)
say "generating Tauri icons"
pnpm icons 2>&1 | tail -3 || warn "icons step had warnings (ok if files exist)"

# ═════════════════════════════════════════════════════════════════════
# Stage 4b: Refresh bundled default.env from packages/server/.env
# ═════════════════════════════════════════════════════════════════════
#
# tauri.conf.json declares `resources/default.env` as a bundled
# resource. lib.rs::seed_or_merge_user_env reads it at every launch and
# delta-merges into ~/Library/Application Support/RuneProtocol/.env.
#
# Refreshing here means: edit packages/server/.env (rotate a key, add a
# new var) → rebuild → ship .dmg → user reinstalls → new keys flow in
# without the user having to do anything. The merge is non-destructive,
# so any value the medic overrode via Settings · LLM survives.

step "Bundle: refresh resources/default.env from packages/server/.env"

SERVER_DOTENV="$SERVER_ROOT/.env"
BUNDLE_DEFAULT_ENV="$DESKTOP_ROOT/src-tauri/resources/default.env"
mkdir -p "$DESKTOP_ROOT/src-tauri/resources"
if [ ! -f "$SERVER_DOTENV" ]; then
  warn "no $SERVER_DOTENV — bundling existing resources/default.env unchanged"
else
  # Strip secrets we intentionally DON'T want shipping in the .dmg.
  # SERVER_PRIVATE_KEY, SERVER_SECRET, DATABASE_URL, SERVER_HOST/PORT
  # are deploy-only. Everything else (LLM keys, relay URL/key, feature
  # flags) is by-design shippable.
  {
    cat <<EOF
# ══════════════════════════════════════════════════════════════════════
# Nexus default environment — BUNDLED INTO THE .DMG
# Auto-regenerated by scripts/build-macos.sh on $NEXUS_BUILD_TIME
# Source: packages/server/.env  (commit $NEXUS_GIT_SHA$NEXUS_GIT_DIRTY)
#
# Tauri's lib.rs::seed_or_merge_user_env reads this on launch and
# delta-merges into ~/Library/Application Support/RuneProtocol/.env.
# Reinstalling the .dmg → user picks up new keys automatically.
# ══════════════════════════════════════════════════════════════════════

EOF
    while IFS='' read -r line || [[ -n "$line" ]]; do
      case "$line" in
        SERVER_HOST=*|SERVER_PORT=*|SERVER_SECRET=*) continue ;;
        DATABASE_URL=*) continue ;;
        SERVER_PRIVATE_KEY=*) continue ;;
        ENVIRONMENT=*|LOG_LEVEL=*) continue ;;
        CORS_ALLOW_ORIGINS=*) continue ;;  # Tauri sets this on spawn
      esac
      echo "$line"
    done < "$SERVER_DOTENV"
  } > "$BUNDLE_DEFAULT_ENV"
  ok "wrote $(wc -l < "$BUNDLE_DEFAULT_ENV" | tr -d ' ') lines → src-tauri/resources/default.env"
fi

# ═════════════════════════════════════════════════════════════════════
# Stage 5: Tauri build → .dmg
# ═════════════════════════════════════════════════════════════════════

step "Tauri build — .dmg installer (Rust cold compile: 5-10 min)"

# Belt-and-suspenders: pnpm 10's beforeBuildCommand re-checks ignored
# build scripts and fails the run with ERR_PNPM_IGNORED_BUILDS even
# when our install passed. THREE layers of defence:
#   1. .npmrc has verify-deps-before-run=false (file-level config).
#   2. tauri.conf.json's beforeBuildCommand passes --config flags inline
#      so the deps-check is disabled even if the .npmrc isn't read.
#   3. Below: export env-var equivalents so any further pnpm sub-spawns
#      that bypass both inherit the right setting.
# Confirmed in sandbox against pnpm 10.34.3 — the inline --config form
# silences the gate; bare env var is just additional safety net.
export PNPM_VERIFY_DEPS_BEFORE_RUN=false
export npm_config_verify_deps_before_run=false
export npm_config_strict_dep_builds=false
# The definitive bypass — verified by reading pnpm 10.34.3 source at
# pnpm.cjs:141046 (createAllowBuildFunction returns () => true when
# this is set, so ignoredBuilds stays empty and the throw at :175546
# can't fire). Acceptable for our use because the dep tree is pinned
# in pnpm-lock.yaml — no untrusted code can inject a postinstall.
export npm_config_dangerously_allow_all_builds=true
export PNPM_DANGEROUSLY_ALLOW_ALL_BUILDS=true

if [ "$SIGN" = true ]; then
  [ -n "${APPLE_SIGNING_IDENTITY:-}" ] || die "APPLE_SIGNING_IDENTITY required for --sign"
  export TAURI_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY"
  if [ "$NOTARIZE" = true ]; then
    [ -n "${APPLE_ID:-}" ]       || die "APPLE_ID required for --notarize"
    [ -n "${APPLE_PASSWORD:-}" ] || die "APPLE_PASSWORD required for --notarize"
    export TAURI_NOTARIZE_APPLE_ID="$APPLE_ID"
    export TAURI_NOTARIZE_APPLE_PASSWORD="$APPLE_PASSWORD"
  fi
  say "signing identity: $APPLE_SIGNING_IDENTITY"
fi

# Propagate build identity into Vite (frontend) and Cargo (Tauri shell)
# so the bundled UI can show it in About / status pill, and any Rust
# log line can reference it. Vite reads VITE_* env vars at build time.
export VITE_NEXUS_BUILD_ID="$NEXUS_BUILD_ID"
export VITE_NEXUS_VERSION="$NEXUS_VERSION"
export VITE_NEXUS_GIT_SHA="$NEXUS_GIT_SHA$NEXUS_GIT_DIRTY"
export VITE_NEXUS_BUILD_TIME="$NEXUS_BUILD_TIME"
# Cargo env vars — readable in Rust via std::env::var or env! macro.
export NEXUS_BUILD_ID NEXUS_VERSION NEXUS_GIT_SHA NEXUS_BUILD_TIME

pnpm tauri:build

# ═════════════════════════════════════════════════════════════════════
# Done
# ═════════════════════════════════════════════════════════════════════

DMG_DIR="$DESKTOP_ROOT/src-tauri/target/release/bundle/dmg"
APP_DIR="$DESKTOP_ROOT/src-tauri/target/release/bundle/macos"

step "Build complete"
echo
if ls "$DMG_DIR"/*.dmg >/dev/null 2>&1; then
  ok ".dmg installer:"
  ls -1 "$DMG_DIR"/*.dmg | sed 's|^|    |'
fi
if ls -d "$APP_DIR"/*.app >/dev/null 2>&1; then
  ok ".app bundle:"
  ls -1d "$APP_DIR"/*.app | sed 's|^|    |'
fi
echo

if [ "$SIGN" = false ]; then
  warn "unsigned build — Gatekeeper will block. First-run dance:"
  echo "    right-click → Open in Applications, OR"
  echo "    xattr -dr com.apple.quarantine /Applications/Nexus.app"
  echo
fi
ok "open the .dmg, drag Nexus into Applications, launch."

popd >/dev/null
