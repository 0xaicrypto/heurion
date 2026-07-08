"""
Regression for the 2026-06-14 bug where chat history rendered as 6 rows
labelled "You" with empty bodies.

What happened
─────────────
``listSessionMessages`` in ``packages/desktop-v2/src/lib/api-client.ts``
was written against the OLD raw-event-log shape:

    { event_idx, event_kind: "user_message"|"assistant_response",
      ts, payload: { text, attachments, ... } }

After the S5 thin-client refactor the backend's GET /api/v1/agent/messages
returns the higher-level ChatMessageView (see
``packages/server/nexus_server/agent_state.py``):

    { role: "user"|"assistant",
      content: <string>,
      timestamp: <ISO-8601>,
      sync_id: <int>,
      attachments: [{ name, mime, size_bytes }],
      message_kind: "text"|"workflow_run",
      metadata: {} }

The frontend kept looking for ``row.event_kind`` (always undefined → role
defaulted to 'system') and ``row.payload.text`` (always undefined →
text became ''). EncounterMode then coerced 'system' → 'user', so every
historical row showed up as a blank "You" bubble.

What we lock down here (source-level, no JS runtime)
────────────────────────────────────────────────────
1. The parser reads ``row.role`` and produces correct 3-way taxonomy
   (assistant→agent, user→user, anything else→system).
2. The parser reads ``row.content`` for the text body.
3. The parser reads ``row.timestamp`` and parses to unix seconds.
4. ChatMessageRow.attachments is the OBJECT shape ({name, mime, sizeBytes})
   not a flat string[] — agent_state.AttachmentInfo's three fields are
   what the server actually sends. Without the type update the chip
   render site would break the next time someone touches it.
5. ChatMessageView's Python shape is what THIS test verifies the
   server emits (forward contract — if someone refactors the backend
   AGAIN, this test catches the regression on the server side).

These two source-level checks meet in the middle: if either side
drifts, exactly one test fails and points at the file to fix.
"""
from __future__ import annotations

import pathlib
import re

DESKTOP_SRC = (
    pathlib.Path(__file__).resolve().parents[2] / "desktop-v2" / "src"
)
SERVER_SRC = (
    pathlib.Path(__file__).resolve().parents[1] / "nexus_server"
)


def _strip_ts_comments(text: str) -> str:
    """Drop // and /* */ comments — the bug-history docstrings in
    api-client.ts mention the OLD field names by design (they document
    what NOT to do) and would false-positive a substring grep."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    out = []
    for line in text.splitlines():
        idx = line.find("//")
        if idx >= 0:
            line = line[:idx]
        out.append(line)
    return "\n".join(out)


def _read_ts(rel: str) -> str:
    p = DESKTOP_SRC / rel
    assert p.exists(), f"missing source file: {p}"
    return _strip_ts_comments(p.read_text())


def _slice_method(src: str, name: str) -> str:
    """Isolate one method body so source-level greps don't pick up
    matches from OTHER methods (the api-client has ~30 methods and many
    of them legitimately use raw `event_idx` for different endpoints)."""
    m = re.search(
        rf"async {name}\([\s\S]+?\n  \}}\n",
        src,
    )
    assert m, f"method {name} not isolatable"
    return m.group(0)


def test_parser_reads_role_field_not_event_kind():
    """Parser must consume ``row.role`` from the ChatMessageView shape.
    The old form ``row.event_kind`` is gone for good — server hasn't
    emitted that field since the S5 refactor."""
    method = _slice_method(
        _read_ts("lib/api-client.ts"), "listSessionMessages",
    )
    assert "row.role" in method, (
        "listSessionMessages doesn't read row.role — every history row "
        "will degrade to 'system' role and EncounterMode will collapse "
        "them all to 'user' bubbles."
    )
    # The OLD form must NOT be present (catch a half-revert).
    assert "row.event_kind" not in method, (
        "listSessionMessages still references row.event_kind — that "
        "field hasn't existed on the wire since S5. Remove it; otherwise "
        "the 'user_message' / 'assistant_response' branch dead-ends."
    )


def test_parser_reads_content_field_for_text_body():
    """The message body lives in row.content, NOT row.payload.text."""
    method = _slice_method(
        _read_ts("lib/api-client.ts"), "listSessionMessages",
    )
    assert "row.content" in method, (
        "listSessionMessages doesn't read row.content — every history "
        "row's text will render empty."
    )
    assert "row.payload" not in method, (
        "listSessionMessages still references row.payload — the wire "
        "format doesn't have a 'payload' field; this is the old raw "
        "event-log shape. Read row.content instead."
    )


def test_parser_role_taxonomy_is_three_way():
    """Maps assistant→agent and user→user; anything else falls to
    'system' so an unknown future role doesn't render in the wrong bubble."""
    method = _slice_method(
        _read_ts("lib/api-client.ts"), "listSessionMessages",
    )
    # Both branches present.
    assert "'assistant'" in method and "'agent'" in method, (
        "Parser is missing the assistant→agent role mapping. Without "
        "it agent responses render in the user bubble."
    )
    assert "'user'" in method, "user role branch missing"
    assert "'system'" in method, "system fallback branch missing"


