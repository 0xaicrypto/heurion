"""#180 — manual patient registration + unified patient roster.

The original PatientNavigator (#174) inferred patient cards purely from
the dicom_studies table — so a patient existed in the UI only after the
first DICOM study was uploaded. The medic asked for a different flow:

  1. "+ New patient" should open a *form* where the medic types basic
     demographics first (initials, age, sex, MRN, chief complaint),
     optionally attaching diagnostic files.
  2. The patient appears in the roster IMMEDIATELY (before any study)
     so the medic can keep working in the right per-patient context.
  3. There needs to be a place to view ALL patients with their full
     info, not just the left-rail summary.

This module adds:
  * a ``patients`` table (one row per manually-registered patient)
  * ``POST /api/v1/dicom/patients/register-manual`` — registers a
    patient + returns a stable ``patient_hash`` keyed off MRN or a
    deterministic hash of (initials, dob/age_group, sex). Same hash
    function as the DICOM ingest path so future PACS uploads of the
    same patient collide cleanly.
  * ``GET /api/v1/dicom/patients/full`` — full roster (manual rows
    UNION'd with DICOM-aggregated rows). Used by the new Patients
    main-canvas view.
  * ``GET /api/v1/dicom/patients/{patient_hash}/detail`` — single
    patient including all manually-entered fields + study summary.
"""
from __future__ import annotations

import sqlite3
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from nexus_server.auth import get_current_user
from nexus_server.dicom import _hash_patient_id, _index_db_path


router = APIRouter(prefix="/api/v1/dicom", tags=["patients"])


# ── Schema ──────────────────────────────────────────────────────────


def _conn() -> sqlite3.Connection:
    """Connect to the same DICOM index DB so JOINs across patients +
    studies are cheap and consistent."""
    c = sqlite3.connect(_index_db_path())
    c.row_factory = sqlite3.Row
    return c


