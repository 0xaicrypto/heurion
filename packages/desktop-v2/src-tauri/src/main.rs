// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::Write;
use std::panic;
use std::path::PathBuf;

/// Resolve the directory where we drop the early-panic crash log. We
/// duplicate ``sidecar_log_path``'s ``~/Library/Logs/Nexus/`` location
/// instead of importing the helper because the hook needs to run
/// BEFORE the lib crate's symbols are touched — installing the hook
/// late means a panic inside ``tauri::Builder::default()`` or any
/// plugin constructor disappears into a ``panic_cannot_unwind``
/// abort whose only artefact is a CrashReporter trace with no
/// actionable message (this is what bit us on the macOS 26.5.1
/// startup crash — the tao app-delegate callback panicked but the
/// panic message never landed anywhere we could read).
fn crash_log_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library").join("Logs")
                .join("Nexus").join("desktop-crash.log");
        }
    }
    if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("Nexus").join("logs")
                .join("desktop-crash.log");
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local").join("state")
            .join("Nexus").join("desktop-crash.log");
    }
    PathBuf::from("desktop-crash.log")
}

/// Install a process-wide panic hook that appends to
/// ``$HOME/Library/Logs/Nexus/desktop-crash.log``. The hook chains the
/// previous (default) hook so the panic still prints to stderr.
///
/// Why this matters: when Rust panics inside an ``extern "C"`` callback
/// (e.g. tao's ``did_finish_launching`` NSNotification observer), the
/// boundary triggers ``core::panicking::panic_cannot_unwind`` which
/// calls ``std::process::abort()`` — at THAT point the panic message
/// is already lost. Hooking BEFORE the boundary fires gives us the
/// real Location + payload.
fn install_early_panic_hook() {
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let path = crash_log_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        // Format: ISO-ish timestamp + thread + location + message.
        // Best-effort everything — we MUST NOT panic from inside the
        // panic hook.
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".into());

        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            format!("<non-string payload, type_id={:?}>",
                    info.payload().type_id())
        };

        let thread_name = std::thread::current()
            .name().unwrap_or("<unnamed>").to_string();

        let line = format!(
            "─── PANIC ts={ts} thread={thread_name} at {location} ───\n\
             {payload}\n\n",
        );

        if let Ok(mut f) = OpenOptions::new()
            .create(true).append(true).open(&path)
        {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }

        // Chain to the previous (default) hook so stderr still gets
        // the standard "thread 'main' panicked at ..." message.
        prev(info);
    }));
}

fn main() {
    install_early_panic_hook();
    nexus_desktop_v2_lib::run()
}
