"""LLM client module — unified interface for Gemini, OpenAI, Claude, Kimi, and DeepSeek."""

from .client import LLMClient
from .providers import (
    DEEPSEEK_DEFAULT_BASE_URL,
    DEEPSEEK_DEFAULT_MODEL,
    KIMI_DEFAULT_BASE_URL,
    KIMI_DEFAULT_MODEL,
    LLMProvider,
    resolve_deepseek_api_key,
    resolve_deepseek_base_url,
    resolve_kimi_api_key,
    resolve_kimi_base_url,
)

__all__ = [
    "LLMClient",
    "LLMProvider",
    "KIMI_DEFAULT_BASE_URL",
    "KIMI_DEFAULT_MODEL",
    "resolve_kimi_api_key",
    "resolve_kimi_base_url",
    "DEEPSEEK_DEFAULT_BASE_URL",
    "DEEPSEEK_DEFAULT_MODEL",
    "resolve_deepseek_api_key",
    "resolve_deepseek_base_url",
]
