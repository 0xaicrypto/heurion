"""Robust JSON parsing for LLM output.

Handles common LLM output issues:
  - Empty / whitespace-only responses
  - Markdown code fences (```json ... ```)
  - Trailing commas before ] or }
  - Prose before/after JSON (extracts outermost [...] or {...})
  - Unterminated strings (truncated LLM output)

Usage:
    from nexus_core.utils import robust_json_parse

    data = robust_json_parse(llm_output)  # returns dict or list
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def extract_balanced(text: str, open_ch: str, close_ch: str) -> str | None:
    """Extract the outermost balanced bracket pair from text.

    Returns the substring (including brackets) or None if not found.
    """
    start = text.find(open_ch)
    if start < 0:
        return None

    depth = 0
    for i in range(start, len(text)):
        if text[i] == open_ch:
            depth += 1
        elif text[i] == close_ch:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]

    # No matching close bracket — return from open to end
    # (caller will try to parse/repair this truncated fragment)
    return text[start:]


def robust_json_parse(raw: str) -> Any:
    """Parse JSON with fallback repairs for common LLM output issues.

    Handles:
      - Empty / whitespace-only responses
      - Markdown code fences (```json ... ```)
      - Trailing commas before ] or }
      - Prose before/after JSON (extracts outermost [...] or {...})
      - Unterminated strings (truncated LLM output)
    """
    text = raw.strip()

    # Empty or whitespace-only
    if not text:
        raise json.JSONDecodeError("Empty input", "", 0)

    # Strip code fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if "```" in text:
            text = text.rsplit("```", 1)[0]
        text = text.strip()

    # First attempt: vanilla parse
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        logger.debug("vanilla JSON parse failed: %s", e)

    # Repair: remove trailing commas before ] or }
    repaired = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError as e:
        logger.debug("trailing-comma repair parse failed: %s", e)

    # Repair: find outermost balanced bracket pair
    pairs = [("[", "]"), ("{", "}")]
    arr_pos = repaired.find("[")
    obj_pos = repaired.find("{")
    if obj_pos >= 0 and (arr_pos < 0 or obj_pos < arr_pos):
        pairs = [("{", "}"), ("[", "]")]

    for open_ch, close_ch in pairs:
        candidate = extract_balanced(repaired, open_ch, close_ch)
        if candidate is None:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as e:
            logger.debug("balanced-extract parse failed: %s", e)

        # Last resort for arrays: truncate at the last complete object
        if open_ch == "[":
            last_close = candidate.rfind("}")
            if last_close > 0:
                truncated = candidate[:last_close + 1] + "]"
                try:
                    return json.loads(truncated)
                except json.JSONDecodeError as e:
                    logger.debug("array truncation parse failed: %s", e)

        # Last resort for objects: find last complete array/value and close
        if open_ch == "{":
            last_arr_close = candidate.rfind("]")
            if last_arr_close > 0:
                truncated = candidate[:last_arr_close + 1] + "}"
                try:
                    return json.loads(truncated)
                except json.JSONDecodeError as e:
                    logger.debug("object truncation parse failed: %s", e)

            last_obj_close = candidate.rfind("}")
            if last_obj_close > 1:
                truncated = candidate[:last_obj_close + 1] + "]}"
                try:
                    return json.loads(truncated)
                except json.JSONDecodeError as e:
                    logger.debug("object close-out parse failed: %s", e)

    raise json.JSONDecodeError("Could not repair JSON", text, 0)
