"""D1 — Tier 2 daily snapshots (ADR-002 Rev-7).

Background task that fires once a day, takes a compressed snapshot
of the SQLite DB + content-addressed key_image dir, writes a tarball
to ``~/Documents/Nexus Archive/`` with the rolling retention policy:

  * 30 daily snapshots
  * 12 weekly  (Sundays)
  * 24 monthly (1st of each month)

Emits ``snapshot_taken`` events into event_log so replay sees the
operation history.

main.py lifespan integration::

    from nexus_server.persistence.snapshots import start_snapshot_scheduler
    start_snapshot_scheduler()
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import pathlib
import shutil
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from nexus_server.event_sourcing import EventKind, Store, init_event_sourcing_schema
from nexus_server.event_sourcing.handlers import _h_snapshot_taken

logger = logging.getLogger(__name__)

# Path conventions per nexus-architecture design v3 §16.3
DEFAULT_ARCHIVE_ROOT = pathlib.Path.home() / "Documents" / "Nexus Archive"

# Retention policy
DAILY_RETENTION = 30
WEEKLY_RETENTION = 12
MONTHLY_RETENTION = 24

# Run cadence — once per 24h, but cooperative: scheduler wakes hourly
# and decides whether to fire based on last_snapshot_at.
SCHEDULER_TICK_SECONDS = 60 * 60
SNAPSHOT_INTERVAL_SECONDS = 23 * 60 * 60  # slightly < 24h so it doesn't drift


@dataclass(frozen=True)
class SnapshotResult:
    path: pathlib.Path
    sha256: str
    size_bytes: int


def take_snapshot(
    db_path: pathlib.Path,
    *,
    archive_root: pathlib.Path = DEFAULT_ARCHIVE_ROOT,
    files_dir: Optional[pathlib.Path] = None,
) -> SnapshotResult:
    """Create one snapshot tarball.

    Includes the SQLite DB + (if present) the content-addressed key_image
    files. Returns a result descriptor.
    """
    archive_root.mkdir(parents=True, exist_ok=True)
    date = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    target = archive_root / f"snapshot-{date}.tar.zst"

    # Write a temp tar.gz (zstd would be nicer but stdlib doesn't ship
    # one without `zstandard` package — use gzip as the always-available
    # baseline; zstd is the target compression once we add the dep).
    target = target.with_suffix(".tar.gz")

    with tempfile.NamedTemporaryFile(
        delete=False, suffix=".tar.gz",
    ) as tmp:
        tmp_path = pathlib.Path(tmp.name)

    try:
        with tarfile.open(tmp_path, "w:gz", compresslevel=6) as tar:
            if db_path.exists():
                tar.add(db_path, arcname="nexus.db")
                # Also include WAL + SHM if present, for crash-safe
                # restore.
                for sidecar in (".db-wal", ".db-shm"):
                    sib = db_path.with_suffix(sidecar)
                    if sib.exists():
                        tar.add(sib, arcname=f"nexus{sidecar}")
            if files_dir and files_dir.exists():
                tar.add(files_dir, arcname="files")
        shutil.move(str(tmp_path), str(target))
    finally:
        if tmp_path.exists():
            tmp_path.unlink()

    sha = hashlib.sha256(target.read_bytes()).hexdigest()
    size = target.stat().st_size
    logger.info("snapshot written: %s (%.1f MB)", target, size / (1 << 20))
    return SnapshotResult(path=target, sha256=sha, size_bytes=size)


def apply_retention(archive_root: pathlib.Path = DEFAULT_ARCHIVE_ROOT) -> int:
    """Apply the 30/12/24 retention policy. Returns number deleted."""
    if not archive_root.exists():
        return 0

    snapshots = sorted(archive_root.glob("snapshot-*.tar.gz"))
    if len(snapshots) <= DAILY_RETENTION:
        return 0

    deleted = 0
    now = datetime.now()
    # Keep most-recent DAILY_RETENTION; for older, keep one per week
    # back to WEEKLY_RETENTION; further back keep one per month for
    # MONTHLY_RETENTION months; everything else deleted.
    keep: set[pathlib.Path] = set()

    for snap in snapshots[-DAILY_RETENTION:]:
        keep.add(snap)

    # Weekly buckets
    cutoff_weekly = now - timedelta(days=DAILY_RETENTION)
    seen_weeks: set[int] = set()
    for snap in reversed(snapshots[: -DAILY_RETENTION]):
        when = _parse_snapshot_date(snap)
        if when is None or when < cutoff_weekly - timedelta(weeks=WEEKLY_RETENTION):
            continue
        week = (when.year, when.isocalendar().week)
        if week not in seen_weeks:
            seen_weeks.add(week)
            keep.add(snap)

    # Monthly buckets
    cutoff_monthly = now - timedelta(weeks=WEEKLY_RETENTION + DAILY_RETENTION // 7)
    seen_months: set[tuple[int, int]] = set()
    for snap in reversed(snapshots[: -DAILY_RETENTION]):
        when = _parse_snapshot_date(snap)
        if when is None:
            continue
        if when < cutoff_monthly - timedelta(weeks=MONTHLY_RETENTION * 4):
            continue
        month = (when.year, when.month)
        if month not in seen_months:
            seen_months.add(month)
            keep.add(snap)

    for snap in snapshots:
        if snap not in keep:
            snap.unlink()
            deleted += 1

    if deleted:
        logger.info("retention: deleted %d old snapshots", deleted)
    return deleted


def _parse_snapshot_date(p: pathlib.Path) -> Optional[datetime]:
    """Filename → datetime, or None if unparseable."""
    try:
        # snapshot-2026-06-13-153045.tar.gz
        stem = p.name.removeprefix("snapshot-").split(".")[0]
        return datetime.strptime(stem, "%Y-%m-%d-%H%M%S")
    except (ValueError, AttributeError):
        return None


async def scheduler_loop(
    db_path: pathlib.Path,
    *,
    archive_root: pathlib.Path = DEFAULT_ARCHIVE_ROOT,
    files_dir: Optional[pathlib.Path] = None,
) -> None:
    """Long-running coroutine — wakes hourly, fires daily."""
    last_snapshot_at = 0.0
    while True:
        try:
            now = time.time()
            if now - last_snapshot_at >= SNAPSHOT_INTERVAL_SECONDS:
                result = take_snapshot(
                    db_path, archive_root=archive_root, files_dir=files_dir,
                )
                _emit_event(db_path, result)
                apply_retention(archive_root)
                last_snapshot_at = now
        except Exception:
            logger.exception("snapshot scheduler iteration failed; continuing")
        await asyncio.sleep(SCHEDULER_TICK_SECONDS)


def _emit_event(db_path: pathlib.Path, result: SnapshotResult) -> None:
    """Record the snapshot in event_log."""
    import sqlite3
    conn = sqlite3.connect(db_path)
    try:
        init_event_sourcing_schema(conn)
        store = Store(conn)
        store.emit_and_apply(
            kind=EventKind.SNAPSHOT_TAKEN,
            payload={
                "tier":          "T2",
                "location":      str(result.path),
                "sha256":        result.sha256,
                "db_size_bytes": result.size_bytes,
            },
            apply_fn=_h_snapshot_taken,
            user_id="system",
        )
    finally:
        conn.close()


def start_snapshot_scheduler(
    db_path: pathlib.Path,
    *,
    archive_root: pathlib.Path = DEFAULT_ARCHIVE_ROOT,
    files_dir: Optional[pathlib.Path] = None,
) -> asyncio.Task:
    """Spawn the scheduler as a background task on the running event loop."""
    return asyncio.create_task(
        scheduler_loop(db_path, archive_root=archive_root, files_dir=files_dir)
    )
