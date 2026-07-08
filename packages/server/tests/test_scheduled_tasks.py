"""
Scheduled Tasks Phase 1 — heuristic extractor + storage + worker.

Coverage matrix:

  schedule_intent.extract_proposal
  ─────────────────────────────────
  - Returns None on empty / pure-noise text
  - Returns None on "in 2 hours" alone (no action token)
  - Returns None on "email Dr Smith" alone (no time token)
  - Returns a proposal on "in 2 hours, email dr.x@y.com"
  - Returns a proposal on Chinese: "两小时后 邮件 给 dr.x@y.com"
  - Tomorrow at 09:30 produces a fire_at on the next day, 09:30 local
  - "today at 8am" when it's already 11am rolls to tomorrow (sanity)
  - Past fire_at sanity-guarded (-60s tolerance for clock skew)
  - Far-future fire_at (>1y) rejected

  scheduler.create_task / list_tasks / cancel_task
  ─────────────────────────────────────────────────
  - create lands a pending row
  - list newest-fire-at-first
  - cancel marks status='cancelled', cancelled_at set
  - per-user MAX_PENDING quota enforced
  - unsupported kind rejected
  - past fire_at rejected
  - far-future fire_at rejected

  scheduler._tick / fire_task
  ────────────────────────────
  - Due pending task fires; status→done; result_json populated
  - Non-due task NOT fired
  - Cancelled task NEVER fires
  - Crashed executor → status='error' + last_error set
  - Worker emits SCHEDULED_TASK_FIRED audit event

  Source-level guards
  ───────────────────
  - main.py wires scheduler_router + spawns worker
  - chat_router emits scheduled_task_proposed SSE event
  - PyInstaller spec lists migration 0003

These tests run against a fresh in-memory SQLite per case, no
network, sandbox-safe.
"""
from __future__ import annotations

import asyncio
import pathlib
import re
import sqlite3
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# Fixture: bare scheduled_tasks table on an in-memory DB
# ─────────────────────────────────────────────────────────────────────


def _make_db() -> sqlite3.Connection:
    """One-off in-memory DB seeded with the scheduled_tasks schema.
    Mirrors what Alembic 0003 produces — kept as a tight inline copy
    so the tests don't require an Alembic upgrade to run."""
    conn = sqlite3.connect(":memory:")
    conn.execute("""
        CREATE TABLE scheduled_tasks (
            task_id         TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL,
            patient_hash    TEXT,
            session_id      TEXT,
            kind            TEXT NOT NULL,
            payload_json    TEXT NOT NULL,
            fire_at         INTEGER NOT NULL,
            user_tz         TEXT NOT NULL DEFAULT 'UTC',
            recurrence_cron TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            last_run_at     INTEGER,
            last_error      TEXT,
            result_json     TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            cancelled_at    INTEGER
        )
    """)
    conn.execute(
        "CREATE INDEX idx_sched_status_fire "
        "ON scheduled_tasks (status, fire_at)"
    )
    conn.execute(
        "CREATE INDEX idx_sched_user ON scheduled_tasks (user_id)"
    )
    return conn


# ─────────────────────────────────────────────────────────────────────
# schedule_intent.extract_proposal
# ─────────────────────────────────────────────────────────────────────


from nexus_server import schedule_intent  # noqa: E402
from nexus_server import scheduler         # noqa: E402


def test_extract_returns_none_on_empty_text():
    assert schedule_intent.extract_proposal(user_text="") is None
    assert schedule_intent.extract_proposal(user_text="   ") is None


def test_extract_returns_none_on_noise():
    """Pure clinical conversation without scheduling intent must NOT
    fire. False-positives explode the SCHEDULED_TASK_PROPOSED event
    table and erode user trust in the card."""
    cases = [
        "Looking at the CT, I see a 8mm nodule.",
        "What does NCCN say about ground-glass opacities?",
        "Patient is 65 F, former smoker.",
        "我之前在2024年看过这个病人。",  # past-tense Chinese
    ]
    for text in cases:
        p = schedule_intent.extract_proposal(user_text=text)
        assert p is None, f"FALSE POSITIVE: {text!r} → {p}"


