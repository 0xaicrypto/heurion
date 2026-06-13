# Installing Nexus on macOS

Nexus ships as a single `.dmg` containing both the React desktop UI
**and** the FastAPI backend bundled as a sidecar binary. After install
the medic launches Nexus.app like any other Mac app — the backend starts
automatically.

## For end users (after we ship a signed build)

1. Download `Nexus_X.Y.Z_universal.dmg`
2. Open the .dmg, drag **Nexus** into Applications
3. Launch from Applications
4. First-time launch: macOS may ask for confirmation; click **Open**

That's it. Backend boots automatically on first launch (~2s); after
that you see the login screen.

App data lives in:

| Path | Contents |
|---|---|
| `~/Library/Application Support/Nexus/` | SQLite (`nexus.db`), runtime state |
| `~/Library/Nexus/files/` | content-addressed key images |
| `~/Library/Logs/Nexus/server.log` | backend log |
| `~/Documents/Nexus Archive/` | automatic Tier 2 daily archives |

Uninstall = drag Nexus.app to the Trash + delete the three Library
paths above. The `~/Documents/Nexus Archive/` is yours; we recommend
keeping it.

## For developers — building the .dmg from source

### Prerequisites

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# pnpm
npm install -g pnpm

# Xcode Command Line Tools
xcode-select --install

# Python 3.11+ (system Python is fine on macOS 14+)
python3 --version
```

### One command builds everything

```bash
cd packages/desktop-v2
./scripts/build-macos.sh
```

Pipeline (≈ 3–5 min on M2/M3, longer on first run):

1. **PyInstaller** bundles `packages/server/` into a single binary
2. **Copy binary** into `src-tauri/binaries/nexus-server-<triple>`
3. **Generate icons** from `src-tauri/icons/source.svg`
4. **Tauri build** produces the signed (if configured) `.dmg`

Output:

```
packages/desktop-v2/src-tauri/target/release/bundle/dmg/Nexus_*.dmg
packages/desktop-v2/src-tauri/target/release/bundle/macos/Nexus.app
```

Drop the .app into Applications or share the .dmg.

### Signed + notarized build (for distribution)

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"

./scripts/build-macos.sh --sign --notarize
```

The notarization step submits the bundle to Apple and waits for the
ticket — typically 5–15 minutes.

## Development mode (no install)

For iterating on the code, you don't need to rebuild the .dmg each time.
Run the backend and frontend separately:

```bash
# terminal 1 — backend (auto-reloads on Python changes)
cd packages/server
uvicorn nexus_server.main:app --reload --port 8001

# terminal 2 — frontend (Vite HMR + Tauri shell)
cd packages/desktop-v2
pnpm install
pnpm tauri:dev
```

In dev mode the Tauri sidecar is **disabled** by environment check;
the frontend talks to the manually-started uvicorn on `127.0.0.1:8001`
via Vite's proxy.

## What if it doesn't start?

**Symptom**: app launches but login says "Cannot reach server".

The backend sidecar failed. Check the log:

```bash
tail -100 ~/Library/Logs/Nexus/server.log
```

Common causes:

* **Port 8001 already in use** — another process has it. Quit it or set
  `NEXUS_PORT=8002` env var in `.env`.
* **PyInstaller binary won't execute** — Gatekeeper. If you're on an
  unsigned build, right-click Nexus.app → Open the first time so
  macOS asks for confirmation. Or run:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Nexus.app
  ```
* **Schema lock** — another Nexus instance left a stale `*.db-wal`
  file. Quit all Nexus processes, then:
  ```bash
  rm ~/Library/Application\ Support/Nexus/*.db-wal
  rm ~/Library/Application\ Support/Nexus/*.db-shm
  ```

## Uninstall + take your data with you

Before deleting Nexus, open it once more and run **Settings → Data →
Export all my data**. This produces a self-contained bundle in
`~/Documents/Nexus Archive/exports/` you can keep.

Per ADR-002 Rev-7 / Contract A: the export bundle is in open documented
formats and Nexus going away does not take your records with it.

Then:

```bash
# Quit Nexus first
osascript -e 'quit app "Nexus"'

# Remove the app
rm -rf /Applications/Nexus.app

# Remove the data (if you don't want to keep the SQLite DB)
rm -rf ~/Library/Application\ Support/Nexus
rm -rf ~/Library/Nexus
rm -rf ~/Library/Logs/Nexus
```

`~/Documents/Nexus Archive/` is yours — keep or delete as you like.
