"""Chat SSE endpoint (UX v2 §8.2 + Rev-4).

POST /api/v1/agent/chat — streams Server-Sent Events:

  turn_started → tier_classified → [reasoning_chunk | search_query |
  search_results_summary | image_attached]* → final_answer_chunk* →
  citations → turn_complete

Every turn:
1. user_message event written to event_log
2. retrieval_tiers.retrieve() yields tier-specific events
3. assistant_response event written to event_log with full text +
   model + prompt_id + citations payload
4. Background: chat_ingester runs to extract entities (M0 already wires
   this; we don't block the response on it)

Auth-gated; user_id closed over server-side per same pattern as
memory_router_v2.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from nexus_server.auth.routes import get_current_user
from nexus_server.database import get_db_connection
from nexus_server.event_sourcing import EventKind, Store, init_event_sourcing_schema
from nexus_server.event_sourcing.handlers import (
    _h_assistant_response,
    _h_user_message,
)
from nexus_server.retrieval_tiers import retrieve

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


class ChatRequest(BaseModel):
    text: str
    session_id: str
    patient_hash: Optional[str] = None


def _sse(event: dict) -> str:
    """Serialise a chunk as an SSE message."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(
    req: ChatRequest,
    current_user: str = Depends(get_current_user),
):
    """Stream a chat turn as SSE events. See module docstring for shape."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="empty message")

    async def event_stream() -> AsyncIterator[str]:
        with get_db_connection() as conn:
            init_event_sourcing_schema(conn)
            store = Store(conn)

            # 1. Persist the user message + announce turn
            user_idx = store.emit_and_apply(
                kind=EventKind.USER_MESSAGE,
                payload={"text": req.text, "session_id": req.session_id},
                apply_fn=_h_user_message,
                user_id=current_user, patient_hash=req.patient_hash,
            )
            yield _sse({
                "type": "turn_started",
                "event_idx": user_idx,
                "patient_hash": req.patient_hash,
            })

            # 2. Run retrieval — yields RetrievalChunk events
            collected_answer: list[str] = []
            collected_refs: list[dict] = []
            for chunk in retrieve(
                conn,
                user_id=current_user,
                patient_hash=req.patient_hash,
                question=req.text,
            ):
                if chunk.kind == "final_answer_chunk":
                    collected_answer.append(chunk.data.get("text", ""))
                if chunk.kind == "citations":
                    collected_refs = chunk.data.get("refs", [])
                yield _sse({"type": chunk.kind, **chunk.data})
                await asyncio.sleep(0)   # cooperative yield

            # 3. Persist the assistant response verbatim per Rev-8
            full_text = "".join(collected_answer)
            assistant_idx = store.emit_and_apply(
                kind=EventKind.ASSISTANT_RESPONSE,
                payload={
                    "text":          full_text,
                    "session_id":    req.session_id,
                    "model":         "tier-orchestrator@1.0",
                    "prompt_id":     "chat_tiered_v1",
                    "prompt_version":"1.0",
                    "citations":     collected_refs,
                },
                apply_fn=_h_assistant_response,
                user_id=current_user, patient_hash=req.patient_hash,
                caused_by=user_idx,
            )
            yield _sse({
                "type": "turn_complete",
                "assistant_event_idx": assistant_idx,
            })

    return StreamingResponse(event_stream(), media_type="text/event-stream")