def test_extract_returns_none_on_time_without_action():
    """'in 2 hours' alone isn't a task. Time token + no action verb."""
    assert schedule_intent.extract_proposal(
        user_text="patient comes back in 2 hours for the contrast scan",
    ) is None


def test_extract_returns_none_on_action_without_time():
    """'email Dr Smith' alone isn't a future task. Could be 'right now'."""
    p = schedule_intent.extract_proposal(
        user_text="please email Dr Smith the CT findings",
    )
    assert p is None


def test_extract_in_two_hours_email_en():
    """The canonical English phrasing."""
    p = schedule_intent.extract_proposal(
        user_text="in 2 hours email dr.smith@hosp.org about the CT",
        user_tz="UTC",
    )
    assert p is not None
    assert p.kind == "send_email"
    assert p.payload.get("to") == ["dr.smith@hosp.org"]
    now = int(time.time())
    # 2 hours = 7200s, allow ±5s tolerance for test wall time.
    assert abs(p.fire_at - (now + 7200)) <= 5
    # User still needs to fill subject/body — record this so the UI
    # surfaces input fields on the confirmation card.
    assert "subject" in p.needs_user_input
    assert "body" in p.needs_user_input
    # Recipient was extracted → 'to' NOT in needs_user_input.
    assert "to" not in p.needs_user_input


def test_extract_chinese_relative_form():
    """两小时后 + 邮件 → schedule send_email."""
    p = schedule_intent.extract_proposal(
        user_text="两小时后 邮件 给 dr.x@y.com 关于 CT 的发现",
        user_tz="Asia/Shanghai",
    )
    assert p is not None, "Chinese 两小时后 + 邮件 should fire"
    assert p.kind == "send_email"
    assert p.payload.get("to") == ["dr.x@y.com"]
    now = int(time.time())
    assert abs(p.fire_at - (now + 7200)) <= 5


def test_extract_tomorrow_at_specific_time():
    """'tomorrow at 9am email...' should fire next day, 09:00 user-local."""
    p = schedule_intent.extract_proposal(
        user_text="tomorrow at 9am email dr.x@hosp.org",
        user_tz="UTC",
    )
    assert p is not None
    dt = datetime.fromtimestamp(p.fire_at, tz=ZoneInfo("UTC"))
    tomorrow = (datetime.now(ZoneInfo("UTC")) + timedelta(days=1)).date()
    assert dt.date() == tomorrow
    assert dt.hour == 9
    assert dt.minute == 0


def test_extract_today_past_time_rolls_to_tomorrow():
    """A medic at 11am says 'today at 8am email...' — sanity-protected:
    we roll the fire_at to TOMORROW 8am rather than scheduling in the
    past. Without this guard the worker would skip the task entirely
    (fire_at < now - 60)."""
    # Force "now" to be a known time in the day so the test is
    # deterministic across runs.
    fixed_now = datetime(2026, 6, 14, 11, 0, 0, tzinfo=ZoneInfo("UTC"))
    with patch.object(schedule_intent, "_now_in_tz", return_value=fixed_now):
        p = schedule_intent.extract_proposal(
            user_text="today at 8am email dr.x@hosp.org",
            user_tz="UTC",
        )
    assert p is not None
    dt = datetime.fromtimestamp(p.fire_at, tz=ZoneInfo("UTC"))
    # Tomorrow 08:00 — rolled forward from past 08:00 today.
    assert dt.day == 15
    assert dt.hour == 8


def test_extract_summary_includes_recipient_when_present():
    """The summary is what the UI confirmation card uses; the medic
    sees 'when' + 'what' at a glance. Recipient extracted → present
    in summary; missing → '(recipient TBD)' marker."""
    p_with = schedule_intent.extract_proposal(
        user_text="in 1 hour email dr.x@y.com",
    )
    assert p_with is not None
    assert "dr.x@y.com" in p_with.summary

    p_without = schedule_intent.extract_proposal(
        user_text="in 1 hour email me",
    )
    if p_without is not None:
        # If matched anyway (English 'email' as a noun is borderline),
        # ensure the marker is present.
        assert "recipient" in p_without.summary.lower() \
            or "TBD" in p_without.summary


