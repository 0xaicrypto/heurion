/**
 * SidecarDiagPanel — shared component for surfacing sidecar stdout/stderr.
 *
 * Two callers in the desktop:
 *   1. BootGate (App.tsx)   — shows progress while /healthz is still
 *                              unreachable, so a slow Alembic migration
 *                              doesn't look like a crash to the medic.
 *   2. LoginView (login.tsx)— shows diag once the user gets past boot
 *                              but signin still fails (e.g. backend
 *                              came up then died, or auth misconfig).
 *
 * The panel reads from the Tauri ``get_sidecar_diagnostics`` IPC — see
 * ``src-tauri/src/lib.rs::SidecarDiag``. Outside Tauri (browser-only
 * dev) the IPC returns null and the panel doesn't render anything.
 */

import type {
  SidecarDiagLine,
  SidecarDiagnostics,
} from '../lib/api-client';

/** One-line status summary used in the panel header. */
export function summariseDiag(d: SidecarDiagnostics | null): string {
  if (!d) return 'no diagnostics available';
  // ``pid == null`` AND ``started_at == 0`` means we have a fresh diag
  // state from before the first spawn — render that distinctly.
  if (d.pid == null && d.started_at === 0) {
    return 'sidecar not started yet';
  }
  const now = Math.floor(Date.now() / 1000);
  const elapsed = d.started_at ? Math.max(0, now - d.started_at) : 0;
  if (d.alive) {
    return `running · pid ${d.pid ?? '?'} · uptime ${elapsed}s`;
  }
  const code = d.last_exit_code == null ? '?' : String(d.last_exit_code);
  return `EXITED · code ${code} · ${elapsed}s ago`;
}

/**
 * Tailwind colour for a captured-line — drives panel highlighting.
 *
 * Why we don't just colour by stream:
 *   Python's ``logging.StreamHandler()`` defaults to ``sys.stderr`` for
 *   ALL log records, INFO included. So our captured stderr stream is
 *   90% INFO lines (uvicorn requests, alembic upgrades, normal app
 *   chatter) and ~10% actual problems. Painting all of stderr red made
 *   the panel look like the app was on fire even when it was booting
 *   normally — exactly the failure mode the medic flagged.
 *
 * Algorithm:
 *   1. If the line text matches an ERROR-ish pattern → red.
 *   2. Else WARNING-ish → amber.
 *   3. Else if the stream is "sys" (our synthesized markers) → green.
 *   4. Else neutral grey.
 *
 * Stream is now a tiebreaker only — primarily we trust the log text.
 */
const ERROR_RX = /\[ERROR\]|^ERROR[: ]|Traceback \(most recent call last\)|Exception:|Error:/;
const WARN_RX  = /\[WARNING\]|^WARNING[: ]|^WARN[: ]/;

function lineColour(line: SidecarDiagLine): string {
  if (line.stream === 'sys') {
    // Sys events are entirely our own messages — colour them green so
    // boot progress reads as "Nexus is doing things, not failing".
    return 'text-promote';
  }
  if (ERROR_RX.test(line.text)) return 'text-retract';
  if (WARN_RX.test(line.text))  return 'text-caution';
  // Default: neutral. INFO + DEBUG + unrecognised stderr lines all
  // land here so the panel doesn't look alarmist during normal boot.
  return 'text-text-secondary';
}

/** Maximum number of lines to render. 60 covers a deep Python stack
 *  (typically 30–50) plus a bit of surrounding context. */
const TAIL_LINES = 60;

export function SidecarDiagPanel({ diag }: { diag: SidecarDiagnostics }) {
  const recent = diag.lines.slice(-TAIL_LINES);
  return (
    <div className="selectable">
      <div className="text-[10px] text-text-tertiary">
        Log file:&nbsp;
        <code className="font-mono text-text-secondary">{diag.log_path}</code>
        &nbsp;· tail with:&nbsp;
        <code className="font-mono text-text-secondary">tail -f {diag.log_path}</code>
      </div>
      <div className="mt-2 max-h-[40vh] overflow-auto rounded-sm border border-border bg-bg p-2 font-mono text-[10px] leading-relaxed">
        {recent.length === 0 ? (
          <div className="text-text-tertiary">
            no output captured yet — sidecar may still be initialising…
          </div>
        ) : (
          recent.map((l, i) => (
            <div key={`${l.ts}-${i}`} className={lineColour(l)}>
              <span className="text-text-tertiary">[{l.stream}]</span> {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
