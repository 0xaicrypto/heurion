// Tauri 2.0 application library.
//
// Spawns the bundled `nexus-server` PyInstaller binary as a sidecar
// on startup so the medic doesn't have to launch the backend
// separately. The sidecar is registered in tauri.conf.json's
// `externalBin` array.
//
// If the sidecar dies, the frontend keeps running — login will fail
// fast and show "Cannot reach server. Is the backend running?" so
// the medic can restart the app.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Holds a handle to the running sidecar so we can shut it down
/// cleanly on app exit. None until startup has spawned it.
struct SidecarState(Mutex<Option<CommandChild>>);

/// Build identity baked in at compile time by `scripts/build-macos.sh`
/// (which exports NEXUS_BUILD_ID before invoking `pnpm tauri:build`).
/// option_env! returns None if the var wasn't set (e.g. when someone
/// runs `cargo build` directly) — we fall back to "dev".
const BUILD_ID: &str = match option_env!("NEXUS_BUILD_ID") {
    Some(v) => v,
    None => "dev",
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // log plugin writes logs to:
        //   stdout (visible when launched from terminal)
        //   ~/Library/Logs/<bundle-id>/<app-name>.log on macOS
        // This is critical for debugging sidecar startup failures —
        // without it, log::info / log::error from spawn_backend_sidecar
        // disappear into the void in a bundled .dmg.
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("nexus".to_string()),
                    }),
                ])
                .build(),
        )
        .manage(SidecarState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            server_health,
            llm_env_status,
            llm_env_write,
            restart_sidecar,
        ])
        .setup(|app| {
            log::info!("Nexus desktop v{} starting", BUILD_ID);
            spawn_backend_sidecar(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Reap the sidecar on app exit so we don't orphan it.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                let state: State<SidecarState> = app_handle.state();
                // Bind the lock result to a named local so its drop
                // order is well-defined relative to `state`. Anonymous
                // temporaries in the `if let` scrutinee can outlive
                // `state` in some compiler versions, which the borrow
                // checker rejects (E0597).
                let lock_result = state.0.lock();
                if let Ok(mut guard) = lock_result {
                    if let Some(child) = guard.take() {
                        log::info!("killing nexus-server sidecar (pid={})", child.pid());
                        let _ = child.kill();
                    }
                }
            }
        });
}

/// Resolve the user-level data directory where v1's setup.sh writes
/// `.env` (GEMINI_API_KEY, etc.). We share the same location with v1 so
/// a medic who already ran the v1 installer doesn't have to re-enter
/// keys — Settings · LLM in v2 reads and writes the same file.
fn rune_home() -> PathBuf {
    // Mirror packages/desktop/scripts/local-backend/start.sh:24:
    //   RUNE_HOME="$HOME/Library/Application Support/RuneProtocol"
    // On non-macOS we fall back to a portable XDG path so the same
    // logic works under `pnpm tauri:dev` on Linux.
    if cfg!(target_os = "macos") {
        if let Some(home) = dirs_home() {
            return home.join("Library").join("Application Support").join("RuneProtocol");
        }
    }
    if let Some(home) = dirs_home() {
        return home.join(".config").join("RuneProtocol");
    }
    PathBuf::from(".")
}

fn dirs_home() -> Option<PathBuf> {
    // Avoid an extra crate dep — read $HOME (set on macOS + Linux) or
    // $USERPROFILE (Windows). Tauri's path API would also work but
    // requires &App which we don't have at this call site.
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Parse a dotenv file into a flat KEY→VALUE map. Mirrors v1's start.sh
/// behaviour (lines 220-247): split on the FIRST '=', skip blank lines
/// and lines starting with '#', strip ONE pair of surrounding quotes
/// from the value. Returns an empty map and logs a warning if the file
/// is missing — the sidecar still boots, just without LLM keys, and the
/// frontend's Settings · LLM dialog can write the file later.
fn load_user_env(path: &Path) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => {
            log::warn!("no user .env at {} — sidecar will run with defaults only", path.display());
            return out;
        }
    };
    let mut count_loaded = 0usize;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let eq = match line.find('=') {
            Some(i) => i,
            None => continue,
        };
        let key = line[..eq].trim();
        if key.is_empty() {
            continue;
        }
        let mut val = &line[eq + 1..];
        // Strip a matching pair of surrounding quotes.
        let bytes = val.as_bytes();
        if val.len() >= 2
            && ((bytes[0] == b'"'  && bytes[bytes.len() - 1] == b'"')
             || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
        {
            val = &val[1..val.len() - 1];
        }
        out.insert(key.to_string(), val.to_string());
        count_loaded += 1;
    }
    log::info!("loaded {} env var(s) from {}", count_loaded, path.display());
    out
}