def init_patients_table() -> None:
    """Idempotent schema setup. Called from the app's startup hook
    (alongside init_dicom_index)."""
    with _conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS patients (
                patient_hash    TEXT NOT NULL,
                user_id         TEXT NOT NULL,
                -- PHI-safe display fields. We store the medic's
                -- input verbatim (it's their own private DB) but
                -- never round-trip the raw name back to the LLM —
                -- the agent only ever sees the hash + age band /
                -- sex / chief complaint.
                initials        TEXT NOT NULL DEFAULT '',
                mrn             TEXT NOT NULL DEFAULT '',
                age_group       TEXT NOT NULL DEFAULT '',  -- "50-59"
                age_value       INTEGER NOT NULL DEFAULT 0, -- raw years; 0 = unknown
                sex             TEXT NOT NULL DEFAULT '',  -- M / F / Other / ""
                chief_complaint TEXT NOT NULL DEFAULT '',
                notes           TEXT NOT NULL DEFAULT '',
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                PRIMARY KEY (user_id, patient_hash)
            )
            """
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_patients_user "
            "ON patients(user_id, created_at DESC)"
        )


def _age_to_group(age: int) -> str:
    """Convert raw age to 10-year band — matches the DICOM ingest
    path's grouping so the rail labels are consistent."""
    if age <= 0:
        return ""
    if age >= 90:
        return "90+"
    decade = (age // 10) * 10
    return f"{decade}-{decade + 9}"


# ── Models ──────────────────────────────────────────────────────────


class RegisterManualPatientRequest(BaseModel):
    """Body of the manual-registration POST. All fields optional except
    initials OR mrn (at least one is required so we have something to
    hash). The dialog UI enforces this client-side too."""
    initials:        str = Field("", max_length=64)
    mrn:             str = Field("", max_length=128)
    age:             int = Field(0, ge=0, le=130)
    sex:             str = Field("", max_length=8)
    chief_complaint: str = Field("", max_length=2000)
    notes:           str = Field("", max_length=5000)
    # #181 — when the desktop passes the active session_id we
    # also UPDATE sessions SET patient_hash, so subsequent file
    # uploads in this chat inherit the patient_hash automatically
    # (via the #178 session → uploads.patient_hash join).
    session_id:      str = Field("", max_length=128)


class RegisterManualPatientResponse(BaseModel):
    patient_hash: str
    age_group:    str


class PatientDetail(BaseModel):
    """Full per-patient view used by the Patients main canvas. Combines
    the manually-entered fields with derived study aggregates."""
    patient_hash:      str
    initials:          str
    mrn:               str
    age_value:         int
    age_group:         str
    sex:               str
    chief_complaint:   str
    notes:             str
    created_at:        int
    updated_at:        int
    study_count:       int
    latest_study_date: str
    latest_modality:   str
    last_seen_at:      int
    source:            str  # "manual" / "dicom" / "both"


# ── Endpoints ───────────────────────────────────────────────────────


@router.post(
    "/patients/register-manual",
    response_model=RegisterManualPatientResponse,
)
async def register_manual_patient(
    req: RegisterManualPatientRequest,
    current_user: str = Depends(get_current_user),
) -> RegisterManualPatientResponse:
    """Register a patient typed in by the medic (no DICOM yet).

    Hash rule:
      * If MRN is provided, hash it directly (same function as the
        DICOM PatientID path → future PACS uploads of the same MRN
        collide and merge automatically).
      * Else, hash a normalised concatenation of (initials | age |
        sex). This is deterministic so re-registering the same
        patient finds the existing row instead of creating a dup.

    Returns the patient_hash so the desktop can immediately bind the
    active session to it (so subsequent file uploads inherit the
    hash via the session→uploads.patient_hash join from #178).
    """
    init_patients_table()

    initials = (req.initials or "").strip()
    mrn      = (req.mrn or "").strip()
    sex      = (req.sex or "").strip().upper()[:1]  # M/F/O
    if sex not in ("M", "F", "O"):
        sex = ""

    if not initials and not mrn:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide initials or MRN (at least one is required).",
        )

    # Stable identifier for hashing. MRN wins if present.
    if mrn:
        identity_key = f"mrn:{mrn}"
    else:
        identity_key = (
            f"manual:{initials.upper()}|{req.age}|{sex}"
        )
    patient_hash = _hash_patient_id(identity_key)
    age_group = _age_to_group(req.age)
    now = int(time.time())

    with _conn() as c:
        # UPSERT — re-registering with new fields refreshes the row
        # rather than failing.
        existing = c.execute(
            "SELECT created_at FROM patients "
            "WHERE user_id = ? AND patient_hash = ?",
            (current_user, patient_hash),
        ).fetchone()
        if existing:
            c.execute(
                """
                UPDATE patients
                   SET initials = ?, mrn = ?, age_group = ?,
                       age_value = ?, sex = ?, chief_complaint = ?,
                       notes = ?, updated_at = ?
                 WHERE user_id = ? AND patient_hash = ?
                """,
                (initials, mrn, age_group, req.age, sex,
                 req.chief_complaint, req.notes, now,
                 current_user, patient_hash),
            )
        else:
            c.execute(
                """
                INSERT INTO patients
                  (patient_hash, user_id, initials, mrn,
                   age_group, age_value, sex, chief_complaint,
                   notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (patient_hash, current_user, initials, mrn,
                 age_group, req.age, sex, req.chief_complaint,
                 req.notes, now, now),
            )
        c.commit()

    # #181 — bind the session if one was passed. Best-effort; if
    # the sessions table doesn't have the row yet (synthetic default
    # thread) this UPDATE is a no-op and the next upload will still
    # work because the upload route falls back to "" patient_hash.
    if req.session_id:
        try:
            from nexus_server.database import get_db_connection
            with get_db_connection() as conn:
                conn.execute(
                    "UPDATE sessions SET patient_hash = ? "
                    "WHERE user_id = ? AND session_id = ?",
                    (patient_hash, current_user, req.session_id),
                )
                conn.commit()
        except Exception:
            pass

    return RegisterManualPatientResponse(
        patient_hash=patient_hash,
        age_group=age_group,
    )


# ── Delete ──────────────────────────────────────────────────────────


class DeletePatientResponse(BaseModel):
    patient_hash: str
    deleted: dict[str, int]   # per-table row counts removed


@router.delete(
    "/patients/{patient_hash}",
    response_model=DeletePatientResponse,
)
async def delete_patient(
    patient_hash: str,
    current_user: str = Depends(get_current_user),
) -> DeletePatientResponse:
    """Forget a patient. Scoped to the calling user — we never cross the
    (user_id, patient_hash) tuple, so one medic deleting "patient #3"
    cannot affect another medic with the same hash.

    What we touch (each is best-effort + idempotent — missing tables /
    missing rows just count as 0):

      - ``patients``                  manual registration row
      - ``dicom_studies``             DICOM-derived aggregate rows
      - ``uploads``                   files bound to this patient_hash
      - ``patient_memory``            per-patient memory blob
      - ``clinical_graph_nodes``      M3 graph projection
      - ``sessions``                  un-bind (set patient_hash = "")
                                       rather than delete — the chat
                                       history outlives the patient
                                       record.

    Returns per-table counts so the UI can show a meaningful toast and
    so users debugging "why didn't my delete work?" have a paper trail.

    Note: the underlying ``twin_event_log`` is append-only and is NOT
    touched. The graph and other projections being deleted here are
    rebuildable by replaying the event log if the medic ever wants the
    record back. This is what makes "delete" recoverable in principle —
    we're forgetting from projections, not editing history.
    """
    deleted: dict[str, int] = {}

    def _delete(conn: sqlite3.Connection, table: str, where: str, params: tuple) -> int:
        try:
            cur = conn.execute(f"DELETE FROM {table} WHERE {where}", params)
            return cur.rowcount or 0
        except sqlite3.Error:
            # Table doesn't exist on this deployment yet — that's fine,
            # the user just hasn't generated any rows for it.
            return 0

    # ── Patients-router-local DB (manual registry) ───────────────
    with _conn() as conn:
        deleted["patients"] = _delete(
            conn, "patients",
            "user_id = ? AND patient_hash = ?",
            (current_user, patient_hash),
        )
        conn.commit()

    # ── Shared DB (uploads, sessions, dicom_studies, etc.) ───────
    try:
        from nexus_server.database import get_db_connection
        with get_db_connection() as conn:
            deleted["dicom_studies"] = _delete(
                conn, "dicom_studies",
                "user_id = ? AND patient_hash = ?",
                (current_user, patient_hash),
            )
            deleted["uploads"] = _delete(
                conn, "uploads",
                "user_id = ? AND patient_hash = ?",
                (current_user, patient_hash),
            )
            deleted["patient_memory"] = _delete(
                conn, "patient_memory",
                "user_id = ? AND patient_hash = ?",
                (current_user, patient_hash),
            )
            deleted["clinical_graph_nodes"] = _delete(
                conn, "clinical_graph_nodes",
                "user_id = ? AND patient_hash = ?",
                (current_user, patient_hash),
            )
            # Sessions: un-bind, don't delete — chat history is its own
            # source of record.
            try:
                cur = conn.execute(
                    "UPDATE sessions SET patient_hash = '' "
                    "WHERE user_id = ? AND patient_hash = ?",
                    (current_user, patient_hash),
                )
                deleted["sessions_unbound"] = cur.rowcount or 0
            except sqlite3.Error:
                deleted["sessions_unbound"] = 0
            conn.commit()
    except Exception:
        # Shared DB unavailable — partial delete is acceptable, the
        # manual-patients row is the most visible one.
        pass

    total = sum(v for v in deleted.values() if v >= 0)
    if total == 0:
        # Nothing matched — return 404 so the desktop can show "already
        # gone" instead of pretending success.
        from fastapi import HTTPException
        raise HTTPException(
            status_code=404,
            detail=f"no rows for patient_hash={patient_hash[:8]}… belong to this user",
        )

    return DeletePatientResponse(
        patient_hash=patient_hash,
        deleted=deleted,
    )


@router.get(
    "/patients/full",
    response_model=list[PatientDetail],
)
async def list_patients_full(
    current_user: str = Depends(get_current_user),
) -> list[PatientDetail]:
    """Full roster for the Patients main-canvas view.

    UNIONs manual entries with DICOM-derived aggregates so a patient
    typed in the New Patient dialog shows up immediately, AND a
    patient who only exists via PACS uploads shows up too. Where the
    same patient_hash appears in both sources (medic typed them in
    AND later uploaded their study), we merge the rows — manual
    fields win for demographics, DICOM aggregates win for study
    counts.
    """
    init_patients_table()

    with _conn() as c:
        manual_rows = c.execute(
            "SELECT * FROM patients WHERE user_id = ?",
            (current_user,),
        ).fetchall()
        # #190/#193 — pull raw rows + aggregate in Python.
        # SQLite doesn't expose outer SELECT aliases inside subqueries
        # so the previous `(SELECT … WHERE … = phash)` correlated
        # subquery threw "no such column: phash" and the whole endpoint
        # 500'd. Python aggregation is simpler + provably correct.
        raw_dicom = c.execute(
            """
            SELECT
                patient_hash, patient_age_group, patient_sex,
                study_date, modality, created_at
            FROM dicom_studies
            WHERE user_id = ?
            ORDER BY created_at DESC
            """,
            (current_user,),
        ).fetchall()

    # Aggregate dicom by phash. raw_dicom is newest-first so the first
    # row we see per hash IS the latest study.
    dicom_rows: list = []
    seen_hash: dict[str, dict] = {}
    for r in raw_dicom:
        phash = r["patient_hash"] if r["patient_hash"] else "_anonymous"
        if phash not in seen_hash:
            seen_hash[phash] = {
                "phash":       phash,
                "age_group":   r["patient_age_group"] or "",
                "sex":         r["patient_sex"] or "",
                "study_count": 1,
                "latest_date": r["study_date"] or "",
                "latest_mod":  r["modality"] or "",
                "last_seen":   int(r["created_at"] or 0),
            }
        else:
            d = seen_hash[phash]
            d["study_count"] += 1
            if not d["age_group"] and r["patient_age_group"]:
                d["age_group"] = r["patient_age_group"]
            if not d["sex"] and r["patient_sex"]:
                d["sex"] = r["patient_sex"]
            d["last_seen"] = max(d["last_seen"],
                                 int(r["created_at"] or 0))
    # Convert to the dict-row shape the rest of the function expects.
    dicom_rows = [
        {
            "phash":       d["phash"],
            "age_group":   d["age_group"],
            "sex":         d["sex"],
            "study_count": d["study_count"],
            "latest_date": d["latest_date"],
            "latest_mod":  d["latest_mod"],
            "last_seen":   d["last_seen"],
        }
        for d in seen_hash.values()
    ]

    by_hash: dict[str, PatientDetail] = {}

    # Seed with manual rows first.
    for r in manual_rows:
        by_hash[r["patient_hash"]] = PatientDetail(
            patient_hash=r["patient_hash"],
            initials=r["initials"] or "",
            mrn=r["mrn"] or "",
            age_value=int(r["age_value"] or 0),
            age_group=r["age_group"] or "",
            sex=r["sex"] or "",
            chief_complaint=r["chief_complaint"] or "",
            notes=r["notes"] or "",
            created_at=int(r["created_at"] or 0),
            updated_at=int(r["updated_at"] or 0),
            study_count=0,
            latest_study_date="",
            latest_modality="",
            last_seen_at=int(r["created_at"] or 0),
            source="manual",
        )

    # Layer in DICOM aggregates.
    for r in dicom_rows:
        ph = r["phash"]
        if ph in by_hash:
            d = by_hash[ph]
            d.study_count = int(r["study_count"] or 0)
            d.latest_study_date = r["latest_date"] or ""
            d.latest_modality = r["latest_mod"] or ""
            d.last_seen_at = max(d.last_seen_at, int(r["last_seen"] or 0))
            d.source = "both"
            # Backfill demographics from DICOM if the manual row left
            # them blank.
            if not d.age_group:
                d.age_group = r["age_group"] or ""
            if not d.sex:
                d.sex = r["sex"] or ""
        else:
            by_hash[ph] = PatientDetail(
                patient_hash=ph,
                initials="",
                mrn="",
                age_value=0,
                age_group=r["age_group"] or "",
                sex=r["sex"] or "",
                chief_complaint="",
                notes="",
                created_at=int(r["last_seen"] or 0),
                updated_at=int(r["last_seen"] or 0),
                study_count=int(r["study_count"] or 0),
                latest_study_date=r["latest_date"] or "",
                latest_modality=r["latest_mod"] or "",
                last_seen_at=int(r["last_seen"] or 0),
                source="dicom",
            )

    # Most-recently-touched first so the medic's current case is at
    # the top of the view.
    return sorted(
        by_hash.values(),
        key=lambda p: p.last_seen_at,
        reverse=True,
    )


@router.get(
    "/patients/{patient_hash}/detail",
    response_model=PatientDetail,
)
async def get_patient_detail(
    patient_hash: str,
    current_user: str = Depends(get_current_user),
) -> PatientDetail:
    """Single patient view. 404 if neither manual nor DICOM knows
    about the hash."""
    all_patients = await list_patients_full(current_user)
    for p in all_patients:
        if p.patient_hash == patient_hash:
            return p
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"patient {patient_hash[:12]} not found",
    )