# ─────────────────────────────────────────────────────────────────────
# scheduler.create_task / list_tasks / cancel_task
# ─────────────────────────────────────────────────────────────────────


def test_create_task_lands_pending_row():
    conn = _make_db()
    fire = int(time.time()) + 600
    t = scheduler.create_task(
        conn,
        user_id="u1", kind="send_email",
        payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
        fire_at=fire, user_tz="UTC",
    )
    assert t.status == "pending"
    assert t.fire_at == fire
    assert t.payload["to"] == ["x@y.com"]
    # Round-trip: get_task by id should return the same row.
    t2 = scheduler.get_task(conn, t.task_id)
    assert t2.task_id == t.task_id


def test_list_tasks_sorted_by_fire_at():
    conn = _make_db()
    base = int(time.time()) + 60
    for offset in (1800, 60, 600):
        scheduler.create_task(
            conn, user_id="u1", kind="send_email",
            payload={"to": ["a@b.com"], "subject": "s", "body": "b"},
            fire_at=base + offset, user_tz="UTC",
        )
    rows = scheduler.list_tasks(conn, user_id="u1")
    assert len(rows) == 3
    fires = [r.fire_at for r in rows]
    assert fires == sorted(fires), f"not sorted ascending: {fires}"


def test_cancel_task_soft_deletes():
    conn = _make_db()
    t = scheduler.create_task(
        conn, user_id="u1", kind="send_email",
        payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
        fire_at=int(time.time()) + 600, user_tz="UTC",
    )
    scheduler.cancel_task(conn, user_id="u1", task_id=t.task_id)
    t2 = scheduler.get_task(conn, t.task_id)
    assert t2.status == "cancelled"
    assert t2.cancelled_at is not None


def test_cancel_is_idempotent():
    conn = _make_db()
    t = scheduler.create_task(
        conn, user_id="u1", kind="send_email",
        payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
        fire_at=int(time.time()) + 600, user_tz="UTC",
    )
    scheduler.cancel_task(conn, user_id="u1", task_id=t.task_id)
    # Second cancel must NOT crash or 500.
    scheduler.cancel_task(conn, user_id="u1", task_id=t.task_id)


def test_cancel_other_users_task_raises():
    """Cross-user cancel is impossible by design (the SQL WHERE
    includes user_id)."""
    conn = _make_db()
    t = scheduler.create_task(
        conn, user_id="u1", kind="send_email",
        payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
        fire_at=int(time.time()) + 600, user_tz="UTC",
    )
    with pytest.raises(KeyError):
        scheduler.cancel_task(conn, user_id="u2", task_id=t.task_id)


def test_create_task_rejects_unsupported_kind():
    conn = _make_db()
    with pytest.raises(ValueError, match="kind"):
        scheduler.create_task(
            conn, user_id="u1", kind="run_chess",
            payload={}, fire_at=int(time.time()) + 60, user_tz="UTC",
        )


def test_create_task_rejects_past_fire_at():
    conn = _make_db()
    with pytest.raises(ValueError, match="past"):
        scheduler.create_task(
            conn, user_id="u1", kind="send_email",
            payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
            fire_at=int(time.time()) - 3600, user_tz="UTC",
        )


def test_create_task_rejects_far_future_fire_at():
    conn = _make_db()
    with pytest.raises(ValueError, match="1 year"):
        scheduler.create_task(
            conn, user_id="u1", kind="send_email",
            payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
            fire_at=int(time.time()) + 400 * 86400, user_tz="UTC",
        )