def test_parser_parses_iso_timestamp_to_unix_seconds():
    method = _slice_method(
        _read_ts("lib/api-client.ts"), "listSessionMessages",
    )
    # We expect Date.parse on the ISO string. If someone "simplifies"
    # this to just forwarding the string the type would still pass
    # (ts: number) but the runtime cast would NaN.
    assert "Date.parse" in method, (
        "listSessionMessages no longer Date.parse's row.timestamp — "
        "the wire field is ISO-8601 string but ChatMessageRow.ts is "
        "typed number (unix seconds). Without the conversion every "
        "history row gets NaN/0 timestamps and 'just now' relative "
        "labels are wrong."
    )


def test_chat_message_row_attachments_is_object_shape():
    src = _read_ts("lib/api-client.ts")
    # Find the ChatMessageRow interface block.
    m = re.search(
        r"export interface ChatMessageRow \{[\s\S]+?\n\}",
        src,
    )
    assert m, "ChatMessageRow interface block not isolatable"
    block = m.group(0)
    # Must reference the new object shape.
    assert "ChatAttachmentInfo" in block, (
        "ChatMessageRow.attachments still typed as string[] — server "
        "sends [{name, mime, size_bytes}] not string[]; the next site "
        "that does `.attachments[0].name` will hit a TS error."
    )


def test_chat_attachment_info_has_three_fields():
    src = _read_ts("lib/api-client.ts")
    m = re.search(
        r"export interface ChatAttachmentInfo \{[\s\S]+?\n\}",
        src,
    )
    assert m, "ChatAttachmentInfo interface block not isolatable"
    block = m.group(0)
    for field in ("name", "mime", "sizeBytes"):
        assert field in block, (
            f"ChatAttachmentInfo.{field} missing — mirror "
            "AttachmentInfo in agent_state.py (3 fields: name, mime, "
            "size_bytes)."
        )


# ─────────────────────────────────────────────────────────────────────
# Server-side contract guard: ChatMessageView still has the fields the
# client parser depends on. If a future server refactor renames these
# back or changes types, the client breaks silently — this catches it.
# ─────────────────────────────────────────────────────────────────────


def test_server_chat_message_view_shape_is_stable():
    src = (SERVER_SRC / "agent_state.py").read_text()
    # Slice the ChatMessageView class.
    m = re.search(
        r"class ChatMessageView\(BaseModel\):[\s\S]+?\n\n\n",
        src,
    )
    assert m, "ChatMessageView class not isolatable"
    block = m.group(0)
    # These are the four fields the desktop parser depends on. If any
    # gets renamed/removed, that side breaks immediately — the test
    # forces a coordinated update.
    for field in ("role", "content", "timestamp", "sync_id"):
        assert re.search(rf"^\s*{field}\s*:", block, re.MULTILINE), (
            f"ChatMessageView.{field} missing — the desktop's "
            "listSessionMessages parser reads this field directly. "
            "Coordinate any rename with api-client.ts."
        )


def test_server_attachment_info_has_three_fields():
    src = (SERVER_SRC / "agent_state.py").read_text()
    m = re.search(
        r"class AttachmentInfo\(BaseModel\):[\s\S]+?\n\n\n",
        src,
    )
    assert m, "AttachmentInfo class not isolatable"
    block = m.group(0)
    for field in ("name", "mime", "size_bytes"):
        assert re.search(rf"^\s*{field}\s*:", block, re.MULTILINE), (
            f"AttachmentInfo.{field} missing — ChatAttachmentInfo on "
            "the client mirrors this. Don't drift them apart."
        )
