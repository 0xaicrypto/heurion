"""LLM provider enumeration."""

import os
from enum import Enum


class LLMProvider(Enum):
    """Supported LLM providers."""
    GEMINI = "gemini"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    # Moonshot AI Kimi — OpenAI Chat Completions-compatible API served
    # from https://api.moonshot.ai/v1. Reuses the OpenAI code path in
    # LLMClient with a custom base_url.
    KIMI = "kimi"
    # DeepSeek — OpenAI-compatible Chat Completions API served from
    # https://api.deepseek.com/v1.
    DEEPSEEK = "deepseek"


# ── Kimi (Moonshot AI) defaults ─────────────────────────────────────
# Kimi exposes an OpenAI-compatible endpoint; only the base_url, model
# ids, and key env vars differ from stock OpenAI.
KIMI_DEFAULT_BASE_URL = "https://api.moonshot.ai/v1"
KIMI_DEFAULT_MODEL = "kimi-k2.7-code"


# ── DeepSeek defaults ───────────────────────────────────────────────
DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEEPSEEK_DEFAULT_MODEL = "deepseek-chat"


def resolve_kimi_api_key() -> str:
    """Resolve the Kimi API key from the environment.

    ``KIMI_API_KEY`` is canonical; ``MOONSHOT_API_KEY`` (the name used
    by Moonshot's own docs / SDK examples) is accepted as a fallback.
    Returns "" when neither is set.
    """
    return (
        os.environ.get("KIMI_API_KEY", "").strip()
        or os.environ.get("MOONSHOT_API_KEY", "").strip()
    )


def resolve_kimi_base_url() -> str:
    """Resolve the Kimi endpoint: ``KIMI_BASE_URL`` env override, else
    the public Moonshot endpoint."""
    return os.environ.get("KIMI_BASE_URL", "").strip() or KIMI_DEFAULT_BASE_URL


def resolve_deepseek_api_key() -> str:
    """Resolve the DeepSeek API key from the environment."""
    return os.environ.get("DEEPSEEK_API_KEY", "").strip()


def resolve_deepseek_base_url() -> str:
    """Resolve the DeepSeek endpoint: ``DEEPSEEK_BASE_URL`` env override,
    else the public DeepSeek endpoint."""
    return os.environ.get("DEEPSEEK_BASE_URL", "").strip() or DEEPSEEK_DEFAULT_BASE_URL