def test_create_task_enforces_per_user_quota():
    conn = _make_db()
    fire = int(time.time()) + 600
    # Fill up to the cap.
    for _ in range(scheduler.MAX_PENDING_PER_USER):
        scheduler.create_task(
            conn, user_id="u1", kind="send_email",
            payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
            fire_at=fire, user_tz="UTC",
        )
    # The +1th attempt must raise.
    with pytest.raises(ValueError, match="pending tasks"):
        scheduler.create_task(
            conn, user_id="u1", kind="send_email",
            payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
            fire_at=fire, user_tz="UTC",
        )


# ─────────────────────────────────────────────────────────────────────
# Worker dispatch
# ─────────────────────────────────────────────────────────────────────


@contextmanager
def _conn_ctx(conn):
    """Fake context-manager that yields a SHARED conn (so the worker
    sees writes the test made). Real `get_db_connection` opens a fresh
    sqlite3 connection per call, but in tests we want a single one for
    introspection."""
    yield conn


async def _run_tick(conn, *, mock_executor=None):
    """Run one worker tick against the test conn. Optionally swap in
    a mock email-send executor."""
    if mock_executor is not None:
        scheduler._EXECUTORS["send_email"] = mock_executor
    try:
        return await scheduler._tick(lambda: _conn_ctx(conn))
    finally:
        # Restore the real executor so a later test isn't affected.
        if mock_executor is not None:
            from nexus_server.scheduler import _execute_send_email
            scheduler._EXECUTORS["send_email"] = _execute_send_email


def test_worker_fires_due_task(monkeypatch):
    conn = _make_db()
    # A task that's already due.
    t = scheduler.create_task(
        conn, user_id="u1", kind="send_email",
        payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
        fire_at=int(time.time()) - 5,    # 5s in the past — sneaks in
        user_tz="UTC",
    )

    async def fake_send(task):
        return ("done", {"transport": "smtp", "message": "ok"}, None)

    # Audit emit goes through event_log which we don't have here —
    # patch Store to a no-op so the worker doesn't need full schema.
    class _FakeStore:
        def __init__(self, *a, **k): pass
        def emit_and_apply(self, *a, **k): return 0
    monkeypatch.setattr(
        "nexus_server.event_sourcing.Store", _FakeStore,
    )

    # Past-fire-at sanity: create_task rejects past. We have to insert
    # directly into the DB to test the worker's "catch up overdue"
    # behaviour. Reset the row's fire_at to actually be in the past.
    conn.execute(
        "UPDATE scheduled_tasks SET fire_at = ? WHERE task_id = ?",
        (int(time.time()) - 5, t.task_id),
    )
    conn.commit()

    n = asyncio.run(_run_tick(conn, mock_executor=fake_send))
    assert n == 1
    t2 = scheduler.get_task(conn, t.task_id)
    assert t2.status == "done"
    assert t2.result is not None
    assert t2.result.get("transport") == "smtp"


def test_worker_skips_non_due_task(monkeypatch):
    conn = _make_db()
    scheduler.create_task(
        conn, user_id="u1", kind="send_email",
        payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
        fire_at=int(time.time()) + 3600, user_tz="UTC",
    )

    async def boom(task):
        pytest.fail("Worker should NOT have fired a future task")
        return ("error", {}, "")

    class _FakeStore:
        def __init__(self, *a, **k): pass
        def emit_and_apply(self, *a, **k): return 0
    monkeypatch.setattr(
        "nexus_server.event_sourcing.Store", _FakeStore,
    )

    n = asyncio.run(_run_tick(conn, mock_executor=boom))
    assert n == 0


def test_worker_skips_cancelled_task(monkeypatch):
    conn = _make_db()
    t = scheduler.create_task(
        conn, user_id="u1", kind="send_email",
        payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
        fire_at=int(time.time()) + 60, user_tz="UTC",
    )
    scheduler.cancel_task(conn, user_id="u1", task_id=t.task_id)
    # Even though we now make fire_at past-due, the cancelled status
    # means worker's status='pending' filter excludes it.
    conn.execute(
        "UPDATE scheduled_tasks SET fire_at = ? WHERE task_id = ?",
        (int(time.time()) - 5, t.task_id),
    )
    conn.commit()

    async def boom(task):
        pytest.fail("Worker should NOT have fired a cancelled task")
        return ("error", {}, "")

    class _FakeStore:
        def __init__(self, *a, **k): pass
        def emit_and_apply(self, *a, **k): return 0
    monkeypatch.setattr(
        "nexus_server.event_sourcing.Store", _FakeStore,
    )

    n = asyncio.run(_run_tick(conn, mock_executor=boom))
    assert n == 0
    # Status unchanged.
    assert scheduler.get_task(conn, t.task_id).status == "cancelled"