/// Seed or delta-merge the user's .env from the bundled default.env.
///
/// Mirrors v1's setup.sh + start.sh combined behaviour:
///
///   - User .env missing  → full copy from bundled default (first install).
///   - User .env exists   → walk every KEY= line in the bundle; for any
///                          key not already present (commented OR
///                          uncommented) in the user file, append it.
///                          Values the user has overridden locally
///                          (e.g. a GEMINI_API_KEY they swapped in via
///                          Settings · LLM) are preserved.
///
/// Idempotent: safe to call every launch. The .dmg auto-update story
/// rides on this — when a new build ships with a new NEXUS_RELAY_URL or
/// rotated key, the next launch's delta-merge picks it up without
/// asking the medic.
fn seed_or_merge_user_env(app: &AppHandle, user_env_path: &Path) -> Result<usize, String> {
    // Locate the bundled default.env. Tauri resolves it to the .app's
    // Resources/_up_/resources/default.env on macOS; in `pnpm tauri:dev`
    // it points at the on-disk file directly.
    let bundled = match app
        .path()
        .resolve("resources/default.env", tauri::path::BaseDirectory::Resource)
    {
        Ok(p) => p,
        Err(e) => {
            log::warn!("default.env not bundled — skipping seed/merge ({e})");
            return Ok(0);
        }
    };
    let bundled_text = match fs::read_to_string(&bundled) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("could not read bundled default.env: {e}");
            return Ok(0);
        }
    };

    // First install — full seed.
    if !user_env_path.exists() {
        if let Some(parent) = user_env_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let header = format!(
            "# Nexus runtime config — seeded by Tauri on first launch.\n\
             # Edit directly to override (e.g. swap GEMINI_API_KEY) or use\n\
             # Settings · LLM in the desktop. New keys shipped in future\n\
             # .dmg releases are merged in automatically on launch.\n\n"
        );
        let mut f = fs::File::create(user_env_path)
            .map_err(|e| format!("create {}: {e}", user_env_path.display()))?;
        f.write_all(header.as_bytes())
            .and_then(|_| f.write_all(bundled_text.as_bytes()))
            .map_err(|e| format!("write {}: {e}", user_env_path.display()))?;
        // Tighten permissions — file holds API keys.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(user_env_path, fs::Permissions::from_mode(0o600));
        }
        let lines = bundled_text.lines().count();
        log::info!(
            "seeded {} from bundled default.env ({} lines)",
            user_env_path.display(), lines,
        );
        return Ok(lines);
    }

    // Existing install — collect KEYs from bundle, find ones missing
    // from user .env, append them under a dated header.
    let user_text = fs::read_to_string(user_env_path)
        .map_err(|e| format!("read {}: {e}", user_env_path.display()))?;
    let user_has_key = |k: &str| -> bool {
        for line in user_text.lines() {
            let mut t = line.trim_start();
            if t.starts_with('#') {
                t = t[1..].trim_start();   // allow commented-out form
            }
            if let Some(eq) = t.find('=') {
                if t[..eq].trim() == k {
                    return true;
                }
            }
        }
        false
    };

    let mut to_append: Vec<&str> = Vec::new();
    for line in bundled_text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let key = line[..eq].trim();
        if key.is_empty() {
            continue;
        }
        if !user_has_key(key) {
            to_append.push(line);
        }
    }

    if to_append.is_empty() {
        log::info!("user .env already has every bundled key — no merge needed");
        return Ok(0);
    }

    let now = unix_now_secs();
    let header = format!(
        "\n# ── Bundle merge {} (Tauri startup) — added {} new key(s) ─\n",
        now, to_append.len()
    );
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(user_env_path)
        .map_err(|e| format!("append {}: {e}", user_env_path.display()))?;
    f.write_all(header.as_bytes())
        .and_then(|_| {
            for line in &to_append {
                f.write_all(line.as_bytes())?;
                f.write_all(b"\n")?;
            }
            Ok(())
        })
        .map_err(|e| format!("merge-write {}: {e}", user_env_path.display()))?;
    log::info!(
        "merged {} new key(s) from bundled default.env into {}",
        to_append.len(), user_env_path.display(),
    );
    Ok(to_append.len())
}

