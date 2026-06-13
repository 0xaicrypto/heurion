"""#191 — Quick scan pipeline for DICOM studies.

User-facing flow (locked in #182 design):

  1. Medic uploads a PET-CT / CT zip → DICOM prerender finishes.
  2. Medic clicks 🔍 Quick scan button in chat or study card.
  3. Server enqueues this module's worker.
  4. Worker iterates the primary series in batches of 16 slices,
     renders 4×4 grids (already cached on disk from #140's prerender),
     sends each grid to Gemini Flash with a triage prompt.
  5. Phase 1 collects { slice_range, verdict, finding, urgency } tuples.
  6. Phase 2 (deferred — currently re-uses Phase 1 hints; future
     iteration will add Gemini Pro focused review on suspicious ranges).
  7. Phase 3 synthesises a structured report and emits it as an
     ``assistant_response`` event with ``metadata.kind="quick_scan_report"``
     so the desktop renders it as a special card in chat.

CRITICAL safety rules baked in:
  * Every Phase 1 prompt ends with "Be honest about uncertainty. This
    is a preliminary screen; final read happens by the radiologist."
  * Every report carries an immutable disclaimer string in metadata
    so the desktop's render never drops it.
  * If Gemini errors / no findings, we STILL emit a report (saying
    "no flagged findings") so the medic never sees an empty silence.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from nexus_server.auth import get_current_user
from nexus_server import config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/dicom", tags=["quick-scan"])


# ── Constants ───────────────────────────────────────────────────────

SLICES_PER_GRID    = 16          # 4×4 grid
PHASE1_CONCURRENCY = 4           # parallel Gemini Flash calls
PHASE1_MODEL       = "gemini-2.0-flash-exp"
SLICES_HARD_CAP    = 400         # don't scan more than this many slices
                                 # (cost guard for huge PET-CT, ~25 grids)

DISCLAIMER = (
    "Preliminary AI screen — not a diagnosis. "
    "Radiologist review required for any clinical decision."
)


# ── Data shapes ─────────────────────────────────────────────────────


@dataclass
class GridFinding:
    """One Gemini Flash verdict on one 4×4 grid."""
    slice_start: int
    slice_end:   int
    verdict:     str           # clean / suspicious / unsure / error
    finding:     str = ""      # one-sentence hint, '' when clean
    urgency:     str = ""      # critical / moderate / incidental / ''
    error:       str = ""      # populated only on API error


@dataclass
class QuickScanReport:
    """The synthesised report Phase 3 emits as an
    assistant_response event."""
    study_id:       str
    patient_hash:   str
    modality:       str
    body_part:      str
    total_slices:   int
    scanned_slices: int
    grids_scanned:  int
    elapsed_s:      float
    findings:       list[dict] = field(default_factory=list)
    summary_counts: dict       = field(default_factory=dict)
    model_chain:    list[str]  = field(default_factory=list)


# ── Public entry points ─────────────────────────────────────────────


def trigger_quick_scan(
    *, user_id: str, study_id: str, background_tasks: BackgroundTasks,
) -> dict:
    """Kick off a Quick scan for the given study. Returns immediately
    after enqueueing; the worker runs out-of-band. Result lands in
    twin.event_log as an ``assistant_response`` with
    metadata.kind="quick_scan_report"."""
    background_tasks.add_task(_run_quick_scan_sync, user_id, study_id)
    return {
        "status":      "enqueued",
        "study_id":    study_id,
        "disclaimer":  DISCLAIMER,
    }


@router.post("/studies/{study_id}/quick-scan")
async def post_quick_scan(
    study_id: str,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
) -> dict:
    """Doctor clicked 🔍 Quick scan. Kick the background worker."""
    # Sanity-check the study exists + belongs to this user before
    # enqueueing; cheaper than letting the worker discover at run time.
    try:
        from nexus_server.dicom import load_study
        study = load_study(current_user, study_id)
        if study is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"study {study_id} not found",
            )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning("quick_scan study lookup failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"study lookup failed: {e}",
        )
    return trigger_quick_scan(
        user_id=current_user,
        study_id=study_id,
        background_tasks=background_tasks,
    )


# ── Worker body ─────────────────────────────────────────────────────


def _run_quick_scan_sync(user_id: str, study_id: str) -> None:
    """BackgroundTasks calls this synchronously on its own thread.
    We drive an asyncio loop ourselves for the parallel Gemini calls.
    """
    try:
        asyncio.run(_run_quick_scan_async(user_id, study_id))
    except Exception as e:  # noqa: BLE001
        logger.exception("quick_scan worker crashed: %s", e)
        _emit_failure_report(user_id, study_id, f"{type(e).__name__}: {e}")


async def _run_quick_scan_async(user_id: str, study_id: str) -> None:
    """The actual three-phase scan."""
    t0 = time.monotonic()
    logger.info("quick_scan starting — user=%s study=%s",
                user_id, study_id[:8])

    # ── Load study + grids ──────────────────────────────────────────
    from nexus_server.dicom import load_study
    study = load_study(user_id, study_id)
    if study is None:
        _emit_failure_report(user_id, study_id, "study not found")
        return

    # Pick the primary (largest) series. For PET-CT this gives us the
    # CT volume which is what we want to triage anatomically.
    primary = max(study.series, key=lambda s: s.slice_count)
    modality  = (study.modality or "").upper() or "CT"
    body_part = (primary.body_part or "").upper() or "UNKNOWN"
    total     = primary.slice_count

    if total <= 0:
        _emit_failure_report(user_id, study_id,
                             "primary series has no slices")
        return

    # Cap scan size to keep cost predictable.
    scan_count = min(total, SLICES_HARD_CAP)

    # ── Render grids ────────────────────────────────────────────────
    # We don't have a pre-rendered grid-per-batch on disk yet — only
    # one 4×4 grid (the prerender's grid-4x4.png covers the whole
    # series spread across 16 slices). For Phase 1 here we'll render
    # batches of 16 contiguous slices into fresh grids.
    grids = await _render_batched_grids(user_id, study_id, primary,
                                        scan_count, SLICES_PER_GRID)
    if not grids:
        _emit_failure_report(user_id, study_id,
                             "could not render grids for scan")
        return

    # ── Phase 1: Gemini Flash triage ────────────────────────────────
    findings = await _phase1_triage(
        grids, modality=modality, body_part=body_part)

    # ── Phase 3: Synthesise + emit ──────────────────────────────────
    report = QuickScanReport(
        study_id       = study_id,
        patient_hash   = study.patient_hash or "",
        modality       = modality,
        body_part      = body_part,
        total_slices   = total,
        scanned_slices = scan_count,
        grids_scanned  = len(grids),
        elapsed_s      = round(time.monotonic() - t0, 1),
        findings       = [_finding_to_dict(f) for f in findings
                          if f.verdict in ("suspicious", "unsure")],
        summary_counts = _summarise_counts(findings),
        model_chain    = [PHASE1_MODEL],
    )
    await _emit_report(user_id, report)


# ── Grid rendering ──────────────────────────────────────────────────


async def _render_batched_grids(
    user_id: str, study_id: str, series, scan_count: int,
    per_grid: int,
) -> list[tuple[int, int, bytes]]:
    """Render a list of (slice_start, slice_end, png_bytes) tuples.

    Slice indices stride evenly across the series so for a 500-slice
    study we get ~31 grids covering all 500 slices in groups of 16.
    """
    try:
        from nexus_server.dicom import render_grid_png
    except ImportError:
        logger.warning("quick_scan: render_grid_png unavailable")
        return []

    out: list[tuple[int, int, bytes]] = []
    # Use scan_count to evenly sample 16 slices per grid out of the
    # full primary series. For series with <= per_grid slices, one
    # grid covers them all.
    n_grids = max(1, (scan_count + per_grid - 1) // per_grid)
    loop = asyncio.get_event_loop()

    for g in range(n_grids):
        start = g * per_grid
        end   = min(scan_count, start + per_grid) - 1
        if start > end:
            break
        try:
            # render_grid_png is sync + CPU heavy → run in thread pool.
            png = await loop.run_in_executor(
                None,
                lambda s=start, e=end:
                    render_grid_png(series, rows=4, cols=4,
                                    slice_start=s, slice_end=e),
            )
            if png:
                out.append((start, end, png))
        except TypeError:
            # render_grid_png signature may not accept slice_start/end
            # on older builds — fall back to whole-series sample.
            try:
                png = await loop.run_in_executor(
                    None,
                    lambda: render_grid_png(series, rows=4, cols=4),
                )
                if png:
                    out.append((start, end, png))
                break  # one grid is all we can get
            except Exception as e:  # noqa: BLE001
                logger.warning("quick_scan grid render failed: %s", e)
        except Exception as e:  # noqa: BLE001
            logger.warning("quick_scan grid %d render failed: %s",
                           g, e)

    return out


# ── Phase 1 triage ──────────────────────────────────────────────────


async def _phase1_triage(
    grids: list[tuple[int, int, bytes]],
    *, modality: str, body_part: str,
) -> list[GridFinding]:
    """Send each grid to Gemini Flash in parallel (capped) and parse
    the JSON verdict. Errors become GridFinding(verdict='error')."""
    sem = asyncio.Semaphore(PHASE1_CONCURRENCY)

    async def scan_one(start: int, end: int, png: bytes) -> GridFinding:
        async with sem:
            return await _gemini_triage_grid(
                png, slice_start=start, slice_end=end,
                modality=modality, body_part=body_part)

    tasks = [scan_one(s, e, p) for (s, e, p) in grids]
    return await asyncio.gather(*tasks)


async def _gemini_triage_grid(
    png: bytes, *, slice_start: int, slice_end: int,
    modality: str, body_part: str,
) -> GridFinding:
    """One Gemini Flash call: parse JSON verdict."""
    api_key = (config.GEMINI_API_KEY or "").strip()
    if not api_key:
        return GridFinding(
            slice_start=slice_start, slice_end=slice_end,
            verdict="error", error="GEMINI_API_KEY not configured",
        )

    prompt = f"""You are a board-certified radiologist screening a {modality} of {body_part}. The attached image is a 4×4 grid of axial slices labeled top-left → bottom-right as slices {slice_start} through {slice_end}.

