"""Tier 1 cached views (ADR-002 Rev-4 / design v3 §5.4 §6).

Pre-materialised per-patient summaries that the agent's Tier-1 retrieval
hits directly from SQL (≤ 50ms target). Regenerated on graph mutations
touching the view's covered entities; invalidated incrementally.

Each view kind has a deterministic recipe over the Layer-1 graph
projection. Recipes are pure Python over SQL — no LLM, no network.
Same input graph → identical output markdown.

View kinds shipped in this module
=================================

* ``patient_summary``        — 3-paragraph overview
* ``active_findings``        — bullet list of non-retracted findings
* ``current_medications``    — non-discontinued meds
* ``imaging_chronology``     — studies sorted by date
* ``lab_trends_30d``         — recent labs (placeholder; full recharts in M5)
* ``daily_briefing``         — per-medic, cross-patient (run separately)

Adding a view kind: register a recipe in ``RECIPES``. The builder picks
it up automatically. Recipes get a connection + user/patient context and
return a tuple ``(markdown, sources_node_ids)``.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from typing import Callable, Optional

logger = logging.getLogger(__name__)


Recipe = Callable[[sqlite3.Connection, str, str], tuple[str, list[int]]]


def _query_active(
    conn: sqlite3.Connection, user_id: str, patient_hash: str, node_type: str,
    limit: int = 20,
) -> list[tuple[int, dict]]:
    rows = conn.execute(
        "SELECT n.node_id, n.content_json FROM clinical_graph_nodes n "
        "LEFT JOIN node_provenance p "
        "  ON p.user_id = n.user_id AND p.patient_hash = n.patient_hash "
        "   AND p.node_id = n.node_id "
        "WHERE n.user_id = ? AND n.patient_hash = ? AND n.node_type = ? "
        "  AND (p.retracted_at IS NULL) "
        "ORDER BY n.weight DESC, n.updated_at DESC LIMIT ?",
        (user_id, patient_hash, node_type, limit),
    ).fetchall()
    return [(r[0], json.loads(r[1])) for r in rows]


# ─────────────────────────────────────────────────────────────────────
# Recipes
# ─────────────────────────────────────────────────────────────────────

def _recipe_patient_summary(
    conn: sqlite3.Connection, user_id: str, patient_hash: str,
) -> tuple[str, list[int]]:
    findings = _query_active(conn, user_id, patient_hash, "finding", 10)
    meds = _query_active(conn, user_id, patient_hash, "med", 20)
    studies = _query_active(conn, user_id, patient_hash, "study", 5)

    lines = []
    if not (findings or meds or studies):
        lines.append("No records yet for this patient.")
    else:
        if findings:
            f_strs = []
            for nid, c in findings[:3]:
                label = c.get("label", "(unlabeled)")
                f_strs.append(f"{label} [#{nid}]")
            lines.append(
                "Active findings: " + ", ".join(f_strs)
                + ("…" if len(findings) > 3 else "") + "."
            )
        if studies:
            recent = studies[0][1]
            mod = recent.get("modality", "?")
            date = recent.get("study_date", "?")
            lines.append(f"Most recent imaging: {mod} on {date}.")
        if meds:
            m_strs = [c.get("label", "?") for _, c in meds[:5]]
            lines.append("Current medications: " + ", ".join(m_strs) + ".")

    sources = (
        [n for n, _ in findings]
        + [n for n, _ in meds]
        + [n for n, _ in studies]
    )
    return "\n\n".join(lines), sources


def _recipe_active_findings(
    conn: sqlite3.Connection, user_id: str, patient_hash: str,
) -> tuple[str, list[int]]:
    rows = _query_active(conn, user_id, patient_hash, "finding", 50)
    if not rows:
        return "No active findings.", []
    lines = ["# Active findings\n"]
    for nid, c in rows:
        label = c.get("label", "(unlabeled)")
        size = c.get("size_cm")
        line = f"- {label}"
        if size is not None:
            line += f" — {size} cm"
        line += f" [node:{nid}]"
        lines.append(line)
    return "\n".join(lines), [n for n, _ in rows]


def _recipe_current_medications(
    conn: sqlite3.Connection, user_id: str, patient_hash: str,
) -> tuple[str, list[int]]:
    rows = _query_active(conn, user_id, patient_hash, "med", 50)
    if not rows:
        return "No current medications recorded.", []
    lines = ["# Medications\n"]
    for nid, c in rows:
        label = c.get("label", "(unlabeled)")
        dose = c.get("dose", "")
        line = f"- {label}"
        if dose:
            line += f" — {dose}"
        line += f" [node:{nid}]"
        lines.append(line)
    return "\n".join(lines), [n for n, _ in rows]


def _recipe_imaging_chronology(
    conn: sqlite3.Connection, user_id: str, patient_hash: str,
) -> tuple[str, list[int]]:
    rows = conn.execute(
        "SELECT node_id, content_json FROM clinical_graph_nodes "
        "WHERE user_id = ? AND patient_hash = ? AND node_type = 'study' "
        "ORDER BY updated_at DESC LIMIT 50",
        (user_id, patient_hash),
    ).fetchall()
    if not rows:
        return "No imaging studies on file.", []
    lines = ["# Imaging chronology\n"]
    ids: list[int] = []
    for nid, raw in rows:
        c = json.loads(raw)
        date = c.get("study_date", "?")
        mod = c.get("modality", "?")
        body = c.get("body_part", "")
        lines.append(f"- **{date}** · {mod} · {body} [node:{nid}]")
        ids.append(nid)
    return "\n".join(lines), ids


def _recipe_lab_trends_30d(
    conn: sqlite3.Connection, user_id: str, patient_hash: str,
) -> tuple[str, list[int]]:
    cutoff = (int(time.time()) - 30 * 86400) * 1_000_000  # microseconds
    rows = conn.execute(
        "SELECT node_id, content_json FROM clinical_graph_nodes "
        "WHERE user_id = ? AND patient_hash = ? AND node_type = 'lab' "
        "  AND updated_at > ? ORDER BY updated_at DESC LIMIT 100",
        (user_id, patient_hash, cutoff),
    ).fetchall()
    if not rows:
        return "No labs in the last 30 days.", []
    lines = ["# Lab trends (last 30d)\n"]
    ids: list[int] = []
    for nid, raw in rows:
        c = json.loads(raw)
        code = c.get("loinc") or c.get("code") or "?"
        value = c.get("value", "?")
        unit = c.get("unit", "")
        lines.append(f"- {code}: {value} {unit} [node:{nid}]")
        ids.append(nid)
    return "\n".join(lines), ids


RECIPES: dict[str, Recipe] = {
    "patient_summary":     _recipe_patient_summary,
    "active_findings":     _recipe_active_findings,
    "current_medications": _recipe_current_medications,
    "imaging_chronology":  _recipe_imaging_chronology,
    "lab_trends_30d":      _recipe_lab_trends_30d,
}


# ─────────────────────────────────────────────────────────────────────
# Builder
# ─────────────────────────────────────────────────────────────────────

def build_view(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: str,
    view_kind: str,
    ttl_seconds: int = 86400,
) -> tuple[str, list[int]]:
    """Generate one view + write it to cached_views.

    Per Rev-8, this write IS a projection write — but cached_views is
    deterministically derivable from graph state at any moment, so it's
    safe to bypass the event-sourcing ledger for view materialisation.
    (Treat cached_views as a pure cache, not a primary state surface.)
    """
    recipe = RECIPES.get(view_kind)
    if recipe is None:
        raise ValueError(f"unknown view_kind: {view_kind}")
    content_md, sources = recipe(conn, user_id, patient_hash)
    now = int(time.time())
    # NOTE: cached_views is a pure SQL cache — see module docstring. The
    # lint script whitelists this file via the regular allowed-suffix
    # path; if you move this writer, update lint_no_direct_projection_writes.
    conn.execute(
        "INSERT INTO cached_views "
        "(user_id, patient_hash, view_kind, content_md, sources_json, "
        " generated_at, stale, ttl_seconds) "
        "VALUES (?, ?, ?, ?, ?, ?, 0, ?) "
        "ON CONFLICT(user_id, patient_hash, view_kind) DO UPDATE SET "
        "  content_md = excluded.content_md, "
        "  sources_json = excluded.sources_json, "
        "  generated_at = excluded.generated_at, "
        "  stale = 0",
        (
            user_id, patient_hash, view_kind, content_md,
            json.dumps(sources), now, ttl_seconds,
        ),
    )
    conn.commit()
    return content_md, sources


def invalidate_for_patient(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: str,
    view_kinds: Optional[list[str]] = None,
) -> int:
    """Mark views stale. Returns rows affected.

    Called by ingesters after a graph mutation that may have touched
    nodes a view references. The next ``build_view`` call refreshes them."""
    kinds = view_kinds or list(RECIPES.keys())
    placeholders = ",".join("?" * len(kinds))
    cur = conn.execute(
        f"UPDATE cached_views SET stale = 1 "
        f"WHERE user_id = ? AND patient_hash = ? "
        f"  AND view_kind IN ({placeholders})",
        (user_id, patient_hash, *kinds),
    )
    conn.commit()
    return cur.rowcount


def get_view(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: str,
    view_kind: str,
    rebuild_if_stale: bool = True,
) -> Optional[tuple[str, list[int], int]]:
    """Read a view. Returns ``(content_md, sources, generated_at)`` or None.

    If ``rebuild_if_stale=True``, regenerates on the fly when the row
    is marked stale or missing.
    """
    row = conn.execute(
        "SELECT content_md, sources_json, generated_at, stale "
        "FROM cached_views "
        "WHERE user_id = ? AND patient_hash = ? AND view_kind = ?",
        (user_id, patient_hash, view_kind),
    ).fetchone()

    if row is None:
        if rebuild_if_stale:
            content, sources = build_view(
                conn, user_id=user_id, patient_hash=patient_hash,
                view_kind=view_kind,
            )
            return content, sources, int(time.time())
        return None

    content_md, sources_json, generated_at, stale = row
    if stale and rebuild_if_stale:
        content, sources = build_view(
            conn, user_id=user_id, patient_hash=patient_hash,
            view_kind=view_kind,
        )
        return content, sources, int(time.time())

    return content_md, json.loads(sources_json), generated_at
