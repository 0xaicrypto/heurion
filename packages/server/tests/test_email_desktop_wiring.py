"""Source-level guards for the desktop-v2 side of the email feature.

These tests don't run the React app — they grep the TypeScript so
silent regressions on the frontend wiring are caught alongside the
server tests. Three things we lock down:

  1. ``api.sendEmail`` and ``api.getEmailTransport`` exist on the
     ApiClient surface and target the documented URLs. The Compose
     dialog calls them by name; if someone renames a method we want a
     loud failure here, not a runtime "function not found" in the
     bundled .dmg.

  2. ``EmailComposerDialog`` is exported from overlays.tsx AND
     rendered inside ``MainShell`` in App.tsx. Without the render
     site the dialog never mounts — clicking Compose just toggles a
     boolean nothing reads.

  3. The Patient mode "Email findings" trigger passes a body that
     mentions findings (so the prefill actually carries data, not an
     empty draft). This catches a regression like "trigger button
     added but prefill builder forgot to read proj.findings".
"""
from __future__ import annotations

import pathlib
import re

DESKTOP_SRC = (
    pathlib.Path(__file__).resolve().parents[2] / "desktop-v2" / "src"
)


def _strip_comments(text: str) -> str:
    """Same as test_desktop_auth_storage_tier — drop // and /* */
    so bug-history docstrings don't satisfy grep checks."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    out = []
    for line in text.splitlines():
        idx = line.find("//")
        if idx >= 0:
            line = line[:idx]
        out.append(line)
    return "\n".join(out)


def _read(rel: str) -> str:
    p = DESKTOP_SRC / rel
    assert p.exists(), f"expected file missing: {p}"
    return _strip_comments(p.read_text())


def test_api_client_exposes_email_methods():
    src = _read("lib/api-client.ts")
    for name in ("sendEmail", "getEmailTransport"):
        assert re.search(rf"\b{name}\s*\(", src), (
            f"api-client.ts no longer defines {name}() — the Compose "
            "dialog calls these by name; rename them in concert."
        )

    # And the URLs they target match the FastAPI router.
    assert "/api/v1/email/send" in src, (
        "api-client.ts no longer references /api/v1/email/send — that's "
        "the route the email router registers."
    )
    assert "/api/v1/email/transport" in src, (
        "api-client.ts no longer references /api/v1/email/transport."
    )


def test_email_composer_dialog_is_exported_and_rendered():
    overlays = _read("components/overlays.tsx")
    assert "export function EmailComposerDialog" in overlays, (
        "EmailComposerDialog export missing — App.tsx imports it; a "
        "renamed/deleted export will break the build."
    )

    app = _read("App.tsx")
    # Must be imported AND mounted.
    assert "EmailComposerDialog" in app, (
        "App.tsx no longer imports/mounts EmailComposerDialog — "
        "opening Compose won't render the dialog."
    )
    assert re.search(r"<EmailComposerDialog\s*/?>", app), (
        "EmailComposerDialog import exists but the JSX render site is "
        "gone — store flag toggles but no UI appears."
    )


def test_store_has_compose_open_close_handles():
    src = _read("store.ts")
    for name in ("emailComposerOpen", "openEmailComposer", "closeEmailComposer"):
        assert re.search(rf"\b{name}\b", src), (
            f"store.ts no longer defines {name} — the dialog and the "
            "trigger points all read this off useAppState."
        )


def test_patient_mode_email_findings_prefills_body_with_findings():
    src = _read("modes.tsx")

    # The build_findings helper must read proj.findings AND assemble it
    # into the body argument the trigger passes to openEmail.
    assert "buildFindingsEmailBody" in src, (
        "PatientMode no longer has a buildFindingsEmailBody helper — "
        "the 'Email findings' button would open an empty draft."
    )
    helper_match = re.search(
        r"function buildFindingsEmailBody\([\s\S]+?\n\}\n", src,
    )
    assert helper_match, "buildFindingsEmailBody body not isolatable"
    helper = helper_match.group(0)
    assert "proj.findings" in helper, (
        "buildFindingsEmailBody doesn't read proj.findings — the "
        "prefilled body wouldn't contain the actual finding list."
    )

    # And the PatientMode trigger must invoke openEmail with a body
    # that comes from the helper (otherwise the helper exists but
    # nothing wires it through).
    pm_match = re.search(
        r"export function PatientMode\([\s\S]+?\nexport function ",
        src,
    )
    assert pm_match, "PatientMode slice not isolatable"
    pm = pm_match.group(0)
    assert "openEmail({" in pm and "buildFindingsEmailBody" in pm, (
        "PatientMode no longer wires buildFindingsEmailBody into its "
        "openEmail call — clicking the button opens a blank draft."
    )