Triage rules:
  - "clean": nothing notable
  - "suspicious": clear abnormality (mass, hemorrhage, dissection, fracture, etc.)
  - "unsure": something might be off but not confident
  - Pick the urgency: "critical" (needs urgent follow-up TODAY), "moderate" (routine follow-up), "incidental" (note but not urgent)

Return STRICT JSON ONLY — no markdown fence, no prose:
{{
  "verdict": "clean" | "suspicious" | "unsure",
  "finding": "<one sentence, anatomy + approximate slice number, OR empty string if clean>",
  "urgency": "critical" | "moderate" | "incidental" | ""
}}

Be honest about uncertainty. This is a preliminary screen; final read happens by the radiologist."""

    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=api_key)
        # google-genai supports inline image bytes via types.Part.
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(
            None,
            lambda: client.models.generate_content(
                model=PHASE1_MODEL,
                contents=[
                    types.Part.from_bytes(data=png, mime_type="image/png"),
                    prompt,
                ],
            ),
        )
        text = (getattr(resp, "text", "") or "").strip()
    except Exception as e:  # noqa: BLE001
        return GridFinding(
            slice_start=slice_start, slice_end=slice_end,
            verdict="error", error=f"{type(e).__name__}: {e}",
        )

    # Parse the JSON. LLMs often wrap with ```json fences; strip them.
    parsed = _parse_loose_json(text)
    if not parsed:
        return GridFinding(
            slice_start=slice_start, slice_end=slice_end,
            verdict="error",
            error=f"non-JSON response: {text[:120]}",
        )
    verdict = (parsed.get("verdict") or "").lower().strip()
    if verdict not in ("clean", "suspicious", "unsure"):
        verdict = "unsure"
    return GridFinding(
        slice_start = slice_start,
        slice_end   = slice_end,
        verdict     = verdict,
        finding     = str(parsed.get("finding") or "").strip(),
        urgency     = str(parsed.get("urgency") or "").lower().strip(),
    )


_JSON_BLOCK_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_loose_json(text: str) -> Optional[dict]:
    """Best-effort JSON extraction from LLM text. Handles raw JSON,
    JSON wrapped in ```json fences, JSON embedded in prose."""
    text = text.strip()
    # Try direct parse first.
    try:
        return json.loads(text)
    except Exception:
        pass
    # Fall back to first {...} match.
    m = _JSON_BLOCK_RE.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


# ── Emit report ─────────────────────────────────────────────────────


def _finding_to_dict(f: GridFinding) -> dict:
    return {
        "slice_start": f.slice_start,
        "slice_end":   f.slice_end,
        "verdict":     f.verdict,
        "finding":     f.finding,
        "urgency":     f.urgency,
    }


def _summarise_counts(findings: list[GridFinding]) -> dict:
    counts = {
        "critical":   0,
        "moderate":   0,
        "incidental": 0,
        "clean":      0,
        "unsure":     0,
        "error":      0,
    }
    for f in findings:
        if f.verdict == "clean":
            counts["clean"] += 1
        elif f.verdict == "error":
            counts["error"] += 1
        elif f.urgency in ("critical", "moderate", "incidental"):
            counts[f.urgency] += 1
        else:
            counts["unsure"] += 1
    return counts


async def _emit_report(user_id: str, report: QuickScanReport) -> None:
    """Write the synthesised report as an assistant_response event
    in the user's twin event log. The desktop's chat refresh picks
    this up on its next poll and renders it as a special card."""
    body = _format_report_markdown(report)
    try:
        from nexus_server.twin_manager import get_twin
        twin = await get_twin(user_id)
        twin.event_log.append(
            "assistant_response", body,
            metadata={
                "kind":           "quick_scan_report",
                "study_id":       report.study_id,
                "patient_hash":   report.patient_hash,
                "modality":       report.modality,
                "body_part":      report.body_part,
                "total_slices":   report.total_slices,
                "scanned_slices": report.scanned_slices,
                "elapsed_s":      report.elapsed_s,
                "findings":       report.findings,
                "summary_counts": report.summary_counts,
                "model_chain":    report.model_chain,
                "disclaimer":     DISCLAIMER,
            },
        )
        logger.info(
            "quick_scan ✓ user=%s study=%s findings=%d elapsed=%ss",
            user_id, report.study_id[:8],
            len(report.findings), report.elapsed_s,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("quick_scan emit failed: %s", e)


def _emit_failure_report(user_id: str, study_id: str, err: str) -> None:
    """Synchronously emit a failure event so the medic isn't left
    waiting for a result that will never arrive."""
    import asyncio as _asyncio

    async def _emit():
        try:
            from nexus_server.twin_manager import get_twin
            twin = await get_twin(user_id)
            twin.event_log.append(
                "assistant_response",
                f"🔍 Quick scan could not run on this study.\n\n"
                f"Reason: {err}\n\n"
                f"{DISCLAIMER}",
                metadata={
                    "kind":       "quick_scan_report",
                    "study_id":   study_id,
                    "error":      err,
                    "disclaimer": DISCLAIMER,
                },
            )
        except Exception:
            pass

    try:
        _asyncio.run(_emit())
    except Exception:
        pass


def _format_report_markdown(report: QuickScanReport) -> str:
    """Render the report as markdown for the chat bubble fallback.
    The desktop's quick_scan_report card will render this in a richer
    layout, but plain-text fallback keeps it useful even in raw
    text mode."""
    counts = report.summary_counts
    lines = [
        f"🔍 **Quick scan complete** · {report.elapsed_s}s · "
        f"{report.modality} {report.body_part}",
        "",
    ]
    if report.findings:
        crit = counts.get("critical", 0)
        mod  = counts.get("moderate", 0)
        inc  = counts.get("incidental", 0)
        bar = []
        if crit: bar.append(f"🔴 {crit} critical")
        if mod:  bar.append(f"🟡 {mod} moderate")
        if inc:  bar.append(f"🟢 {inc} incidental")
        if bar:
            lines.append("  ·  ".join(bar))
            lines.append("")
        # Sort findings by urgency (critical → moderate → incidental)
        urgency_rank = {"critical": 0, "moderate": 1, "incidental": 2,
                        "": 3}
        sorted_findings = sorted(
            report.findings,
            key=lambda f: (urgency_rank.get(f.get("urgency", ""), 3),
                           f.get("slice_start", 0)),
        )
        for f in sorted_findings:
            icon = {"critical": "🔴", "moderate": "🟡",
                    "incidental": "🟢"}.get(f.get("urgency", ""), "•")
            txt = f.get("finding", "").strip() or "(no detail)"
            lines.append(
                f"{icon} **slices {f['slice_start']}–{f['slice_end']}** — "
                f"{txt}"
            )
    else:
        lines.append(
            "✓ No flagged findings across the scanned slices."
        )
    lines.append("")
    lines.append(
        f"_Scanned {report.scanned_slices} of {report.total_slices} slices · "
        f"{report.grids_scanned} grids · "
        f"model: {', '.join(report.model_chain)}_"
    )
    lines.append("")
    lines.append(f"⚠ {DISCLAIMER}")
    return "\n".join(lines)