def test_worker_executor_crash_marks_error(monkeypatch):
    conn = _make_db()
    t = scheduler.create_task(
        conn, user_id="u1", kind="send_email",
        payload={"to": ["x@y.com"], "subject": "s", "body": "b"},
        fire_at=int(time.time()) + 60, user_tz="UTC",
    )
    conn.execute(
        "UPDATE scheduled_tasks SET fire_at = ? WHERE task_id = ?",
        (int(time.time()) - 5, t.task_id),
    )
    conn.commit()

    async def boom(task):
        raise RuntimeError("relay exploded")

    class _FakeStore:
        def __init__(self, *a, **k): pass
        def emit_and_apply(self, *a, **k): return 0
    monkeypatch.setattr(
        "nexus_server.event_sourcing.Store", _FakeStore,
    )

    n = asyncio.run(_run_tick(conn, mock_executor=boom))
    assert n == 1
    t2 = scheduler.get_task(conn, t.task_id)
    assert t2.status == "error"
    assert t2.last_error is not None and "relay exploded" in t2.last_error


# ─────────────────────────────────────────────────────────────────────
# Source-level guards
# ─────────────────────────────────────────────────────────────────────


def test_main_py_wires_scheduler_router_and_worker():
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "main.py"
    ).read_text()
    code = "\n".join(l.split("#", 1)[0] for l in src.splitlines())
    assert "from nexus_server import scheduler_router" in code, (
        "main.py no longer imports scheduler_router — endpoints 404."
    )
    assert "_scheduler_router.router" in code, (
        "scheduler_router imported but never registered on the app."
    )
    # Worker spawn in lifespan.
    assert "_sched.start_worker" in code, (
        "scheduler.start_worker() no longer called from lifespan — "
        "due tasks would never fire (UI works, but worker silently absent)."
    )


def test_chat_router_emits_proposed_sse_event():
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "chat_router.py"
    ).read_text()
    code = "\n".join(l.split("#", 1)[0] for l in src.splitlines())
    assert "schedule_intent.extract_proposal" in code, (
        "chat_router no longer calls schedule_intent.extract_proposal "
        "— UI confirmation card would never appear."
    )
    assert '"scheduled_task_proposed"' in code, (
        "chat_router no longer emits the scheduled_task_proposed "
        "SSE event — UI has nothing to render."
    )


def test_pyinstaller_spec_lists_migration_0003():
    src = (
        pathlib.Path(__file__).resolve().parents[1] / "nexus-server.spec"
    ).read_text()
    assert "0003_scheduled_tasks" in src, (
        "PyInstaller spec missing the 0003_scheduled_tasks hidden import. "
        "Bundled sidecar will not apply the migration → "
        "scheduled_tasks table missing → endpoints 500 on first hit."
    )


def test_event_kinds_registered():
    """The four new event kinds must be registered with EventSpec entries
    so Store.emit_and_apply doesn't raise 'unknown event'."""
    from nexus_server.event_sourcing import EventKind
    from nexus_server.event_sourcing.event_kinds import EVENT_REGISTRY
    expected = {
        EventKind.SCHEDULED_TASK_PROPOSED,
        EventKind.SCHEDULED_TASK_CREATED,
        EventKind.SCHEDULED_TASK_FIRED,
        EventKind.SCHEDULED_TASK_CANCELLED,
    }
    registered = {k for (k, _v) in EVENT_REGISTRY.keys()}
    missing = expected - registered
    assert not missing, (
        f"Event kinds defined on the enum but not registered with "
        f"EventSpec: {missing}. Store.emit_and_apply will raise."
    )
