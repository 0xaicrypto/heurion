"""
Regression tests for #200 — Gemini model rename + DICOM viewer window.

A. Quick scan + ensemble LLM pinned to a current Gemini model. The
   previous ``gemini-2.0-flash-exp`` value was retired by Google on
   the v1beta API and every call now 404s with "models/... is not
   found". This is what the medic saw: ``Quick scan: errors: 19/19``.
   Lock to ``gemini-2.5-flash`` and assert no source-level reference
   to the dead model name comes back.

B. DICOM viewer link must NOT open in the system browser anymore —
   it has no access to the JWT (which lives in sessionStorage of
   the Tauri webview). The frontend was reported stuck at
   "Loading…" forever. The fix routes through a Tauri
   WebviewWindow with the token in the URL. We guard:

     1. ``api.openDicomViewer`` exists and signs the URL with the token.
     2. modes.tsx no longer renders ``target="_blank"`` on the
        viewer link (which would re-open the system browser).
     3. The Tauri capability allowlist permits ``dicom-*`` window
        labels + the webview-window creation permissions, or the
        runtime will refuse to spawn the new window.
"""
from __future__ import annotations

import json
import pathlib
import re

import pytest


# ─────────────────────────────────────────────────────────────────────
# A. Gemini model name
# ─────────────────────────────────────────────────────────────────────


def test_quick_scan_phase1_model_is_current():
    """PHASE1_MODEL must point at a Gemini model that's still
    accepted by the v1beta API on the day of release. The exp-suffix
    Flash 2.0 has been retired."""
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "quick_scan.py"
    ).read_text()
    m = re.search(r'PHASE1_MODEL\s*=\s*"([^"]+)"', src)
    assert m, "PHASE1_MODEL constant missing from quick_scan.py"
    model = m.group(1)
    assert "exp" not in model, (
        f"PHASE1_MODEL = {model!r} — exp-suffix Gemini models are "
        f"unstable and have already been retired once (see #200). "
        f"Pin to a GA name like 'gemini-2.5-flash'."
    )
    # Must look like a real Gemini Flash family identifier.
    assert model.startswith("gemini-"), (
        f"PHASE1_MODEL doesn't look like a Gemini model: {model!r}"
    )
    assert "flash" in model.lower(), (
        f"PHASE1_MODEL isn't a Flash variant: {model!r}. Quick scan "
        f"is designed around Flash latency / cost — Pro is too "
        f"expensive for the 75-grid sweep."
    )


def test_no_source_references_to_retired_gemini_model():
    """No file in the server package should still reference the
    retired ``gemini-2.0-flash-exp`` model name."""
    server_root = pathlib.Path(__file__).resolve().parents[1] / "nexus_server"
    offenders: list[str] = []
    for py in server_root.rglob("*.py"):
        try:
            text = py.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        if "gemini-2.0-flash-exp" in text:
            # Only count actual code references; comments / strings
            # explaining the regression are fine and useful.
            code_only = "\n".join(
                line.split("#", 1)[0] for line in text.splitlines()
            )
            if "gemini-2.0-flash-exp" in code_only:
                # Still check it's not inside a docstring quoting the
                # old name for historical context.
                # The simple heuristic: it's bad if it appears in a
                # string literal that ISN'T a comment AND isn't on a
                # line that starts with /^\s*#/ pattern. We already
                # stripped # comments above, so any remaining hit is
                # in a real code path.
                offenders.append(str(py.relative_to(server_root)))
    assert not offenders, (
        f"Retired ``gemini-2.0-flash-exp`` still referenced in: "
        f"{offenders}. Every call goes 404 — update to "
        f"``gemini-2.5-flash`` (or commit explicit comment context "
        f"if you really need to mention it historically)."
    )


# ─────────────────────────────────────────────────────────────────────
# B. DICOM viewer routing
# ─────────────────────────────────────────────────────────────────────


DESKTOP_ROOT = pathlib.Path(__file__).resolve().parents[2] / "desktop-v2"


def test_api_client_openDicomViewer_uses_tauri_window_with_token():
    """``api.openDicomViewer`` must (a) exist, (b) put the JWT in the
    URL query, and (c) prefer the ``@tauri-apps/api/webviewWindow``
    path before falling back to ``window.open``."""
    src = (DESKTOP_ROOT / "src" / "lib" / "api-client.ts").read_text()
    assert "async openDicomViewer(" in src, (
        "api-client missing openDicomViewer — viewer link can't "
        "switch from system browser to Tauri window."
    )
    # Must build the URL with token query param.
    assert re.search(
        r"openDicomViewer\(studyId: string\)[\s\S]+?token=\$\{encodeURIComponent\(token\)\}",
        src,
    ), (
        "openDicomViewer doesn't append token=... to the URL — the "
        "viewer page will 401 on every /api/v1/dicom fetch and sit "
        "at 'Loading…' forever."
    )
    # Must try the Tauri path before falling back.
    assert "@tauri-apps/api/webviewWindow" in src, (
        "openDicomViewer doesn't import Tauri's WebviewWindow — only "
        "the dev-mode window.open fallback runs, which doesn't open "
        "a real desktop window in a bundled .app."
    )


def test_modes_viewer_link_uses_openDicomViewer_not_target_blank():
    """The PatientMode card must wire its viewer link through
    ``api.openDicomViewer`` and NOT use ``target="_blank"`` (which
    re-opens the system browser, the original bug)."""
    src = (DESKTOP_ROOT / "src" / "modes.tsx").read_text()

    # Locate the viewer link block — after the swap, the literal
    # ``/dicom-viewer/`` URL only appears in comments. Anchor on the
    # ``openDicomViewer`` call instead, then check the surrounding
    # JSX doesn't carry target="_blank" or hardcoded baseUrl /dicom
    # href (which would defeat the swap by opening a real tab).
    m = re.search(
        r'onClick=\{[^}]*openDicomViewer\([^}]*\)[\s\S]+?className="',
        src,
    )
    assert m, (
        "couldn't locate any onClick={() => api.openDicomViewer(...)} "
        "in modes.tsx — the viewer link wasn't actually rewired."
    )
    block = m.group(0)
    assert 'target="_blank"' not in block, (
        "Viewer link still has target=\"_blank\" near the "
        "openDicomViewer click — that forces the system browser even "
        "though the onClick spawns a Tauri window. Drop the attribute."
    )


def test_tauri_capabilities_permit_dicom_window_creation():
    """``capabilities/default.json`` must allowlist the ``dicom-*``
    window label AND grant webview-window creation. Without these
    the Tauri runtime refuses the spawn at IPC time."""
    cap_path = DESKTOP_ROOT / "src-tauri" / "capabilities" / "default.json"
    cap = json.loads(cap_path.read_text())

    windows = cap.get("windows") or []
    assert any(w == "dicom-*" or w == "*" for w in windows), (
        f"capability ``windows`` allowlist must include 'dicom-*' "
        f"(or '*'); got {windows!r}. New webview windows with that "
        f"label prefix will be denied otherwise."
    )

    perms = cap.get("permissions") or []
    must_have = "core:webview:allow-create-webview-window"
    assert must_have in perms, (
        f"capability missing permission {must_have!r} — "
        f"``new WebviewWindow(...)`` calls will throw "
        f"'NotAllowed' at runtime."
    )
