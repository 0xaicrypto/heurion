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
from nexus_server.retrieval_tiers import retrieve_async

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


class ChatRequest(BaseModel):
    text: str
    session_id: str
    patient_hash: Optional[str] = None
    # File IDs the medic attached to this turn (pasted images, dropped
    # PDFs, etc.). Front end uploads each via /api/v1/files/upload first,
    # then references them here. The server enriches the question with
    # each attachment's name + extracted text (when available) so the
    # downstream LLM sees them. Images get a name-only mention until we
    # ship vision-API plumbing through ``llm_gateway.call_llm``.
    attachments: list[str] = []


def _sse(event: dict) -> str:
    """Serialise a chunk as an SSE message."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(
    req: ChatRequest,
    current_user: str = Depends(get_current_user),
):
    """Stream a chat turn as SSE events. See module docstring for shape."""
    # A turn is valid if EITHER the medic typed something OR they
    # attached at least one file. Pasting a screenshot with no text
    # ("what is this?") should not be rejected — that's a legitimate
    # "tell me about this" intent. We synthesise a generic prompt
    # downstream when text is empty.
    if not req.text.strip() and not (req.attachments or []):
        raise HTTPException(status_code=400, detail="empty message")

    async def event_stream() -> AsyncIterator[str]:
        with get_db_connection() as conn:
            init_event_sourcing_schema(conn)
            store = Store(conn)

            # Resolve attachments → text + image-bytes per file. Three
            # tracks downstream:
            #
            #   A. Text-extractable (txt / md / csv / pdf / docx / etc.):
            #      pull from uploads.extracted_text, OR on-demand-extract
            #      from disk_path via nexus_core.distiller.extract_text
            #      and cache back to the row. Text goes into the prompt
            #      preamble.
            #
            #   B. Image (png / jpeg / tiff / webp / gif): collect the
            #      raw bytes for the multimodal Gemini call in
            #      yield_t3_llm. The LLM gets Part.from_bytes so it
            #      actually SEES the screenshot the medic pasted —
            #      previously the chat just echoed "I can't view this
            #      file" because we never fed bytes through.
            #
            #   C. Anything else: name-only mention in the preamble so
            #      the LLM at least acknowledges the attachment exists.
            attachment_meta: list[dict] = []
            attachment_preamble_parts: list[str] = []
            attachment_images: list[tuple[str, str, bytes]] = []  # (name, mime, raw)
            for fid in (req.attachments or []):
                try:
                    row = conn.execute(
                        "SELECT name, mime, extracted_text, disk_path "
                        "FROM uploads "
                        "WHERE user_id = ? AND file_id = ?",
                        (current_user, fid),
                    ).fetchone()
                except Exception:  # noqa: BLE001
                    row = None
                if not row:
                    continue
                name = str(row[0] or fid)
                mime = str(row[1] or "")
                etext = str(row[2] or "").strip()
                disk_path = str(row[3] or "")

                is_image = mime.startswith("image/")

                # Track A — on-demand text extraction if not cached.
                if not etext and not is_image and disk_path:
                    try:
                        from pathlib import Path as _Path
                        p = _Path(disk_path)
                        if p.is_file():
                            raw = p.read_bytes()
                            from nexus_server.files import (
                                _bytes_to_text, _save_extracted_text,
                            )
                            text_out = _bytes_to_text(raw, name, mime)
                            if text_out:
                                etext = text_out.strip()
                                _save_extracted_text(fid, etext)
                    except Exception as e:  # noqa: BLE001
                        logger.debug(
                            "lazy extract for %s failed: %s", fid[:8], e,
                        )

                # Track B — collect image bytes for the vision call.
                if is_image and disk_path:
                    try:
                        from pathlib import Path as _Path
                        p = _Path(disk_path)
                        if p.is_file():
                            raw = p.read_bytes()
                            # Cap each image at 4 MB so a pathologically
                            # huge paste doesn't OOM the LLM call. Real
                            # screenshots / photos are well under this.
                            if len(raw) <= 4 * 1024 * 1024:
                                attachment_images.append((name, mime, raw))
                            else:
                                logger.warning(
                                    "image %s exceeds 4MB (%d bytes) — "
                                    "skipping vision pass",
                                    name, len(raw),
                                )
                    except Exception as e:  # noqa: BLE001
                        logger.debug(
                            "image read for %s failed: %s", fid[:8], e,
                        )

                attachment_meta.append({
                    "file_id": fid, "name": name, "mime": mime,
                    "has_text": bool(etext),
                    "is_image": is_image,
                })

                if etext:
                    # Cap each attachment's inlined text so a 500-page PDF
                    # doesn't blow the prompt context. 8 KB per attachment
                    # × 5 attachments = 40 KB of preamble — well within
                    # Gemini 2.5 Flash's 1M-token window.
                    snippet = etext[:8000]
                    attachment_preamble_parts.append(
                        f"--- {name} ({mime}) ---\n{snippet}"
                    )
                elif is_image:
                    attachment_preamble_parts.append(
                        f"--- {name} ({mime}) ---\n"
                        f"(image attached — see it inline in the model's "
                        f"input. Describe what's shown if relevant to "
                        f"the question.)"
                    )
                else:
                    attachment_preamble_parts.append(
                        f"--- {name} ({mime or 'unknown'}) ---\n"
                        f"(binary file — no text content extractable. "
                        f"Tell the medic what format it is and ask for "
                        f"clarification if their question depends on "
                        f"the contents.)"
                    )

            # Synthesise a default question when the medic pasted only
            # files (no text). Gives the LLM something concrete to do
            # AND tells it explicitly to look at the attachments.
            base_question = req.text.strip()
            if not base_question:
                if attachment_images:
                    base_question = (
                        "What does the attached image show? Please describe "
                        "it in clinical terms relevant to this patient."
                    )
                else:
                    base_question = (
                        "Summarise the attached file(s) and tell me anything "
                        "clinically relevant for this patient."
                    )

            question_for_retrieval = base_question
            if attachment_preamble_parts:
                question_for_retrieval = (
                    "The medic attached the following file(s) to this turn:\n\n"
                    + "\n\n".join(attachment_preamble_parts)
                    + "\n\n--- QUESTION ---\n"
                    + base_question
                )

            # 1. Persist the user message + announce turn
            user_idx = store.emit_and_apply(
                kind=EventKind.USER_MESSAGE,
                payload={
                    "text":        req.text,
                    "session_id":  req.session_id,
                    "attachments": [a["file_id"] for a in attachment_meta],
                },
                apply_fn=_h_user_message,
                user_id=current_user, patient_hash=req.patient_hash,
            )
            yield _sse({
                "type": "turn_started",
                "event_idx": user_idx,
                "patient_hash": req.patient_hash,
                "attachments": attachment_meta,
            })

            # 2. Run retrieval — yields RetrievalChunk events
            collected_answer: list[str] = []
            collected_refs: list[dict] = []
            async for chunk in retrieve_async(
                conn,
                user_id=current_user,
                patient_hash=req.patient_hash,
                question=question_for_retrieval,
                attachment_images=attachment_images,
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

            # 4. Fire the chat_ingester so this turn's clinical entities
            #    populate Layer 1 of the patient graph. Without this, the
            #    Memory tab stays at (0) and yield_t3_llm's next call has
            #    no PATIENT CONTEXT to ground in. Best-effort — failure
            #    here must not break the SSE stream we already finished.
            if req.patient_hash:
                try:
                    _run_chat_ingester_safe(
                        user_id=current_user,
                        patient_hash=req.patient_hash,
                        session_id=req.session_id,
                        source_event_idx=assistant_idx,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("chat_ingester failed (non-fatal): %s", exc)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _run_chat_ingester_safe(
    *, user_id: str, patient_hash: str, session_id: str,
    source_event_idx: int,
) -> None:
    """Run the chat_ingester for one encounter and log how it went.

    ``source_event_idx`` MUST be a real existing event_idx (typically
    the just-committed ASSISTANT_RESPONSE). chat_ingester passes it as
    ``caused_by`` on the INGESTION_STARTED event, and the event_log
    has a FK from caused_by → events.event_idx. Passing 0 produces
    "FOREIGN KEY constraint failed" and the whole ingest aborts.

    Idempotent: re-running on the same encounter just produces a
    second batch of NODE_ADDED events (the handler dedupes by
    (user_id, patient_hash, evidence_quote))."""
    from nexus_server.event_sourcing import Store, init_event_sourcing_schema
    from nexus_server.memorization.chat_ingester import ChatIngester
    from nexus_server.memorization.llm_extractor import (
        llm_chat_extractor, EXTRACTION_MODEL_TAG, EXTRACTION_PROMPT_ID,
    )

    with get_db_connection() as conn:
        init_event_sourcing_schema(conn)
        store = Store(conn)
        ingester = ChatIngester(
            store=store, conn=conn,
            extractor=llm_chat_extractor,
            extraction_model=EXTRACTION_MODEL_TAG,
            extraction_prompt_id=EXTRACTION_PROMPT_ID,
        )
        node_idxs = ingester.ingest_encounter(
            user_id=user_id,
            patient_hash=patient_hash,
            encounter_id=session_id or "(no-session)",
            source_event_idx=source_event_idx,
        )
        logger.info(
            "chat_ingester: user=%s patient=%s emitted %d node(s)",
            user_id, patient_hash[:12], len(node_idxs),
        )
