"""
LLM-backed clinical-entity extractor for chat_ingester.

Bridges the abstract ``Extractor`` callable (``str → ExtractionResult``)
to the real LLM gateway. The output schema is the same as the stub
extractor's: a list of ``StructuredEntity`` rows with node_type +
content + verbatim evidence_quote.

Why a separate module: keeping the prompt in one place makes it easy
to version + iterate. M3-memory-architecture §5.0 talks about prompt
versioning as a first-class concern of the memorization layer.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from nexus_server.memorization.chat_ingester import (
    ExtractionResult, Extractor, StructuredEntity,
)

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT_ID = "chat_v1.0"
EXTRACTION_MODEL_TAG = "gemini-2.5-flash"

_SYSTEM = """\
You extract structured clinical entities from a brief chat encounter
between a physician and a clinical assistant. Output ONLY valid JSON.

For each clear clinical entity the encounter introduces, emit one
JSON object with these fields:

  node_type:        one of "finding", "med", "ddx", "measurement", "semantic_fact"
  content:          {label: "<short canonical name>", ...optional fields}
  evidence_quote:   a VERBATIM substring of the source text that
                    establishes the entity. Must appear character-for-
                    character in the source — do not paraphrase.
  confidence:       0.0 - 1.0 (your honest estimate)

Output shape — a single JSON object with one key:

  {"entities": [ <object>, <object>, ... ]}

Rules:
- Only extract entities the chat clearly establishes. Skip speculative
  or hypothetical mentions ("could be X").
- The label inside `content` must be a clinician-canonical name
  (e.g. "atrial fibrillation" not "afib"; "warfarin" not "coumadin").
- `evidence_quote` MUST be a substring of the input. Do not invent.
- Empty entities list is allowed. Do not pad with low-confidence guesses.
"""


def _parse_json_safe(raw: str) -> dict[str, Any]:
    """Parse the LLM output, tolerating Markdown code fences."""
    s = raw.strip()
    if s.startswith("```"):
        # Strip ```json ... ``` fences if present.
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        logger.warning("extractor LLM output isn't JSON: %r", raw[:200])
        return {}


def llm_chat_extractor(source_text: str) -> ExtractionResult:
    """Synchronous Extractor that wraps the async llm_gateway.call_llm.

    chat_ingester is sync (it runs as a FastAPI BackgroundTasks callback).
    We bridge to async by running the coroutine on the current event
    loop if one exists, or a fresh one if not.
    """
    t0 = time.monotonic()
    raw = ""
    try:
        from nexus_server import llm_gateway

        async def _call() -> str:
            content, _model, _stop, _tools = await llm_gateway.call_llm(
                messages=[{"role": "user", "content": source_text}],
                system_prompt=_SYSTEM,
                model=None,
                temperature=0.2,        # low T for extraction determinism
                max_tokens=1500,
                tools=None,
            )
            return content

        # Run the coroutine. If we're inside a running loop (very
        # unlikely for a sync BackgroundTask), fall back to creating a
        # new loop in a thread.
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # We're nested — run on a fresh loop in a worker thread.
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                    fut = ex.submit(asyncio.run, _call())
                    raw = fut.result()
            else:
                raw = loop.run_until_complete(_call())
        except RuntimeError:
            raw = asyncio.run(_call())
    except Exception as exc:  # noqa: BLE001
        logger.exception("LLM extractor failed: %s", exc)
        return ExtractionResult(
            raw_llm_output=f"(extractor error: {exc})",
            entities=[],
            latency_ms=int((time.monotonic() - t0) * 1000),
        )

    parsed = _parse_json_safe(raw)
    entities_raw = parsed.get("entities") or []

    entities: list[StructuredEntity] = []
    for item in entities_raw:
        if not isinstance(item, dict):
            continue
        node_type = item.get("node_type")
        if node_type not in {
            "finding", "med", "ddx", "measurement", "semantic_fact",
        }:
            continue
        content = item.get("content") or {}
        if not isinstance(content, dict):
            continue
        if not content.get("label"):
            continue
        evidence = item.get("evidence_quote") or ""
        if not isinstance(evidence, str) or evidence not in source_text:
            # chat_ingester's QuoteVerificationError would fail this
            # anyway — skip rather than blow up the whole pass.
            logger.debug(
                "extractor: dropping entity %s (evidence not verbatim)",
                content.get("label"),
            )
            continue
        try:
            conf = float(item.get("confidence", 0.7))
        except (TypeError, ValueError):
            conf = 0.7
        entities.append(StructuredEntity(
            node_type=node_type,
            content=content,
            evidence_quote=evidence,
            confidence=max(0.0, min(1.0, conf)),
        ))

    return ExtractionResult(
        raw_llm_output=raw,
        entities=entities,
        latency_ms=int((time.monotonic() - t0) * 1000),
    )


# Make the type-system happy: this satisfies the Extractor protocol.
extractor: Extractor = llm_chat_extractor
