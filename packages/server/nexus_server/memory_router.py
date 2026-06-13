"""LEGACY — superseded by `memory_router_v2` (Rev-8 event-sourced path).

Per ADR-002 Rev-5 / Rev-8 + design v3 §16, the v3 memory layer
(``memory_router_v2``) is the canonical surface for medic-facing memory
management. This module operates over the pre-#176 ``twin.curated_memory``
markdown blob, which is **deprecated** by the per-patient Layer 1 graph
projections. Keep alive through M5 cutover so existing AccountView
"Memory" tabs continue to work; remove once desktop-v2 ships Memory mode
(U3.1 — #196 design v2 §5.6).

**DO NOT add new features here.** Add them to ``memory_router_v2`` instead.

────────────────────────────────────────────────────────────────────────
Original docstring (Phase C-2):

Backs the desktop AccountView "Memory" tab. Mirrors Claude.ai's
"View and edit memory" panel: users can see exactly what the agent
remembers, edit the memory text in-place, pause new memory writes,
or wipe all memory.

Endpoints (all under /api/v1/agent/memory, all require auth):

  GET    /                   — return current memory snapshot:
                                {memory: [...], user: [...], persona,
                                 paused, char_used, char_limit}
  PUT    /memory             — replace the MEMORY.md entries list
                                {entries: [...]}
  PUT    /user               — replace the USER.md entries list
  POST   /pause              — flip the paused flag on
  POST   /resume             — flip it off
  DELETE /                   — wipe all memory (cannot be undone)

Persistence: the SDK's CuratedMemory writes to disk on every mutation,
so changes survive process restart. The "paused" flag is a flat file
``curated_memory/.paused`` next to MEMORY.md / USER.md — when present,
twin.chat skips any auto-add_memory / add_user_info calls (Phase C-2b
work; for now the flag is honoured by best-effort hooks in twin.py).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from nexus_server.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/agent/memory", tags=["memory"])


# ─────────────────────────────────────────────────────────────────────
# Wire models
# ─────────────────────────────────────────────────────────────────────


class MemorySnapshot(BaseModel):
    """Full memory state — what the agent remembers + meta."""
    memory_entries: list[str] = Field(default_factory=list)
    user_entries: list[str] = Field(default_factory=list)
    persona: str = ""
    paused: bool = False
    # Sizing info so the desktop can render "1240 / 3000 characters" hints.
    memory_chars_used: int = 0
    memory_chars_limit: int = 3000
    user_chars_used: int = 0
    user_chars_limit: int = 2000


class ReplaceEntriesRequest(BaseModel):
    """Body for PUT /memory and PUT /user — full replacement of the
    entries list. Sending an empty list clears that bucket."""
    entries: list[str] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _paused_marker(curated) -> Path:
    """Path to the marker file used as the paused flag. The marker
    lives next to MEMORY.md so it shares the same backup / replication
    lifecycle as the memory it gates."""
    return curated._dir / ".paused"


def _is_paused(curated) -> bool:
    try:
        return _paused_marker(curated).exists()
    except Exception:  # noqa: BLE001
        return False


async def _get_twin(user_id: str):
    """Lazy import + fetch — avoids circulars during server boot."""
    from nexus_server.twin_manager import get_twin
    return await get_twin(user_id)


def _snapshot(twin) -> MemorySnapshot:
    cm = twin.curated_memory
    persona = ""
    try:
        persona = twin.evolution.get_current_persona() or ""
    except Exception:  # noqa: BLE001
        persona = ""

    memory_entries = cm.memory_entries
    user_entries = cm.user_entries
    return MemorySnapshot(
        memory_entries=memory_entries,
        user_entries=user_entries,
        persona=persona,
        paused=_is_paused(cm),
        memory_chars_used=sum(len(e) for e in memory_entries),
        memory_chars_limit=3000,  # MEMORY_CHAR_LIMIT in SDK
        user_chars_used=sum(len(e) for e in user_entries),
        user_chars_limit=2000,    # USER_CHAR_LIMIT in SDK
    )


def _write_entries(cm, path: Path, attr: str, entries: list[str]) -> None:
    """Replace the in-memory list AND persist atomically using the
    SDK's existing tempfile-write helper. We're reaching into private
    attributes intentionally — CuratedMemory's public API is
    add/remove (incremental), but we want a full replace."""
    deduped: list[str] = []
    seen: set[str] = set()
    for e in entries:
        s = (e or "").strip()
        if s and s not in seen:
            deduped.append(s)
            seen.add(s)
    cm._write_file(path, deduped)
    setattr(cm, attr, deduped)
    cm.refresh_snapshot()


# ─────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────


@router.get("/", response_model=MemorySnapshot)
async def get_memory(
    current_user: str = Depends(get_current_user),
) -> MemorySnapshot:
    """Read the full memory snapshot for the calling user."""
    twin = await _get_twin(current_user)
    return _snapshot(twin)


@router.put("/memory", response_model=MemorySnapshot)
async def replace_memory_entries(
    req: ReplaceEntriesRequest,
    current_user: str = Depends(get_current_user),
) -> MemorySnapshot:
    """Replace the MEMORY.md entries list (facts / lessons /
    conventions). Pass empty list to clear that bucket only."""
    twin = await _get_twin(current_user)
    cm = twin.curated_memory
    # Char-limit guard so a malicious / accidental huge payload can't
    # bypass the SDK's own truncation logic.
    total = sum(len(e) for e in req.entries)
    if total > 8000:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Memory payload too large: {total} chars (max 8000)",
        )
    _write_entries(cm, cm._memory_path, "_memory_entries", req.entries)
    return _snapshot(twin)


@router.put("/user", response_model=MemorySnapshot)
async def replace_user_entries(
    req: ReplaceEntriesRequest,
    current_user: str = Depends(get_current_user),
) -> MemorySnapshot:
    """Replace the USER.md entries list (preferences / style)."""
    twin = await _get_twin(current_user)
    cm = twin.curated_memory
    total = sum(len(e) for e in req.entries)
    if total > 6000:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"User-info payload too large: {total} chars (max 6000)",
        )
    _write_entries(cm, cm._user_path, "_user_entries", req.entries)
    return _snapshot(twin)


@router.post("/pause", response_model=MemorySnapshot)
async def pause_memory(
    current_user: str = Depends(get_current_user),
) -> MemorySnapshot:
    """Pause memory writes. Existing entries stay, but the agent's
    background loops stop adding new ones until resumed."""
    twin = await _get_twin(current_user)
    cm = twin.curated_memory
    try:
        _paused_marker(cm).touch(exist_ok=True)
    except Exception as e:  # noqa: BLE001
        logger.warning("pause_memory: marker write failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to pause memory: {e}",
        )
    return _snapshot(twin)


@router.post("/resume", response_model=MemorySnapshot)
async def resume_memory(
    current_user: str = Depends(get_current_user),
) -> MemorySnapshot:
    twin = await _get_twin(current_user)
    cm = twin.curated_memory
    try:
        marker = _paused_marker(cm)
        if marker.exists():
            marker.unlink()
    except Exception as e:  # noqa: BLE001
        logger.warning("resume_memory: marker delete failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to resume memory: {e}",
        )
    return _snapshot(twin)


@router.delete("/", response_model=MemorySnapshot)
async def reset_memory(
    current_user: str = Depends(get_current_user),
) -> MemorySnapshot:
    """Permanently delete all memory entries. The persona itself is
    NOT touched here — that lives in PersonaStore and is mutated via
    a separate evolution path. Only the curated MEMORY/USER buckets
    are wiped. Cannot be undone."""
    twin = await _get_twin(current_user)
    cm = twin.curated_memory
    _write_entries(cm, cm._memory_path, "_memory_entries", [])
    _write_entries(cm, cm._user_path, "_user_entries", [])
    logger.info("Memory wiped for user %s", current_user)
    return _snapshot(twin)
