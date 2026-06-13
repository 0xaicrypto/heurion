"""MONAI Label OHIF bridge (Rev-6 / Rev-9).

Captures medic-in-the-loop annotation corrections from the OHIF viewer
on the frontend and writes them to event_log as ``medic_correction``
events. M1.6+ uses these as the future retraining signal.

The MONAI Label REST protocol expects a server at a particular base URL.
This module exposes a thin shim that OHIF can connect to as if it were
a remote Label server, but everything happens locally.

Endpoints (per https://docs.monai.io/projects/label/en/latest/):

* ``GET  /info``                  — server capabilities
* ``GET  /datastore``             — list of studies + label state
* ``POST /datastore/label/<id>``  — submit a label
* ``POST /infer/<model>``         — run inference (stubbed in M1.6;
                                     real inference companion is M10)
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from nexus_server.auth.routes import get_current_user
from nexus_server.database import get_db_connection
from nexus_server.event_sourcing import EventKind, Store, init_event_sourcing_schema
from nexus_server.event_sourcing.handlers import _h_medic_correction

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/monai_label", tags=["monai_label"])


@router.get("/info")
async def info() -> dict:
    """MONAI Label spec: server capabilities advertisement."""
    return {
        "name":         "Nexus MONAI Label Bridge",
        "version":      "1.0",
        "description": "Captures medic annotation corrections to event_log.",
        "labels":       ["finding", "anatomical_region"],
        "models":       [
            # Listed for protocol compatibility; real inference at M10.
            {"name": "quick_scan_4x4_grid", "description": "Stage 2C 3D triage"},
        ],
        "datastore":    {"writable": True},
    }


class MedicCorrection(BaseModel):
    """One annotation correction from the OHIF viewer."""
    source_node_id: int
    correction_text: str
    action_taken: str                 # 'roi_redrawn' | 'finding_relabeled' | …
    patient_hash: Optional[str] = None


@router.post("/correction")
async def submit_correction(
    body: MedicCorrection,
    current_user: str = Depends(get_current_user),
) -> dict:
    """Persist one medic correction as an event-sourced record.

    The frontend (OhifViewport + useOhifMonaiLabelBridge hook in U2)
    posts here whenever the medic redraws an ROI, relabels a finding,
    or writes a freeform note on a key image.
    """
    with get_db_connection() as conn:
        init_event_sourcing_schema(conn)
        store = Store(conn)
        event_idx = store.emit_and_apply(
            kind=EventKind.MEDIC_CORRECTION,
            payload={
                "source_node_id":  body.source_node_id,
                "correction_text": body.correction_text,
                "action_taken":    body.action_taken,
            },
            apply_fn=_h_medic_correction,
            user_id=current_user,
            patient_hash=body.patient_hash,
        )
        return {"ok": True, "event_idx": event_idx}


@router.get("/datastore")
async def datastore(
    current_user: str = Depends(get_current_user),
) -> dict:
    """Return the list of studies + their label status.

    For now: simple list from clinical_graph_nodes. Real implementation
    will respect MONAI Label spec exactly when we ship OHIF integration."""
    with get_db_connection() as conn:
        init_event_sourcing_schema(conn)
        rows = conn.execute(
            "SELECT node_id, content_json FROM clinical_graph_nodes "
            "WHERE user_id = ? AND node_type = 'study' "
            "ORDER BY updated_at DESC LIMIT 200",
            (current_user,),
        ).fetchall()
        return {
            "datastore": [
                {"node_id": nid, "content": json.loads(c)}
                for nid, c in rows
            ]
        }