/// Unix-seconds timestamp as a string. Used as a build-merge marker
/// in .env headers ("# ── Bundle merge 1718312480 …"). No external
/// crate dep — full calendar arithmetic isn't worth pulling chrono.
fn unix_now_secs() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

/// Launch the bundled nexus-server binary. Streams its stdout/stderr
/// into the Tauri log so the medic / debugger can see backend startup.
fn spawn_backend_sidecar(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("spawning nexus-server sidecar");

    // v1-parity key handling: read $RUNE_HOME/.env and inject every
    // KEY=VALUE pair into the sidecar's environment, matching what
    // packages/desktop/scripts/local-backend/start.sh does. Without
    // this step, the bundled .app launched from Finder/Dock sees an
    // empty os.environ and config.GEMINI_API_KEY = None, which makes
    // every LLM-using endpoint 500 (the medic sees "Backend
    // unreachable" because the chat request fails before turn_started).
    let rh = rune_home();
    let env_path = rh.join(".env");

    // Seed (first install) or delta-merge (every launch) the user .env
    // from the bundled default. This is what makes "reinstall the .dmg
    // and the new keys / new server code flow in" work — the keys side
    // happens here; the code side happens because the .dmg ships a
    // fresh PyInstaller binary at src-tauri/binaries/nexus-server-*.
    if let Err(e) = seed_or_merge_user_env(app, &env_path) {
        log::warn!("env seed/merge failed: {e}");
    }

    let user_env = load_user_env(&env_path);
    log::info!("rune_home: {}", rh.display());

    let mut sidecar = app
        .shell()
        .sidecar("nexus-server")
        .map_err(|e| format!("failed to resolve sidecar: {e}"))?
        .env("NEXUS_HOST", "127.0.0.1")
        .env("NEXUS_PORT", "8001")
        // CORS: the bundled webview runs from tauri://localhost (or
        // asset://localhost on some platforms). Backend defaults only
        // include localhost:3000 and :5173 (dev origins). Setting
        // wildcard is safe here because the backend is bound to
        // 127.0.0.1 (loopback only — not reachable off-host) AND
        // every protected route still requires a valid JWT.
        .env("CORS_ALLOW_ORIGINS", "*")
        // RUNE_HOME so the sidecar's settings router knows where to
        // read/write the .env when the medic updates a key.
        .env("RUNE_HOME", rh.to_string_lossy().to_string());

    for (k, v) in user_env {
        // Don't overwrite the loopback host/port we just set above.
        if k == "NEXUS_HOST" || k == "NEXUS_PORT" || k == "CORS_ALLOW_ORIGINS" {
            continue;
        }
        sidecar = sidecar.env(k, v);
    }

    let (mut rx, child) = sidecar.spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    log::info!("nexus-server sidecar pid={}", child.pid());

    // Stash the child so we can kill it on exit.
    let state: State<SidecarState> = app.state();
    {
        let mut guard = state.0.lock().unwrap();
        *guard = Some(child);
    }

    // Drain stdout/stderr → app log. Critical for debugging Python
    // startup failures (missing PyInstaller hidden import etc.) —
    // without this, a sidecar that crashes shows zero diagnostic.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(msg) => {
                    log::error!("[server] sidecar error: {msg}");
                }
                CommandEvent::Terminated(payload) => {
                    log::error!("[server] sidecar terminated: code={:?}", payload.code);
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// IPC probe — frontend can call this to verify the bridge is alive.
/// The frontend additionally polls /api/v1/memory/_status via HTTP
/// for backend liveness.
#[tauri::command]
fn server_health() -> Result<String, String> {
    Ok("ok".to_string())
}

/// Direct read of the user's .env state, bypassing the FastAPI server.
/// This is the fallback Settings · LLM uses when the backend's
/// GET /api/v1/settings/llm 404s (stale binary predates U3.3).
///
/// Returns key-presence booleans + the resolved env path. We never
/// return key VALUES — same contract as the backend.
#[tauri::command]
fn llm_env_status() -> serde_json::Value {
    let path = rune_home().join(".env");
    let env = load_user_env(&path);

    let has_key = |k: &str| {
        env.get(k)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    };

    serde_json::json!({
        "provider":         env.get("DEFAULT_LLM_PROVIDER").cloned().unwrap_or_else(|| "gemini".into()),
        "model":            env.get("DEFAULT_LLM_MODEL").cloned().unwrap_or_else(|| "gemini-2.5-flash".into()),
        "env_file_path":    path.to_string_lossy().to_string(),
        "env_file_exists":  path.exists(),
        "has_gemini_key":   has_key("GEMINI_API_KEY"),
        "has_openai_key":   has_key("OPENAI_API_KEY"),
        "has_anthropic_key":has_key("ANTHROPIC_API_KEY"),
        // serde_json::json! takes JSON-literal tokens, not Rust generics —
        // ``null`` is what you write for an explicit null.
        "advisory":         null,
    })
}

/// Direct write to ~/.../RuneProtocol/.env, used when the backend's
/// PUT /api/v1/settings/llm is unavailable. Mirrors the backend's
/// idempotent-merge semantics: for each ``updates`` key, replace any
/// existing assignment in place, else append under a dated header.
///
/// Atomic via tempfile + rename so a crash mid-write can't truncate
/// the file the next launch needs.
#[tauri::command]
fn llm_env_write(updates: HashMap<String, String>) -> Result<serde_json::Value, String> {
    let path = rune_home().join(".env");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let mut remaining: HashMap<String, String> = updates.clone();
    let mut new_lines: Vec<String> = Vec::new();
    for line in existing.lines() {
        let mut replaced = false;
        // For each pending key, see if this line starts with KEY=.
        for k in remaining.keys().cloned().collect::<Vec<_>>() {
            let stripped = line.trim_start();
            if let Some(eq) = stripped.find('=') {
                if stripped[..eq].trim() == k {
                    new_lines.push(format!("{}={}", k, remaining.remove(&k).unwrap()));
                    replaced = true;
                    break;
                }
            }
        }
        if !replaced {
            new_lines.push(line.to_string());
        }
    }
    if !remaining.is_empty() {
        if !new_lines.is_empty() && !new_lines.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
            new_lines.push(String::new());
        }
        new_lines.push(format!(
            "# ── Settings · LLM (written via Tauri IPC at unix {}) ──",
            unix_now_secs(),
        ));
        for (k, v) in &remaining {
            new_lines.push(format!("{}={}", k, v));
        }
    }

    // Atomic write: tempfile + rename. ``Path::with_extension`` is
    // unsafe for our filename — for ``/path/.env``, Rust treats the
    // whole name as the stem, so with_extension("env.tmp") produces
    // ``/path/.env.env.tmp``. Build the sibling path explicitly.
    let tmp = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".env.tmp");
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("create {}: {e}", tmp.display()))?;
        f.write_all(new_lines.join("\n").as_bytes())
            .and_then(|_| if new_lines.is_empty() { Ok(()) } else { f.write_all(b"\n") })
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }

    let written: Vec<String> = updates.keys().cloned().collect();
    Ok(serde_json::json!({
        "ok": true,
        "env_file_path": path.to_string_lossy().to_string(),
        "written_keys": written,
        "status": llm_env_status(),
    }))
}

/// Kill the running sidecar and respawn it. Used by Settings · LLM's
/// "Apply now" button to force the FastAPI process to re-read the
/// freshly-written .env (config.GEMINI_API_KEY is captured at import,
/// so the existing process keeps using the old value until restart).
#[tauri::command]
fn restart_sidecar(app: AppHandle) -> Result<String, String> {
    log::info!("restart_sidecar: killing current child");
    {
        let state: State<SidecarState> = app.state();
        // Same E0597 dance as the exit handler at the top of this
        // file: ``state.0.lock()`` returns a Result whose Err variant
        // holds a MutexGuard borrowed from ``state``. As an unnamed
        // temporary in the ``if let`` scrutinee, the Result outlives
        // ``state`` and the borrow checker rejects the drop order.
        // Binding to a named local pins both lifetimes to the block.
        let lock_result = state.0.lock();
        if let Ok(mut guard) = lock_result {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
    // Brief pause so the OS releases the port before respawn.
    std::thread::sleep(std::time::Duration::from_millis(400));
    spawn_backend_sidecar(&app).map_err(|e| format!("respawn failed: {e}"))?;
    Ok("restarted".to_string())
}
