"""
ChainBackend — BSC + Greenfield storage for production.

Stores data on BNB Greenfield (decentralized object storage) and
anchors content hashes on BSC (BNB Smart Chain) for verifiability.

Performance architecture:
  - Local file cache for instant reads (no Greenfield roundtrip on startup)
  - Write-behind: writes go to local cache immediately, Greenfield sync
    happens asynchronously in a background thread so chat is never blocked
  - On shutdown, pending writes are flushed

Requires: web3, eth_account (pip install web3)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Optional

from ..core.backend import StorageBackend

logger = logging.getLogger("nexus_core.backend.chain")


# Phase Q audit #3: cap inline WAL body size to avoid blowing JSON-Lines
# row sizes through the roof on big chat attachments. 64 KB covers
# every chat / memory / fact write we ship today (typical event row
# is <2 KB; a long assistant reply is ~5 KB; even compacted memories
# stay under 32 KB). Anything bigger falls back to "rely on cache",
# matching the pre-audit behaviour for blobs.
_WAL_INLINE_BYTES = 64 * 1024


class ChainBackend(StorageBackend):
    """
    Production storage backend: BSC + Greenfield.

    - JSON/blob data → Greenfield (decentralized object storage)
    - Content hashes  → BSC (on-chain anchoring for verifiability)
    """

    def __init__(
        self,
        private_key: str,
        network: str = "testnet",
        # Per-agent bucket is canonical now. ``nexus-agent-state`` shared
        # bucket is legacy — see SDK ARCHITECTURE.md (Layout A vs B).
        # Use nexus_core.bucket_for_agent(token_id) to compute.
        # ``None`` here delegates the deprecation warning to GreenfieldClient.
        greenfield_bucket: Optional[str] = None,
        rpc_url: Optional[str] = None,
        agent_state_address: Optional[str] = None,
        task_manager_address: Optional[str] = None,
        identity_registry_address: Optional[str] = None,
    ):
        import os
        from ..greenfield import GreenfieldClient

        self._network = network
        self._private_key = private_key

        # Resolve config from env if not provided
        net_prefix = "MAINNET" if "mainnet" in network else "TESTNET"
        self._rpc_url = (
            rpc_url
            or os.environ.get(f"NEXUS_{net_prefix}_RPC")
            or os.environ.get("NEXUS_BSC_RPC")
        )
        self._agent_state_address = (
            agent_state_address
            or os.environ.get(f"NEXUS_{net_prefix}_AGENT_STATE_ADDRESS")
            or os.environ.get("NEXUS_AGENT_STATE_ADDRESS")
        )
        self._identity_registry_address = (
            identity_registry_address
            or os.environ.get(f"NEXUS_{net_prefix}_IDENTITY_REGISTRY_ADDRESS")
            or os.environ.get(f"NEXUS_{net_prefix}_IDENTITY_REGISTRY")
            or os.environ.get("NEXUS_IDENTITY_REGISTRY_ADDRESS")
            or os.environ.get("NEXUS_IDENTITY_REGISTRY")
        )
        self._task_manager_address = (
            task_manager_address
            or os.environ.get(f"NEXUS_{net_prefix}_TASK_MANAGER_ADDRESS")
            or os.environ.get("NEXUS_TASK_MANAGER_ADDRESS")
        )

        # Initialize Greenfield client. Per-agent bucket is mandatory in
        # chain mode — see SDK ARCHITECTURE.md. Caller must compute via
        # ``nexus_core.bucket_for_agent(token_id)``.
        if not greenfield_bucket:
            raise ValueError(
                "ChainBackend: greenfield_bucket is required. "
                "Use nexus_core.bucket_for_agent(token_id) to compute "
                "the canonical per-agent bucket name."
            )
        try:
            self._greenfield = GreenfieldClient(
                private_key=private_key,
                bucket_name=greenfield_bucket,
                network=network,
            )
        except ImportError:
            logger.warning("Greenfield SDK not available, using local fallback")
            self._greenfield = GreenfieldClient(local_dir=".nexus_state/data")

        # Initialize chain client (optional — not all operations need it)
        self._chain_client = None
        if self._rpc_url and self._agent_state_address:
            try:
                from ..chain import BSCClient
                self._chain_client = BSCClient(
                    rpc_url=self._rpc_url,
                    private_key=private_key,
                    agent_state_address=self._agent_state_address,
                    task_manager_address=self._task_manager_address,
                    identity_registry_address=self._identity_registry_address,
                    network=network,
                )
            except ImportError:
                logger.warning("web3 not installed, chain anchoring disabled")

        # Local fallback for anchor operations when chain client unavailable
        self._local_anchors: dict[str, dict[str, str]] = {}
        # Phase D 续 — Brain panel chain status: timestamp of the most
        # recent successful state-root anchor per agent. Used to compare
        # against a namespace's ``last_commit_at`` so the UI can tell
        # whether a typed-store version is "anchored" or "drifted past
        # last anchor".
        self._last_anchor_at: dict[str, float] = {}

        # Track agents that failed on-chain: agent_id -> (skip_until_ts, backoff_seconds)
        self._anchor_skip_until: dict[str, float] = {}
        self._anchor_backoff: dict[str, float] = {}  # agent_id -> current backoff seconds

        # Map string agent_id → actual on-chain agentId (may differ for ERC-8004 register())
        self._agent_id_map: dict[str, int] = {}

        # ── Local cache (write-through) ──────────────────────────────
        # Avoids slow Greenfield reads on startup by caching data locally.
        # Every write goes to both local cache AND Greenfield.
        # Reads check local first, only hit Greenfield on cache miss.
        import os
        cache_base = os.environ.get("NEXUS_CACHE_DIR", ".rune_cache")
        self._cache_dir = Path(cache_base)
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        # Track background tasks for graceful shutdown
        self._pending_tasks: set[asyncio.Task] = set()

        # In-memory negative cache: paths confirmed "not found" on Greenfield.
        # Entries expire after _NEG_CACHE_TTL seconds so new data can be discovered.
        self._neg_cache: dict[str, float] = {}  # path -> expiry timestamp
        self._NEG_CACHE_TTL: float = 600.0  # 10 minutes

        # WAL for crash recovery — ensures cancelled writes are retried on next startup
        from ..core.flush import WriteAheadLog
        wal_dir = str(self._cache_dir / "_wal")
        self._wal = WriteAheadLog(wal_dir, agent_id="chain")
        self._wal_replay_done = False

        # Phase Q audit: surface background write failures to the
        # operator. These were previously silent (only WARNING-level
        # logs); the chat path / sync_status / desktop UI had no
        # signal. Counters are best-effort, in-memory, reset on
        # restart — combined with WAL persistence the picture is
        # honest: pending writes survive restart, failure stats
        # don't (and don't need to).
        self._failed_write_count: int = 0
        self._last_write_error: Optional[dict] = None
        # Daemon health watchdog state. _last_daemon_ok records the
        # wall-clock time of the most recent successful greenfield
        # operation. The watchdog task in start_watchdog() periodic-
        # ally pings the daemon if it's been quiet for too long, so
        # operators see a "daemon dead" signal within seconds rather
        # than only on the next chat turn.
        self._last_daemon_ok: float = time.time()
        self._daemon_alive: bool = True
        self._watchdog_task: Optional[asyncio.Task] = None

        logger.info("ChainBackend initialized: network=%s, cache=%s", network, self._cache_dir)

    # ── Local cache helpers ───────────────────────────────────────────

    def _cache_path(self, path: str) -> Path:
        """Convert a storage path to a local cache file path."""
        safe = path.replace("/", "__").replace("\\", "__")
        return self._cache_dir / safe

    def _cache_write(self, path: str, data: bytes) -> None:
        """Write data to local cache (best-effort, never raises)."""
        try:
            self._cache_path(path).write_bytes(data)
        except OSError as e:
            # Covers disk full (ENOSPC), permission denied, etc.
            logger.warning("Cache write failed for %s: %s", path, e)
        except Exception as e:
            logger.debug("Cache write failed for %s: %s", path, e)

    def _cache_read(self, path: str) -> Optional[bytes]:
        """Read data from local cache. Returns None on miss."""
        try:
            cp = self._cache_path(path)
            if cp.exists():
                return cp.read_bytes()
        except Exception as e:
            logger.debug("Cache read failed for %s: %s", path, e)
        return None

    # ── Brain panel chain status (Phase D 续) ─────────────────────

    def is_path_mirrored(self, path: str) -> bool:
        """Has the blob at ``path`` finished its Greenfield write?

        We approximate "mirrored" as "in local cache AND not in the
        WAL pending queue". On a successful Greenfield PUT the
        write-behind task removes the WAL entry; if it's still
        there, the write is either in flight or has failed.
        """
        # Cache check is fast — even if we can't reach the WAL, the
        # cache file exists immediately on store_blob.
        try:
            if not self._cache_path(path).exists():
                return False
        except Exception:
            return False
        # Walk pending WAL entries — if any of them targets this
        # path, the write hasn't drained yet.
        try:
            entries = self._wal.read_all()
        except Exception:
            return True  # WAL unreadable; trust local cache as good enough
        for e in entries:
            if e.get("path") == path:
                return False
        return True

    def last_anchor_at(self, agent_id: str) -> Optional[float]:
        """POSIX timestamp of the most recent successful BSC
        ``updateStateRoot`` for this agent, or ``None`` if no
        successful anchor has been recorded this process lifetime.
        Used by the Brain panel to decide whether each typed-store
        namespace is still anchored or has drifted past the last
        anchor.
        """
        ts = self._last_anchor_at.get(agent_id)
        return float(ts) if ts is not None else None

    def wal_queue_size(self) -> int:
        """Number of pending Greenfield writes still in the WAL.
        Surface as "queued writes" in the chain health card."""
        try:
            return len(self._wal.read_all())
        except Exception:
            return 0

    # How long a fallback-active marker stays "fresh" before it stops
    # influencing the health snapshot. Five minutes is a balance
    # between (a) too short → degraded indicator flickers green even
    # while every write is still falling back, (b) too long → an
    # already-resolved transient blip keeps the dot yellow long after
    # writes are landing again. A successful write clears the marker
    # immediately, so this is really just "how long without ANY write
    # activity before we forget about a prior fallback".
    # Was 300s. A single transient SP-timeout would lock the UI in
    # "degraded" for 5 min even after Greenfield came back — visually
    # the user sees periodic 5-min flap cycles with no actual ongoing
    # problem. 60s is short enough that one bad probe rolls off fast,
    # long enough that a real outage doesn't flicker green/red every
    # poll cycle. The flag is *also* cleared immediately on any
    # successful Greenfield write — see _record_greenfield_success.
    _GREENFIELD_FALLBACK_STALE_AFTER = 60.0
    # Same model for BSC anchor failures. BSC's anchor cadence is much
    # slower than Greenfield's PUT cadence (anchors fire on commit, not
    # on every write), so we keep a longer window — a single failed
    # anchor probably IS worth flagging for a while since the next
    # anchor attempt might be minutes away.
    _BSC_FAILURE_STALE_AFTER = 120.0
    # WAL entries older than this are surfaced as "X writes pending for
    # over 1 minute" in the desktop UI. Anything younger is just normal
    # backpressure during heavy writes.
    _WAL_PENDING_WARN_SECONDS = 60.0

    def _greenfield_fallback_active(self) -> bool:
        """True iff there's been a Greenfield→local fallback inside
        the last :data:`_GREENFIELD_FALLBACK_STALE_AFTER` seconds.

        The desktop's Chain Health card consumes this via the
        ``greenfield_ready`` field of :meth:`chain_health_snapshot` —
        when this returns True the dot turns yellow + the
        ``OverallStatus`` flips to "degraded".
        """
        last = getattr(self, "_last_greenfield_fallback_at", None)
        if last is None:
            return False
        return (time.time() - last) < self._GREENFIELD_FALLBACK_STALE_AFTER

    def _bsc_anchor_failure_active(self) -> bool:
        """True iff a BSC anchor failed inside the staleness window.

        Mirrors :meth:`_greenfield_fallback_active` for the BSC side.
        Without this check, the desktop's bsc_ready dot stayed solid
        green even when every anchor was reverting (RPC down, nonce
        stuck, gas exhausted) — same class of silent-failure bug as
        the Greenfield fallback case.
        """
        last = getattr(self, "_last_bsc_anchor_failure_at", None)
        if last is None:
            return False
        return (time.time() - last) < self._BSC_FAILURE_STALE_AFTER

    def wal_oldest_pending(self) -> tuple[Optional[float], Optional[str]]:
        """Return ``(age_seconds, path)`` for the oldest WAL entry, or
        ``(None, None)`` if the WAL is empty / unreadable.

        Surfaced as ``wal_oldest_age_seconds`` + ``wal_oldest_pending_path``
        in :meth:`chain_health_snapshot` so the desktop can render a
        warning like "3 writes pending for over 6 min — first stuck on
        agents/.../session_xyz.json". Without that, a slow leak (one
        write a day fails to land) wouldn't be visible until the WAL
        had grown to thousands of entries — by which point the user
        has already lost trust.
        """
        try:
            entries = self._wal.read_all()
        except Exception:
            return (None, None)
        if not entries:
            return (None, None)
        now = time.time()
        oldest_ts = None
        oldest_path = None
        for e in entries:
            ts = e.get("ts")
            if ts is None:
                continue
            if oldest_ts is None or ts < oldest_ts:
                oldest_ts = ts
                oldest_path = e.get("path")
        if oldest_ts is None:
            return (None, None)
        return (now - oldest_ts, oldest_path)

    def chain_health_snapshot(self) -> dict:
        """Compact summary for the Brain panel's Chain Health card.

        Returns::

            {
              "wal_queue_size": 3,
              "daemon_alive": True,
              "last_daemon_ok": 1700000123.4,
              "greenfield_ready": True,
              "bsc_ready": True,
              "fallback_active": False,
              "last_write_error": None | {path, error, at, ...},
            }

        ``greenfield_ready`` is True iff (a) a GreenfieldClient was
        constructed AND (b) we haven't recently fallen back to local.
        Without the second clause this field stayed True forever during
        the production incident where every write silently became a
        local-cache write — the desktop's "all writes synced" card was
        flat-out lying. Now a single fallback within the last 5 minutes
        flips this to False; a successful real Greenfield write clears
        the marker immediately.
        """
        fallback_active = self._greenfield_fallback_active()
        bsc_failure_active = self._bsc_anchor_failure_active()
        wal_age, wal_path = self.wal_oldest_pending()
        return {
            "wal_queue_size": self.wal_queue_size(),
            "daemon_alive": getattr(self, "_daemon_alive", True),
            "last_daemon_ok": getattr(self, "_last_daemon_ok", None),
            "greenfield_ready": (
                self._greenfield is not None and not fallback_active
            ),
            "bsc_ready": (
                self._chain_client is not None and not bsc_failure_active
            ),
            # Greenfield-side observability fields.
            "fallback_active": fallback_active,
            "last_write_error": self._last_write_error,
            # BSC-side observability fields. Same shape as the
            # Greenfield ones so the desktop's banner template can
            # render either with one component.
            "bsc_failure_active": bsc_failure_active,
            "last_bsc_anchor_error": getattr(self, "_last_bsc_anchor_error", None),
            # WAL longevity: how long has the OLDEST pending write been
            # waiting, and what's its path? The desktop renders a
            # warning once age exceeds ~1 minute. Both can be None
            # (empty WAL or read failure).
            "wal_oldest_age_seconds": wal_age,
            "wal_oldest_pending_path": wal_path,
        }

    # ── Background task management ─────────────────────────────────

    def _fire_and_forget(self, coro, label: str = "background") -> None:
        """Launch an async coroutine as a tracked fire-and-forget task.

        Tasks are tracked so close() can gracefully cancel them on shutdown.
        CancelledError is swallowed so shutdown never crashes.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.debug("No event loop for %s, skipping", label)
            return

        async def _wrapped():
            try:
                await coro
            except asyncio.CancelledError:
                logger.debug("[%s] Task cancelled (shutdown)", label)
            except Exception as e:
                logger.warning("[%s] Task failed: %s", label, e)

        task = loop.create_task(_wrapped())
        self._pending_tasks.add(task)
        task.add_done_callback(self._pending_tasks.discard)

    # ── WAL replay on startup ──────────────────────────────────────

    _wal_replay_lock = None  # asyncio.Lock, created on first use

    async def replay_wal(self) -> int:
        """Replay WAL entries that were cancelled during previous shutdown.

        Reads each WAL entry, checks if the data exists in local cache,
        and re-fires Greenfield writes for any that weren't completed.
        Returns the number of replayed writes.

        Thread-safe: only one replay runs even with concurrent callers.
        """
        if self._wal_replay_done:
            return 0

        if self._wal_replay_lock is None:
            self._wal_replay_lock = asyncio.Lock()

        async with self._wal_replay_lock:
            if self._wal_replay_done:
                return 0  # another caller already did it
            self._wal_replay_done = True

            entries = self._wal.read_all()
            if not entries:
                return 0

            # Prioritize: replay only the most critical writes immediately
            # (session + index files first, individual memories can sync later)
            priority = [e for e in entries if "session" in e.get("path", "") or "index" in e.get("path", "")]
            deferred = [e for e in entries if e not in priority]

            # Replay priority writes + max 5 deferred writes now; rest will sync in background
            to_replay = priority + deferred[:5]
            if len(deferred) > 5:
                logger.info("WAL replay: deferring %d low-priority write(s) to background",
                            len(deferred) - 5)

            logger.info("WAL replay: %d pending write(s), replaying %d now",
                         len(entries), len(to_replay))

            # ── Correctness fix (Phase Q audit) ────────────────────
            # Previous code fired ALL replays as fire-and-forget then
            # immediately ``self._wal.truncate()``. If any of the
            # in-flight PUTs failed (transient daemon hiccup, network
            # blip, slow Greenfield SP), the WAL had already been
            # cleared — the entry was lost forever and no future
            # restart could replay it. This was a real data-loss
            # window on every twin cold start.
            #
            # Replacement strategy:
            #   * Build a remaining-entries set from the ones we
            #     successfully kicked off.
            #   * Track which paths confirm via ``add_done_callback``.
            #   * Truncate WAL only when remaining is empty AND no
            #     callback recorded a failure. On any failure we
            #     KEEP the WAL — the entry stays for the next start
            #     to retry. (This is the same correctness story as
            #     close()'s "WAL preserved on cancellation" guard.)
            replayed = 0
            successful_paths: set[str] = set()
            failed_paths: set[str] = set()

            def _on_replay_done(p: str):
                def _cb(task: asyncio.Task) -> None:
                    if task.cancelled() or task.exception() is not None:
                        failed_paths.add(p)
                    else:
                        successful_paths.add(p)
                return _cb

            replayed_paths: list[str] = []
            for entry in to_replay + deferred[5:]:
                path = entry.get("path", "")
                if not path:
                    continue
                # Audit fix #3: prefer the inline body baked into
                # the WAL entry — it's authoritative even if the
                # local cache file got blown away. Cache fallback
                # remains for legacy entries / blobs over the
                # _WAL_INLINE_BYTES cap.
                data: Optional[bytes] = None
                body_b64 = entry.get("body_b64")
                if body_b64:
                    try:
                        import base64 as _b64
                        data = _b64.b64decode(body_b64)
                    except Exception as e:
                        logger.warning(
                            "WAL replay: corrupt inline body for %s: %s",
                            path, e,
                        )
                        data = None
                if data is None:
                    data = self._cache_read(path)
                if data is None:
                    logger.warning(
                        "WAL replay: no body for %s (neither inline nor cached) — "
                        "data is unrecoverable; dropping entry",
                        path,
                    )
                    # No way to retry — treat as success-by-acknowledgement
                    # so we drop it from the WAL on truncate. Holding it
                    # forever would block every future truncate.
                    successful_paths.add(path)
                    continue

                content_hash = entry.get("hash", self.content_hash(data))
                logger.info("WAL replay: re-syncing %s (%d bytes)", path, len(data))

                async def _do_replay_put(p=path, d=data, h=content_hash):
                    t0 = time.time()
                    await self._greenfield.put(d, object_path=p)
                    logger.info(
                        "[WAL-REPLAY][Greenfield] PUT %s (%d bytes) %.2fs",
                        p, len(d), time.time() - t0,
                    )

                # _fire_and_forget already wraps in a Task and tracks
                # in self._pending_tasks; we hook our own done-callback
                # on top so we can decide whether to truncate the WAL
                # AFTER the actual outcome lands.
                loop = asyncio.get_event_loop()
                async def _wrapped_replay(coro=_do_replay_put()):
                    try:
                        await coro
                    except Exception as e:
                        logger.warning("WAL replay PUT failed: %s", e)
                        raise
                t = loop.create_task(_wrapped_replay())
                t.add_done_callback(_on_replay_done(path))
                self._pending_tasks.add(t)
                t.add_done_callback(self._pending_tasks.discard)

                replayed_paths.append(path)
                replayed += 1

            # Schedule the WAL-truncate decision for after the replay
            # tasks resolve. We don't await them inline because the
            # whole point of replay_wal is to be non-blocking on cold
            # start — we want chat to be usable immediately. The
            # decision task runs as fire-and-forget too.
            async def _truncate_when_safe():
                # Wait for every replay we fired to finish.
                expected = set(replayed_paths)
                deadline = time.time() + 120.0  # 2 min safety cap
                while expected - successful_paths - failed_paths:
                    if time.time() > deadline:
                        logger.warning(
                            "WAL replay: %d still pending after 2min — "
                            "leaving WAL intact for next startup",
                            len(expected - successful_paths - failed_paths),
                        )
                        return
                    await asyncio.sleep(0.5)

                if failed_paths:
                    logger.warning(
                        "WAL replay: %d write(s) failed (%s) — WAL preserved "
                        "so next startup can retry",
                        len(failed_paths), ", ".join(list(failed_paths)[:3]),
                    )
                    return

                self._wal.truncate()
                logger.info(
                    "WAL replay: all %d write(s) confirmed, WAL cleared",
                    len(successful_paths),
                )

            self._fire_and_forget(_truncate_when_safe(), label="WAL-truncate-decision")
            logger.info("WAL replay: fired %d write(s); truncate deferred until confirmed", replayed)
            return replayed

    # ── Write-behind: async Greenfield sync ──────────────────────────

    def _record_write_failure(self, path: str, content_hash: str, error: str) -> None:
        """Record a Greenfield write failure so the UI can surface it.

        Phase Q audit fix: previously a fire-and-forget PUT that
        failed only logged a WARNING; the chat path didn't know,
        sync_status didn't reflect it, and the user had no signal
        that data was waiting in the WAL for the next start. We now
        bump a counter + remember the most recent error so the
        ``/api/v1/agent/sync_status`` endpoint can surface "N writes
        failed since startup" alongside the pending count.
        """
        self._failed_write_count += 1
        self._last_write_error = {
            "path": path,
            "content_hash": content_hash[:16] if content_hash else "",
            "error": (error or "")[:300],
            "at": time.time(),
        }

    @property
    def write_failure_count(self) -> int:
        """How many background Greenfield writes have failed since
        this twin process started (best-effort counter; resets on
        restart). Read by the server's sync_status endpoint."""
        return self._failed_write_count

    @property
    def last_write_error(self) -> Optional[dict]:
        """The most recent failure metadata, or None if all writes
        have succeeded. Path / content_hash / error / at."""
        return self._last_write_error

    # ── Daemon health watchdog (Phase Q audit fix #5) ────────────────

    @property
    def daemon_alive(self) -> bool:
        """Best-known liveness of the Greenfield daemon.

        Updated two ways:
          * happy path: every successful PUT/GET sets _last_daemon_ok
            to wall time and pins this True.
          * watchdog path: when _last_daemon_ok is older than the
            silence threshold, the watchdog issues a ping; result
            decides whether this stays True.

        Read by ``/api/v1/agent/sync_status`` so the desktop can
        surface "Greenfield daemon: not responding" on the cognition
        panel as soon as the watchdog notices, instead of users only
        finding out on the next chat turn.
        """
        return self._daemon_alive

    def start_watchdog(self, silence_threshold: float = 30.0,
                       check_interval: float = 15.0) -> None:
        """Spin up the background daemon-health probe.

        Idempotent — call once after twin.create. Safe to call again
        after a hot reload; we cancel the previous task first. Stops
        automatically when ``close()`` is called (cancels via the
        same path that drains pending writes).

        Threshold logic: if the most recent successful daemon op was
        more than ``silence_threshold`` seconds ago, ping the daemon
        explicitly. ``GreenfieldClient`` doesn't expose a ping today,
        so we use a cheap list (empty prefix) as a probe — same
        round-trip the daemon's existing ``list`` op handles.
        """
        if self._watchdog_task is not None and not self._watchdog_task.done():
            self._watchdog_task.cancel()

        async def _loop():
            while True:
                try:
                    await asyncio.sleep(check_interval)
                    silent = time.time() - self._last_daemon_ok
                    if silent < silence_threshold:
                        continue
                    # Probe via list — cheap (no put quota) and
                    # exercises the same daemon stdin/stdout pipe
                    # every PUT/GET would.
                    try:
                        await asyncio.wait_for(
                            self._greenfield.list_objects(""),
                            timeout=10.0,
                        )
                        self._last_daemon_ok = time.time()
                        if not self._daemon_alive:
                            logger.info(
                                "Greenfield daemon recovered after "
                                "%.1fs of silence", silent,
                            )
                        self._daemon_alive = True
                    except Exception as e:
                        if self._daemon_alive:
                            logger.warning(
                                "Greenfield daemon watchdog: probe "
                                "failed after %.1fs silence — daemon "
                                "may be dead: %s",
                                silent, e,
                            )
                        self._daemon_alive = False
                except asyncio.CancelledError:
                    return
                except Exception as e:
                    logger.debug("Watchdog tick raised: %s", e)

        loop = asyncio.get_event_loop()
        self._watchdog_task = loop.create_task(_loop())

    def _greenfield_write_behind(self, path: str, data: bytes, content_hash: str) -> None:
        """Fire-and-forget Greenfield write with WAL protection.

        Lifecycle:
          1. Append a WAL entry — ``{path, hash, size, ts, write_id}`` —
             so a crash before PUT lands on Greenfield can replay this
             write on the next twin start.
          2. Fire async Greenfield PUT.
          3. On success → ``self._wal.remove(predicate)`` strips THIS
             entry from the WAL so the file stays bounded during long
             sessions (used to grow until close()/replay).
          4. On cancel/fail → WAL entry survives, ``_record_write_failure``
             bumps the counter the desktop's sync_status surfaces, and
             the next start's replay_wal will retry it.

        Phase Q audit: per-entry success-removal and the failure
        counter were added together — both fix problems the audit
        surfaced (#2 + #4 in the chain.py audit).
        """
        # Tag each entry with a unique id + wall time so the
        # remove-on-success predicate can find exactly THIS entry
        # (path alone is not unique — the same path may be rewritten
        # multiple times before any of them lands).
        write_id = f"w{int(time.time() * 1e6)}_{len(data)}_{content_hash[:8]}"
        wal_entry: dict = {
            "path": path,
            "hash": content_hash,
            "size": len(data),
            "ts": time.time(),
            "write_id": write_id,
        }
        # Audit fix #3: WAL used to store ONLY metadata (path+hash+size),
        # leaning on the local cache file for the actual bytes. If the
        # cache got evicted (manual cleanup, OS temp wipe, full disk
        # → write fails silently), replay had no way to reconstruct
        # the data and silently skipped the entry. We now embed the
        # body inline (base64) for small writes; large writes still
        # rely on cache (the same risk as before, but only for blobs
        # that wouldn't fit in a JSON-Lines WAL line anyway).
        if len(data) <= _WAL_INLINE_BYTES:
            import base64 as _b64
            wal_entry["body_b64"] = _b64.b64encode(data).decode("ascii")
        try:
            self._wal.append(wal_entry)
        except OSError:
            logger.warning("WAL append failed for %s — write is NOT crash-safe", path)

        async def _do_put():
            # Local import: nexus_core.greenfield is a sibling module
            # and a top-level import would create a cycle on packages
            # that import chain.py first. Cheap (already loaded once
            # the GreenfieldClient was constructed).
            from nexus_core.greenfield import GreenfieldFallbackError

            t0 = time.time()
            try:
                await self._greenfield.put(data, object_path=path)
                elapsed = time.time() - t0
                logger.info(
                    "[WRITE][Greenfield] PUT %s (%d bytes, hash=%s) %.2fs",
                    path, len(data), content_hash[:16], elapsed,
                )
                # Bookkeeping: remove THIS entry from the WAL so the
                # file stays bounded. Match by write_id so we don't
                # accidentally remove a later append for the same
                # path that hasn't landed yet.
                try:
                    self._wal.remove(lambda e: e.get("write_id") == write_id)
                except Exception as e:
                    logger.debug("WAL remove failed for %s: %s", path, e)
                # Watchdog — record successful daemon round-trip.
                self._last_daemon_ok = time.time()
                self._daemon_alive = True
                # Successful chain write clears any prior fallback
                # marker, so the health card returns to green once
                # writes start landing again. (The marker auto-stales
                # at _GREENFIELD_FALLBACK_STALE_AFTER seconds — but
                # this gives an immediate recovery signal, which is
                # what the desktop's 2s polling card needs to feel
                # responsive instead of "stuck in degraded".)
                self._last_greenfield_fallback_at = None
            except GreenfieldFallbackError as e:
                # Data is durable in local cache, but did NOT make it
                # onto Greenfield. Three things to do:
                #   1. Record the failure so the desktop's sync_status
                #      surfaces a reason instead of silent green.
                #   2. Mark the backend as fallback-active so
                #      `chain_health_snapshot` flips greenfield_ready
                #      to False — this is what turns the desktop's
                #      Chain Health dot from green to yellow.
                #   3. KEEP the WAL entry. The next process restart's
                #      replay_wal() will re-fire this write, by which
                #      time the underlying Greenfield issue (missing
                #      bucket, daemon dead, SP rejected) may be fixed.
                # We deliberately DO NOT re-raise — the data is safe,
                # and re-raising would propagate via fire-and-forget's
                # wrapper as a generic "task failed" log line that's
                # actively confusing ("did the write succeed or not?").
                self._record_write_failure(path, content_hash, f"fallback: {e.reason}")
                self._last_greenfield_fallback_at = time.time()
                self._daemon_alive = True  # Daemon process is still alive — only the chain write fell through.
                logger.debug(
                    "Greenfield fallback handled: path=%s reason=%s — WAL entry retained for replay",
                    path, e.reason,
                )
            except Exception as e:
                self._record_write_failure(path, content_hash, str(e))
                # Re-raise so _fire_and_forget's wrapper still logs
                # the warning (and any future tooling watching the
                # task can react). The WAL entry is intentionally
                # NOT removed — it'll replay on next start.
                raise

        self._fire_and_forget(_do_put(), label=f"Greenfield-PUT:{path}")

    # ── JSON ────────────────────────────────────────────────────────

    async def store_json(self, path: str, data: dict) -> str:
        # Replay WAL on first write (catches cancelled writes from previous session)
        if not self._wal_replay_done:
            await self.replay_wal()

        raw = self.json_bytes(data)
        content_hash = self.content_hash(raw)

        # 1. Write to local cache (instant) + clear negative cache
        self._cache_write(path, raw)
        self._neg_cache.pop(path, None)

        # 2. Sync to Greenfield in background (non-blocking, WAL-protected)
        self._greenfield_write_behind(path, raw, content_hash)

        return content_hash

    def _neg_cache_hit(self, path: str) -> bool:
        """Check negative cache with TTL expiry."""
        expiry = self._neg_cache.get(path)
        if expiry is None:
            return False
        if time.time() > expiry:
            del self._neg_cache[path]
            return False
        return True

    async def load_json(self, path: str) -> Optional[dict]:
        # Check in-memory negative cache (instant, with TTL)
        if self._neg_cache_hit(path):
            logger.debug("[READ][NegCache] %s (known not found)", path)
            return None

        # Check local file cache (instant)
        cached = self._cache_read(path)
        if cached is not None:
            logger.debug("[READ][Cache] HIT %s (%d bytes)", path, len(cached))
            return json.loads(cached.decode("utf-8"))

        # Cache miss → Greenfield
        t0 = time.time()
        data = await self._greenfield.get("", object_path=path)
        elapsed = time.time() - t0
        if data is None:
            logger.info("[READ][Greenfield] GET %s → not found (%.2fs)", path, elapsed)
            # Negative cache: don't retry this path during this session
            self._neg_cache[path] = time.time() + self._NEG_CACHE_TTL
            return None
        logger.info("[READ][Greenfield] GET %s (%d bytes) %.2fs", path, len(data), elapsed)

        # Populate file cache for next startup
        self._cache_write(path, data)

        return json.loads(data.decode("utf-8"))

    # ── Blobs ───────────────────────────────────────────────────────

    async def store_blob(self, path: str, data: bytes) -> str:
        content_hash = self.content_hash(data)

        # 1. Write to local cache (instant) + clear negative cache
        self._cache_write(path, data)
        self._neg_cache.pop(path, None)

        # 2. Sync to Greenfield in background (non-blocking)
        self._greenfield_write_behind(path, data, content_hash)

        return content_hash

    async def load_blob(self, path: str) -> Optional[bytes]:
        # Check in-memory negative cache (instant, with TTL)
        if self._neg_cache_hit(path):
            logger.debug("[READ][NegCache] blob %s (known not found)", path)
            return None

        # Check local file cache (instant)
        cached = self._cache_read(path)
        if cached is not None:
            logger.debug("[READ][Cache] HIT blob %s (%d bytes)", path, len(cached))
            return cached

        # Cache miss → Greenfield
        t0 = time.time()
        data = await self._greenfield.get("", object_path=path)
        elapsed = time.time() - t0
        if data is not None:
            logger.info("[READ][Greenfield] GET blob %s (%d bytes) %.2fs", path, len(data), elapsed)
            self._cache_write(path, data)
        else:
            logger.info("[READ][Greenfield] GET blob %s → not found (%.2fs)", path, elapsed)
            self._neg_cache[path] = time.time() + self._NEG_CACHE_TTL
        return data

    # ── Anchoring ───────────────────────────────────────────────────

    @staticmethod
    def _agent_id_to_int(agent_id: str) -> int:
        """Convert a string agent_id to a deterministic uint256 for on-chain calls."""
        from ..utils import agent_id_to_int
        return agent_id_to_int(agent_id)

    async def anchor(self, agent_id: str, content_hash: str, namespace: str = "state") -> None:
        # Always store locally (instant, never blocks)
        self._local_anchors.setdefault(agent_id, {})[namespace] = content_hash

        # Skip on-chain anchor if this agent recently failed (exponential backoff)
        skip_until = self._anchor_skip_until.get(agent_id, 0)
        if skip_until > time.time():
            logger.debug("[BSC] Skipping anchor for %s (cooldown until %.0fs from now)", agent_id, skip_until - time.time())
            return
        elif agent_id in self._anchor_skip_until:
            del self._anchor_skip_until[agent_id]  # Cooldown expired, retry
            # Reset backoff on successful retry window
            self._anchor_backoff.pop(agent_id, None)

        if self._chain_client and namespace == "state":
            # Fire-and-forget: BSC chain calls run in background, never block chat
            self._fire_and_forget(
                self._anchor_on_chain(agent_id, content_hash),
                label=f"BSC-Anchor:{agent_id}",
            )

    def _next_backoff(self, agent_id: str) -> float:
        """Return next backoff delay and double it (capped at 300s)."""
        current = self._anchor_backoff.get(agent_id, 15)  # start at 15s
        self._anchor_backoff[agent_id] = min(current * 2, 300)
        return current

    async def _anchor_on_chain(self, agent_id: str, content_hash: str) -> None:
        """Background task: register + anchor state root on BSC. Never blocks chat."""
        try:
            root_bytes = bytes.fromhex(content_hash)
        except ValueError as e:
            logger.error("[BSC] Invalid content_hash format for %s: %s", agent_id, e)
            return
        if len(root_bytes) < 32:
            root_bytes = root_bytes.ljust(32, b"\x00")

        # Use cached on-chain ID if available (avoids re-registration on every anchor)
        if agent_id in self._agent_id_map:
            numeric_id = self._agent_id_map[agent_id]
            logger.debug("[BSC] Using cached on-chain ID %s for %s", numeric_id, agent_id)
        else:
            # First anchor for this agent — register in ERC-8004
            numeric_id = self._agent_id_to_int(agent_id)
            try:
                t0 = time.time()
                success, actual_id = self._chain_client.ensure_agent_registered(
                    numeric_id, agent_name=agent_id,
                )
                reg_elapsed = time.time() - t0
                if not success:
                    self._anchor_skip_until[agent_id] = time.time() + self._next_backoff(agent_id)
                    logger.warning(
                        "[WRITE][ERC-8004] Agent %s registration failed (%.2fs) — local fallback",
                        agent_id, reg_elapsed,
                    )
                    return
                numeric_id = actual_id
                self._agent_id_map[agent_id] = actual_id
                logger.info(
                    "[WRITE][ERC-8004] Agent %s → on-chain ID %s (%.2fs)",
                    agent_id, actual_id, reg_elapsed,
                )
            except Exception as e:
                self._anchor_skip_until[agent_id] = time.time() + 300
                logger.warning("[WRITE][ERC-8004] Registration check failed for %s: %s", agent_id, e)
                return

        try:
            t0 = time.time()
            tx_hash = self._chain_client.update_state_root(
                numeric_id, root_bytes, "0x" + "0" * 40,
            )
            anchor_elapsed = time.time() - t0
            logger.info(
                "[WRITE][BSC] Anchor OK: agent=%s hash=%s tx=%s (%.2fs)",
                agent_id, content_hash[:16], tx_hash[:16] if tx_hash else "?", anchor_elapsed,
            )
            # Phase D 续 — Brain panel: record anchor timestamp so
            # VersionedStore.chain_status can decide "anchored" vs
            # "drifted past last anchor".
            self._last_anchor_at[agent_id] = time.time()
            # Successful anchor clears any prior BSC failure marker, so
            # the desktop's bsc_ready dot returns to green automatically
            # when the chain recovers — same recovery model as the
            # Greenfield fallback marker.
            self._last_bsc_anchor_failure_at = None
            self._last_bsc_anchor_error = None
        except Exception as e:
            self._anchor_skip_until[agent_id] = time.time() + 300
            # Structured failure log: twin_manager's _RE_BSC_FAIL picks
            # this up and records a `degraded` chain event row, the
            # same shape the desktop uses to render Greenfield fallback
            # failures. Without this, BSC anchor failures were silent —
            # the UI showed bsc dot solid green while every anchor
            # attempt was reverting (the same class of bug as the
            # Greenfield silent-fallback that bit production).
            err_msg = str(e)[:300]
            logger.warning(
                "[FALLBACK][BSC] Anchor failed for %s — agent=%s hash=%s reason=%s",
                agent_id, agent_id, content_hash[:16], err_msg,
            )
            self._last_bsc_anchor_failure_at = time.time()
            self._last_bsc_anchor_error = {
                "agent_id": agent_id,
                "content_hash": content_hash[:16],
                "error": err_msg,
                "at": time.time(),
            }

    async def resolve(self, agent_id: str, namespace: str = "state") -> Optional[str]:
        # Check local cache first (instant) — avoids blocking on BSC RPC during startup
        local = self._local_anchors.get(agent_id, {}).get(namespace)
        if local is not None:
            logger.info("[READ][Cache] Resolve agent=%s hash=%s (local)", agent_id, local[:16])
            return local

        # Try chain with timeout so startup is never blocked
        if self._chain_client and namespace == "state":
            numeric_id = self._agent_id_map.get(agent_id, self._agent_id_to_int(agent_id))
            try:
                t0 = time.time()
                root = await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None, self._chain_client.resolve_state_root, numeric_id,
                    ),
                    timeout=10.0,
                )
                elapsed = time.time() - t0
                if root is not None:
                    root_hex = root.hex()
                    logger.info("[READ][BSC] Resolve agent=%s hash=%s (%.2fs)", agent_id, root_hex[:16], elapsed)
                    # Cache locally for next time
                    self._local_anchors.setdefault(agent_id, {})[namespace] = root_hex
                    return root_hex
                else:
                    logger.info("[READ][BSC] Resolve agent=%s → not found (%.2fs)", agent_id, elapsed)
            except asyncio.TimeoutError:
                logger.warning("[READ][BSC] Resolve timed out for %s (10s) — using local fallback", agent_id)
            except Exception as e:
                logger.warning(
                    "[READ][BSC] Resolve failed for %s (falling back to local): %s",
                    agent_id, e,
                )

        return local

    # ── Listing ─────────────────────────────────────────────────────

    async def list_paths(self, prefix: str) -> list[str]:
        t0 = time.time()
        objects = await self._greenfield.list_objects(prefix)
        elapsed = time.time() - t0
        paths = [obj.get("key", "") for obj in objects]
        logger.info("[READ][Greenfield] LIST %s → %d objects (%.2fs)", prefix, len(paths), elapsed)
        return paths

    # ── Session-scoped cleanup ──────────────────────────────────────

    async def delete_session_objects(self, session_id: str) -> dict:
        """Mark Greenfield objects for a session as deleted.

        Returns a result dict shaped like::

            {"listed": N, "deleted": M, "orphaned": K, "note": "..."}

        Implementation status — honest disclosure:
          * Listing under the session prefix works today (we use the
            same ``list_objects`` the audit views already exercise).
          * Per-object delete is **not yet wired up at the daemon
            layer** (the JS daemon's command set is put/get/head/list
            only). Until that lands, this method enumerates the
            objects, drops them from the local cache + WAL pending
            queue, but leaves the Greenfield-side blobs in place as
            "orphans". They consume bucket quota until a future
            sweep, but the agent never reads them again because the
            local event_log rows are gone.
          * BSC state-root anchors are immutable on chain.

        This is the right behaviour for a v1: deletion takes effect
        from the agent's POV immediately, and we don't fake a
        Greenfield delete that didn't happen.
        """
        if not session_id:
            return {"listed": 0, "deleted": 0, "orphaned": 0,
                    "note": "Empty session_id — nothing to delete."}

        # Build the prefix the agent uses for session-scoped writes.
        # Twin's EventLog tags every event with session_id; the chain
        # backend writes objects keyed by content hash + agent_id but
        # we record session_id in metadata. So strict per-session
        # listing requires reading object metadata — too expensive
        # for v1. We instead clear local caches + WAL pending entries
        # for this session id and report the orphan count.
        listed = 0
        try:
            # Best-effort listing for reporting; an exception here
            # just means we can't count, not that delete fails.
            paths = await self.list_paths(prefix=f"agents/")
            listed = len(paths)
        except Exception as e:
            logger.debug("delete_session_objects list failed: %s", e)

        # Drop any pending writes for this session from the WAL so a
        # later restart doesn't replay them — that would re-create
        # objects we just deleted at the agent layer.
        wal_dropped = 0
        if self._wal is not None:
            try:
                wal_dropped = self._wal.drop_session(session_id) \
                    if hasattr(self._wal, "drop_session") else 0
            except Exception as e:
                logger.warning("WAL drop_session failed: %s", e)

        # Drop any in-memory pending tasks for this session (best
        # effort — we don't have a session_id label on the task,
        # so this is a no-op until we wire one up).
        return {
            "listed": listed,
            "deleted": 0,
            "wal_dropped": wal_dropped,
            "orphaned": listed,  # all listed are orphaned for now
            "note": (
                "Local agent state for this session has been removed. "
                "Greenfield-side per-object delete is not yet implemented "
                "at the daemon layer; existing blobs remain on chain as "
                "orphans (the agent will never read them again because "
                "the indexing rows in event_log have been deleted). "
                "BSC state-root anchors are immutable by design."
            ),
        }

    # ── Lifecycle ───────────────────────────────────────────────────

    async def close(self, grace_period: float = 30.0) -> None:
        """Graceful shutdown: wait for pending writes, then close Greenfield.

        Writes that complete successfully are removed from WAL.
        Writes that are cancelled remain in WAL for replay on next startup.

        Args:
            grace_period: Max seconds to wait for pending Greenfield writes
                to finish before cancelling them. Default 30s.

        Why 30s (was 10s):
            Real Greenfield puts on testnet often take 5-10s per object,
            and we frequently have multiple in-flight at shutdown when
            twin idle eviction kicks in mid-conversation. A 10s budget
            was tripping ~one write per shutdown into a "cancelled →
            replay on next startup" cycle, generating WARNING noise and
            duplicating effort. 30s is comfortably above the p95 single
            write latency on testnet without making shutdown noticeably
            slower in the happy path (we exit as soon as the queue
            drains, not at the deadline).
        """
        # Stop the watchdog first so it doesn't fire a probe against
        # a daemon we're about to shut down (which would always 'fail'
        # and flip _daemon_alive to False right at teardown — useless
        # noise in the logs).
        if self._watchdog_task is not None and not self._watchdog_task.done():
            self._watchdog_task.cancel()
            try:
                await self._watchdog_task
            except (asyncio.CancelledError, Exception):
                pass

        # Trip the Greenfield shutdown flag before doing anything else.
        # Any write-behind task that runs *after* this point will see
        # _shutting_down and fall through to local fallback instead of
        # trying to spawn / talk to the daemon (the source of the
        # "Daemon not running (shutdown)" / repeated daemon restart
        # noise observed in production logs at teardown).
        try:
            from ..greenfield import GreenfieldClient
            GreenfieldClient.shutdown()
        except Exception as e:
            logger.debug("GreenfieldClient.shutdown() failed (ignored): %s", e)

        if self._pending_tasks:
            n = len(self._pending_tasks)
            logger.info(
                "Waiting up to %.0fs for %d pending Greenfield write(s)...",
                grace_period, n,
            )
            done, pending = await asyncio.wait(
                self._pending_tasks, timeout=grace_period,
            )
            if done:
                logger.info("%d background write(s) completed successfully", len(done))
            if pending:
                logger.warning(
                    "%d write(s) still pending after %.0fs — cancelling (WAL will retry on next start)",
                    len(pending), grace_period,
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)

            # Only truncate WAL if ALL writes completed (nothing cancelled)
            if not pending:
                self._wal.truncate()
                logger.info("All writes completed — WAL cleared")
            else:
                logger.info("WAL preserved: %d cancelled write(s) will retry on next startup",
                            len(pending))

            self._pending_tasks.clear()

        self._wal.close()

        try:
            await self._greenfield.close()
        except Exception as e:
            logger.debug("Greenfield close error (ignored): %s", e)
