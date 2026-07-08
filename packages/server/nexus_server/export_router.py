"""
Settings → Data export endpoints.

The Settings · Data overlay in desktop-v2 advertises a self-contained
export bundle (FHIR R5 + JSON + SQL dump) and an archive folder under
``~/Documents/Nexus Archive/``. This router implements the minimum the UI
needs to be honest:

  GET  /api/v1/export/archive_path  → resolved on-disk path (string)
  POST /api/v1/export/bundle        → builds a zip, returns metadata

The bundle is intentionally simple in M3.3-pre:

  Nexus-export-<user_id8>-<unix_ts>.zip
  ├── manifest.json          - { user_id, created_at, schema_version,
  │                              counts, source_db_path }
  ├── twin_event_log.db      - copy of the user's append-only EventLog
  │                            (the canonical source — everything else
  │                            is derived. Drop a projection, replay the
  │                            log, rebuild byte-identical.)
  └── README.txt             - one-pager pointing at docs/exports

Why this layout: per docs/design/m3-memory-architecture.md §3.3, every
projection table is a materialised view of ``twin_event_log``. Shipping
the event log + the schema version is enough for any other Nexus install
to fully reconstruct the user's state. FHIR R5 and a SQL dump in
canonical form are deferred to M3.3 finalize — they're nice-to-have, not
"my data is yours" foundational.
"""
from __future__ import annotations

import json
import logging
import os
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from nexus_server.auth import get_current_user
from nexus_server.twin_event_log import _db_path  # internal — see file

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/export", tags=["export"])


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _archive_dir() -> Path:
    """Resolve the user-facing archive folder.

    Order:
      1. NEXUS_ARCHIVE_DIR  - escape hatch for tests / CI
      2. ~/Documents/Nexus Archive  - matches the Settings · Data label
      3. ~/.nexus_server/archive   - fallback if Documents/ is unwritable
    """
    cand = [
        os.environ.get("NEXUS_ARCHIVE_DIR"),
        os.path.expanduser("~/Documents/Nexus Archive"),
        os.path.expanduser("~/.nexus_server/archive"),
    ]
    for c in cand:
        if not c:
            continue
        try:
            os.makedirs(c, exist_ok=True)
            # Touch-probe; some macOS Documents/ mounts lie about W_OK.
            probe = os.path.join(c, ".nexus_archive_probe")
            with open(probe, "a"):
                pass
            os.remove(probe)
            return Path(c)
        except OSError:
            continue
    # Last resort — current working directory.
    p = Path.cwd() / "nexus-archive"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _row_counts(db_path: Path) -> dict[str, int]:
    """Best-effort row counts per table for the manifest. Empty dict on
    error — the export still succeeds, we just don't get a nice toast."""
    import sqlite3
    try:
        uri = f"file:{db_path}?mode=ro"
        with sqlite3.connect(uri, uri=True) as cx:
            tables = [
                r[0] for r in cx.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            ]
            out: dict[str, int] = {}
            for t in tables:
                try:
                    out[t] = cx.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                except sqlite3.Error:
                    out[t] = -1
            return out
    except sqlite3.Error:
        return {}


# ─────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────


class ArchivePathResponse(BaseModel):
    path: str


class ExportBundleResponse(BaseModel):
    bundle_path: str
    bytes: int
    counts: dict[str, int]
    created_at: int


# ─────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────


@router.get("/archive_path", response_model=ArchivePathResponse)
async def archive_path(_: str = Depends(get_current_user)):
    """Return the resolved on-disk path of the user's archive folder.
    The desktop opens this via Tauri's shell-open."""
    return ArchivePathResponse(path=str(_archive_dir()))


@router.post("/bundle", response_model=ExportBundleResponse)
async def export_bundle(user_id: str = Depends(get_current_user)):
    """Build a self-contained zip with the user's twin EventLog +
    manifest. Idempotent — each call writes a fresh timestamped file."""
    src_db = _db_path(user_id)
    if not src_db.exists():
        raise HTTPException(
            status_code=404,
            detail=f"twin_event_log not found at {src_db} — nothing to export yet",
        )

    archive_dir = _archive_dir()
    now = int(time.time())
    bundle_name = f"Nexus-export-{user_id[:8]}-{now}.zip"
    bundle_path = archive_dir / bundle_name

    counts = _row_counts(src_db)

    manifest = {
        "user_id": user_id,
        "created_at": now,
        "schema_version": "m3",
        "source_db_path": str(src_db),
        "counts": counts,
        "note": (
            "twin_event_log is the canonical, append-only source. Every "
            "projection (clinical_graph_*, cached_views, etc.) is derived "
            "and rebuildable by replay. FHIR R5 + SQL dump derivatives "
            "land in M3.3 finalize."
        ),
    }

    readme = (
        "Nexus export bundle\n"
        "===================\n\n"
        "Contents:\n"
        "  manifest.json       — schema + row counts + provenance\n"
        "  twin_event_log.db   — copy of the user's append-only EventLog\n\n"
        "Restore: open Settings · Data → Restore → "
        "Import from archive bundle… in any Nexus install.\n"
    )

    try:
        with zipfile.ZipFile(bundle_path, "w", zipfile.ZIP_DEFLATED) as z:
            # Write the EventLog as a streaming copy — large DBs benefit
            # from zip's deflate, and we don't load the whole file into
            # memory.
            z.write(src_db, arcname="twin_event_log.db")
            z.writestr("manifest.json", json.dumps(manifest, indent=2))
            z.writestr("README.txt", readme)
    except (OSError, zipfile.BadZipFile) as exc:
        # Try not to leave a half-written zip on disk.
        try:
            if bundle_path.exists():
                bundle_path.unlink()
        except OSError as e:
            logger.debug("removing partial bundle failed: %s", e)
        logger.exception("export bundle failed")
        raise HTTPException(status_code=500, detail=f"export failed: {exc}") from exc

    size = bundle_path.stat().st_size
    logger.info(
        "export bundle written: %s (%.1f KB, %d tables)",
        bundle_path, size / 1024, len(counts),
    )
    return ExportBundleResponse(
        bundle_path=str(bundle_path),
        bytes=size,
        counts=counts,
        created_at=now,
    )
