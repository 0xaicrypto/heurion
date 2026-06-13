# Local-backend lifecycle (Phase 1)

When the user launches the macOS Nexus desktop app, it auto-spawns
`nexus_server` + `greenfield_daemon` on localhost and connects to
them. Quit the app → the helper processes get SIGTERM. No user
configuration needed beyond Homebrew being installed.

## Architecture

```
┌───────────────────────────────┐
│  Nexus.app  (Avalonia C#)     │
│                               │
│  App.axaml.cs                 │
│   ├─ on launch                │
│   │   ├─ ShouldUseLocalBackend? settings.ServerUrl empty/127.0.0.1
│   │   ├─ yes → SplashWindow.Show()                             ─────┐
│   │   └─ no  → MainWindow.Show()  (legacy remote-server path)       │
│   ├─ on quit                                                        │
│   └─ ShutdownRequested → Backend.StopAsync()                        │
│                                                                     │
│  SplashViewModel.RunBootAsync():                                    ▼
│    1. LocalBackend.EnsureSetupAsync() ─── runs setup.sh (first time)
│    2. LocalBackend.StartAsync()       ─── runs start.sh
│    3. SettingsStore.ServerUrl = url   ─── ApiClient picks it up
│    4. BootCompleted → swap to MainWindow
└───────────────────────────────┘
             │
             ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  ~/Library/Application Support/RuneProtocol/                │
   │                                                             │
   │   venv/                                ← Python 3.11 venv   │
   │   server.db                            ← SQLite (per-user)  │
   │   runtime.json                         ← url, port, pids    │
   │   setup.log / start.log / stop.log     ← script transcripts │
   │   server.log / daemon.log              ← spawned proc stdout│
   │   .setup_complete_v1                   ← marker file        │
   └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  spawned by start.sh
   ┌─────────────────────────────────────────────────────────────┐
   │  nexus_server (Python venv, FastAPI on 127.0.0.1:<port>)    │
   │  greenfield_daemon (Node.js, BNB Greenfield SDK)            │
   └─────────────────────────────────────────────────────────────┘
```

## The three scripts

| Script | When run | What it does |
| --- | --- | --- |
| `setup.sh REPO_ROOT` | First launch only | brew-install python/node if absent, create venv, `pip install -e packages/{sdk,nexus,server}`, `npm install` for daemon deps, write `.setup_complete_v1` |
| `start.sh` | Every launch | Re-use live runtime if `runtime.json` healthz passes, else pick free port, spawn server + daemon, wait for healthz, write `runtime.json` |
| `stop.sh` | App quit | SIGTERM → grace 5s → SIGKILL, then delete `runtime.json` |

All three tee to a log under `~/Library/Application Support/RuneProtocol/`
so we can diagnose any boot failure post-mortem.

## Testing dev-mode

```bash
# 1. From the repo, with brew + git + python@3.11 already present:
cd packages/desktop
dotnet run --project RuneDesktop.UI
```

The SplashWindow opens, you should see:

1. **First launch** — "Setting up Nexus (first run)" with `pip install ...`
   scrolling in the muted line. Takes 1–3 minutes.
2. **Subsequent launches** — "Starting agent runtime" with the
   healthz wait. Takes 2–5 seconds.

Confirm:

```bash
cat ~/Library/Application\ Support/RuneProtocol/runtime.json
# Should show url, port, server_pid, daemon_pid (if Greenfield script present)

curl http://127.0.0.1:$(jq -r .port ~/Library/Application\ Support/RuneProtocol/runtime.json)/healthz
# {"status": "ok", ...}
```

Quit the app → confirm the pids are gone:

```bash
ls ~/Library/Application\ Support/RuneProtocol/runtime.json
# No such file or directory
```

## Forcing a clean state (for repeated testing)

```bash
rm -rf ~/Library/Application\ Support/RuneProtocol/
```

Wipes venv, db, marker, logs. Next launch goes through full setup again.

## What's still TODO (Phase 2 — bundling)

* `setup.sh` currently expects `packages/{sdk,server,nexus}` to be
  on disk somewhere reachable from the .app. `App.ResolveRepoRoot`
  walks up the assembly path to find them — works for `dotnet run`
  and for `./build-macos.sh` builds where the .app sits inside the
  repo. **Does not work** when the .app is dragged to /Applications
  and the user doesn't have the repo cloned.
* Phase 2 plan:
  1. Bundle packages/{sdk,nexus,server} (Python wheels +
     greenfield_daemon's `node_modules/`) inside
     `Nexus.app/Contents/Resources/backend-source/`.
  2. Update `ResolveRepoRoot` to prefer that bundled path.
  3. (Optional) PyInstaller the Python server into a native binary
     to drop the "user must have Python 3.11" requirement.
  4. (Optional) `pkg` the Node daemon to drop the Node requirement.

## Debugging boot failures

The error path on SplashWindow prints the exception message + the path
to the logs. If `setup.sh` failed during `pip install`, the relevant
trace is in `setup.log`. If the server died during startup, `server.log`
has its stderr (uvicorn / FastAPI traceback). The watchdog uses the
same `/healthz` endpoint after boot, so the same logs are useful for
"backend was working then died" scenarios.

Common failure modes seen so far:

* **brew not on PATH** — Avalonia inherits the launchd PATH, which
  doesn't have `/opt/homebrew/bin`. `LocalBackend.RunScriptAsync`
  prepends `/opt/homebrew/bin:/usr/local/bin` before invoking the
  script to fix this.
* **Python 3.11 not installed** — setup.sh runs `brew install
  python@3.11`. If that fails (network, brew lock, etc.), surface in
  setup.log.
* **Port collision** — start.sh picks via `socket.bind(('', 0))` so
  collisions only happen if something binds in the 0.1s between
  picking and spawning. Extremely rare; second launch fixes it.
