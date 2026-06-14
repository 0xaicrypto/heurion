"""
Regression test: chat_ingester FK constraint.

Bug history (2026-06-13 log):
    chat_router_v2 invoked _run_chat_ingester_safe with
    ``source_event_idx=0``. That gets passed to ChatIngester.
    ingest_encounter → emit_and_apply with caused_by=0. The
    event_log table has a FK from caused_by → events.event_idx;
    indices start at 1, so 0 is unsatisfiable → FOREIGN KEY
    constraint failed → ingestion silently skipped.

This test asserts:
  1. `_run_chat_ingester_safe` accepts the new keyword arg
     ``source_event_idx`` (regression on the signature itself).
  2. chat_router_v2 actually passes the assistant_idx through,
     not a literal 0 (source-level grep).
"""
from __future__ import annotations

import inspect
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


def test_run_chat_ingester_safe_requires_source_event_idx():
    """The helper MUST accept source_event_idx as a kw-only param."""
    from nexus_server.chat_router_v2 import _run_chat_ingester_safe

    sig = inspect.signature(_run_chat_ingester_safe)
    params = sig.parameters
    assert "source_event_idx" in params, (
        "_run_chat_ingester_safe lost the source_event_idx parameter — "
        "it MUST take this so it can pass a real event_idx (not 0) "
        "as caused_by. Without it, the FK constraint fires and "
        "chat-derived findings never land in Layer 1."
    )
    # Must be keyword-only to avoid positional confusion at call site.
    p = params["source_event_idx"]
    assert p.kind in (
        inspect.Parameter.KEYWORD_ONLY,
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
    ), f"source_event_idx has wrong kind: {p.kind}"
    # It must have NO default of 0 — that was the original bug.
    assert p.default in (inspect.Parameter.empty, None), (
        f"source_event_idx defaults to {p.default!r} — must be "
        "required so callers can't accidentally pass nothing (which "
        "would become 0 and re-trigger the FK bug)."
    )


def test_chat_router_passes_assistant_idx_to_ingester():
    """Source-level guard: chat_router_v2 invokes
    ``_run_chat_ingester_safe(...)`` with ``source_event_idx=assistant_idx``
    — not literal 0, not None, not a stale variable."""
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "nexus_server" / "chat_router_v2.py").read_text()

    # Grab the call site.
    call = re.search(
        r"_run_chat_ingester_safe\s*\([^)]*\)",
        src, re.DOTALL,
    )
    assert call, "chat_router_v2 no longer calls _run_chat_ingester_safe"
    body = call.group(0)
    assert "source_event_idx=assistant_idx" in body, (
        "chat_router_v2's call to _run_chat_ingester_safe must pass "
        "source_event_idx=assistant_idx (the just-committed "
        "ASSISTANT_RESPONSE event_idx). Found call body:\n" + body
    )
    assert "source_event_idx=0" not in body, (
        "Regression — _run_chat_ingester_safe is being called with "
        "source_event_idx=0 again. This produces FOREIGN KEY "
        "constraint failed at runtime. Use assistant_idx."
    )
