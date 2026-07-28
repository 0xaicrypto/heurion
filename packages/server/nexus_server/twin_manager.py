"""Per-user Nexus DigitalTwin lifecycle (local-only mode).

Server owns one DigitalTwin instance per logged-in user, lazy-created
on first chat request and idle-evicted after a configurable timeout.
Chain/BSC anchoring was removed in Phase B; twins now run in local-only
mode.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from nexus_server.config import get_config
from nexus_server.database import get_db_connection

logger = logging.getLogger(__name__)
config = get_config()


# ── Tunables ──────────────────────────────────────────────────────────

TWIN_IDLE_SECONDS = int(getattr(config, "TWIN_IDLE_SECONDS", 30 * 60))
TWIN_REAPER_INTERVAL = 60.0
TWIN_BASE_DIR = Path(
    getattr(config, "TWIN_BASE_DIR", Path.home() / ".nexus_server" / "twins")
)


# ── In-memory registry ────────────────────────────────────────────────


@dataclass
class _TwinSession:
    twin: object
    last_used: float = field(default_factory=time.time)
    user_id: str = ""

    def touch(self) -> None:
        self.last_used = time.time()


_sessions: dict[str, _TwinSession] = {}
_lock = asyncio.Lock()
_reaper_task: Optional[asyncio.Task] = None
_test_override: Optional[object] = None


# ── Lazy create / cache ───────────────────────────────────────────────


async def _create_twin(user_id: str):
    """Build a fresh local DigitalTwin for ``user_id``."""
    from nexus.twin import DigitalTwin

    user_dir = TWIN_BASE_DIR / user_id
    user_dir.mkdir(parents=True, exist_ok=True)

    api_key = config.GEMINI_API_KEY or ""
    if not api_key:
        raise RuntimeError(
            "TwinManager: GEMINI_API_KEY not configured — twin chat path needs it"
        )

    logger.info("TwinManager: creating local twin for user %s", user_id)

    twin = await DigitalTwin.create(
        name="Nexus Agent",
        owner=user_id,
        agent_id=f"user-{user_id[:8]}",
        llm_provider="gemini",
        llm_api_key=api_key,
        base_dir=str(user_dir),
        enable_tools=True,
        tavily_api_key=config.TAVILY_API_KEY or "",
    )

    try:
        from nexus_server.files import list_user_files as _list_for_user
        from nexus_server.files import resolve_file_text as _resolve_for_user
        if getattr(twin, "_file_reader", None) is not None:
            twin._file_reader._resolver = (
                lambda fname, _uid=user_id: _resolve_for_user(_uid, fname)
            )
            twin._file_reader._lister = (
                lambda _uid=user_id: _list_for_user(_uid)
            )
            logger.debug("ReadUploadedFileTool resolver bound for user %s", user_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not wire SQL-backed file resolver for %s: %s", user_id, e)

    try:
        from nexus_server.session_sync import replay_session_metadata
        replay_session_metadata(user_id, twin)
    except Exception as e:  # noqa: BLE001
        logger.debug("session_metadata replay skipped for %s: %s", user_id, e)

    _USER_SCOPED_TOOL_REGISTRARS = (
        ("nexus_server.tools_workflow", "register_workflow_tools", "Workflow"),
        ("nexus_server.tools_memory", "register_memory_tools", "Memory"),
        ("nexus_server.tools_subagent", "register_subagent_tools", "Subagent"),
        ("nexus_server.tools_calendar", "register_calendar_tools", "Calendar"),
        ("nexus_server.tools_evolve", "register_evolve_tools", "Evolve"),
        ("nexus_server.tools_ocr", "register_ocr_tools", "OCR"),
        ("nexus_server.tools_async", "register_async_tools", "AsyncTasks"),
        ("nexus_server.sandbox_router", "register_sandbox_tool", "Sandbox"),
    )
    for module_path, fn_name, label in _USER_SCOPED_TOOL_REGISTRARS:
        try:
            module = __import__(module_path, fromlist=[fn_name])
            getattr(module, fn_name)(twin, user_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("%s tools not registered for %s: %s", label, user_id, e)

    try:
        from nexus_server.skills_router import apply_disabled_overlay
        apply_disabled_overlay(twin, user_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("skill prefs overlay not applied for %s: %s", user_id, e)

    return twin


async def get_twin(user_id: str):
    """Return a (cached or freshly created) DigitalTwin for ``user_id``."""
    if _test_override is not None:
        return _test_override

    async with _lock:
        sess = _sessions.get(user_id)
        if sess is not None:
            sess.touch()
            return sess.twin

        logger.info("TwinManager: cold-starting twin for user %s", user_id)
        twin = await _create_twin(user_id)
        _sessions[user_id] = _TwinSession(twin=twin, user_id=user_id)
        return twin


async def close_user(user_id: str) -> None:
    """Close + drop one user's twin."""
    async with _lock:
        sess = _sessions.pop(user_id, None)
    if sess is None:
        return
    try:
        if hasattr(sess.twin, "close"):
            await sess.twin.close()
    except Exception as e:
        logger.warning("twin.close() failed for %s: %s", user_id, e)


# ── Reaper task (idle eviction) ───────────────────────────────────────


async def _reaper_loop(stop_event: asyncio.Event) -> None:
    logger.info(
        "TwinManager reaper: interval=%.0fs idle_cap=%ds",
        TWIN_REAPER_INTERVAL, TWIN_IDLE_SECONDS,
    )
    while not stop_event.is_set():
        try:
            now = time.time()
            stale_uids: list[str] = []
            async with _lock:
                for uid, sess in _sessions.items():
                    if now - sess.last_used > TWIN_IDLE_SECONDS:
                        stale_uids.append(uid)
            for uid in stale_uids:
                logger.info("TwinManager: evicting idle twin user=%s", uid)
                await close_user(uid)
        except Exception as e:
            logger.warning("Twin reaper tick failed: %s", e)

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=TWIN_REAPER_INTERVAL)
            return
        except asyncio.TimeoutError:
            continue


def start_reaper() -> tuple[asyncio.Task, asyncio.Event]:
    """Spin up the eviction loop. Call once from main.lifespan startup."""
    stop_event = asyncio.Event()
    task = asyncio.create_task(_reaper_loop(stop_event), name="twin-reaper")
    return task, stop_event


async def shutdown_all(stop_event: asyncio.Event,
                       reaper_task: asyncio.Task | None) -> None:
    """Stop the reaper and close every active twin."""
    stop_event.set()
    if reaper_task is not None:
        try:
            await asyncio.wait_for(reaper_task, timeout=5.0)
        except asyncio.TimeoutError:
            reaper_task.cancel()
            try:
                await reaper_task
            except asyncio.CancelledError as e:
                logger.debug("reaper task cancelled during shutdown: %s", e)

    async with _lock:
        uids = list(_sessions.keys())
    for uid in uids:
        await close_user(uid)


# ── Introspection ─────────────────────────────────────────────────────


def is_active(user_id: str) -> bool:
    return user_id in _sessions


def session_count() -> int:
    return len(_sessions)
