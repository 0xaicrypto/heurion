"""Server-side re-export shim for the SDK's distillation pipeline.

The actual LLM-driven distillation logic lives at
:mod:`nexus_core.distiller` so any consumer of the SDK can reuse
it without re-implementing the extract / summarise / fall-back-to-head
dance. This module re-exports ``distill_attachment`` and
``extract_text`` under the legacy name the server's ``llm_gateway``
historically imported.

Phase B note: this module previously also owned
``record_distilled_event`` which wrote ``attachment_distilled`` rows
into ``sync_events`` for the legacy server-side data plane. That
plane is gone — the ``sync_events`` table itself was dropped — so
the persistence half is removed. Distilled summaries ride back to the
desktop inline in the chat response (``LLMChatResponse.attachment_summaries``);
no separate server-side persistence happens.
"""

from __future__ import annotations

import logging

from nexus_core.distiller import (
    DISTILL_INPUT_CHAR_BUDGET,
    DISTILL_OUTPUT_CHAR_BUDGET,
    DISTILL_SYSTEM_PROMPT,
    IMAGE_CAPTION_CHAR_BUDGET,
    IMAGE_DISTILL_SYSTEM_PROMPT,
    LlmFn,
    distill,
    distill_image,
    extract_text,
)

logger = logging.getLogger(__name__)


# Back-compat alias — server's llm_gateway imports ``distill_attachment``.
# SDK API name is ``distill``; keep the local name pointing at it so
# server callers don't churn.
distill_attachment = distill


__all__ = [
    "distill_attachment",
    "distill_image",
    "extract_text",
    "DISTILL_INPUT_CHAR_BUDGET",
    "DISTILL_OUTPUT_CHAR_BUDGET",
    "DISTILL_SYSTEM_PROMPT",
    "IMAGE_CAPTION_CHAR_BUDGET",
    "IMAGE_DISTILL_SYSTEM_PROMPT",
    "LlmFn",
]
