"""
Kimi (Moonshot AI) LLM provider tests.

Kimi is OpenAI Chat Completions-compatible, so LLMClient routes it
through the OpenAI code path with a custom base_url. These tests
verify the provider wiring without any network access:

  * enum registration ("kimi" resolves to LLMProvider.KIMI)
  * env key resolution (KIMI_API_KEY canonical, MOONSHOT_API_KEY
    fallback, KIMI_API_KEY wins when both are set)
  * base_url / model defaults + KIMI_BASE_URL override
  * a mocked chat completion round-trip (simple + tool-calling paths)
"""

from types import SimpleNamespace

import pytest

from nexus_core.llm import (
    LLMClient,
    LLMProvider,
    KIMI_DEFAULT_BASE_URL,
    KIMI_DEFAULT_MODEL,
    resolve_kimi_api_key,
    resolve_kimi_base_url,
)


@pytest.fixture(autouse=True)
def _clean_kimi_env(monkeypatch):
    """Each test starts with no Kimi-related env vars set."""
    for var in ("KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


# ── Provider registration ────────────────────────────────────────────


def test_kimi_enum_registered():
    assert LLMProvider("kimi") is LLMProvider.KIMI
    assert LLMProvider.KIMI.value == "kimi"


# ── Env key resolution ───────────────────────────────────────────────


def test_resolve_key_from_kimi_api_key(monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "sk-kimi-canonical")
    assert resolve_kimi_api_key() == "sk-kimi-canonical"


def test_resolve_key_moonshot_fallback(monkeypatch):
    monkeypatch.setenv("MOONSHOT_API_KEY", "sk-moonshot-fallback")
    assert resolve_kimi_api_key() == "sk-moonshot-fallback"


def test_resolve_key_kimi_wins_over_moonshot(monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "sk-kimi")
    monkeypatch.setenv("MOONSHOT_API_KEY", "sk-moonshot")
    assert resolve_kimi_api_key() == "sk-kimi"


def test_resolve_key_empty_when_unset():
    assert resolve_kimi_api_key() == ""


# ── base_url / model defaults ────────────────────────────────────────


def test_base_url_default():
    assert resolve_kimi_base_url() == KIMI_DEFAULT_BASE_URL
    assert KIMI_DEFAULT_BASE_URL == "https://api.moonshot.ai/v1"


def test_base_url_env_override(monkeypatch):
    monkeypatch.setenv("KIMI_BASE_URL", "https://kimi-proxy.internal/v1")
    assert resolve_kimi_base_url() == "https://kimi-proxy.internal/v1"


def test_client_defaults_for_kimi():
    client = LLMClient(provider=LLMProvider.KIMI, api_key="sk-x", model="")
    assert client.model == KIMI_DEFAULT_MODEL == "kimi-k2.7-code"
    assert client.base_url == "https://api.moonshot.ai/v1"


def test_client_explicit_model_and_base_url_respected():
    client = LLMClient(
        provider=LLMProvider.KIMI,
        api_key="sk-x",
        model="kimi-k2.7-code-highspeed",
        base_url="https://kimi-proxy.internal/v1",
    )
    assert client.model == "kimi-k2.7-code-highspeed"
    assert client.base_url == "https://kimi-proxy.internal/v1"


def test_client_base_url_env_override(monkeypatch):
    monkeypatch.setenv("KIMI_BASE_URL", "https://kimi-proxy.internal/v1")
    client = LLMClient(provider=LLMProvider.KIMI, api_key="sk-x", model="")
    assert client.base_url == "https://kimi-proxy.internal/v1"


def test_client_resolves_env_key_when_not_passed(monkeypatch):
    monkeypatch.setenv("MOONSHOT_API_KEY", "sk-from-env")
    client = LLMClient(provider=LLMProvider.KIMI, api_key="", model="")
    assert client.api_key == "sk-from-env"


def test_other_providers_unaffected():
    client = LLMClient(provider=LLMProvider.OPENAI, api_key="sk-x", model="gpt-4o")
    assert client.model == "gpt-4o"
    assert client.base_url is None


def test_ensure_client_builds_openai_compatible_client():
    """provider=kimi instantiates an AsyncOpenAI client pointed at the
    Moonshot endpoint (no network happens at construction time)."""
    openai = pytest.importorskip("openai")
    client = LLMClient(provider=LLMProvider.KIMI, api_key="sk-x", model="")
    client._ensure_client()
    assert isinstance(client._client, openai.AsyncOpenAI)
    assert str(client._client.base_url).rstrip("/") == "https://api.moonshot.ai/v1"


# ── Mocked chat completion round-trips ───────────────────────────────


class _FakeCompletions:
    """Records create() kwargs and pops canned responses in order."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._responses.pop(0)


class _FakeOpenAIClient:
    def __init__(self, responses):
        self.chat = SimpleNamespace(completions=_FakeCompletions(responses))


def _text_response(text, finish_reason="stop"):
    return SimpleNamespace(
        choices=[SimpleNamespace(
            message=SimpleNamespace(content=text, tool_calls=None),
            finish_reason=finish_reason,
        )],
    )


async def test_kimi_chat_round_trip_mocked():
    client = LLMClient(provider=LLMProvider.KIMI, api_key="sk-x", model="")
    fake = _FakeOpenAIClient([_text_response("pong")])
    client._client = fake  # short-circuit _ensure_client

    reply = await client.chat(
        messages=[{"role": "user", "content": "ping"}],
        system="You are a test.",
    )

    assert reply == "pong"
    (call,) = fake.chat.completions.calls
    assert call["model"] == "kimi-k2.7-code"
    # System prompt folded into the OpenAI-style message list.
    assert call["messages"][0] == {"role": "system", "content": "You are a test."}
    assert call["messages"][-1] == {"role": "user", "content": "ping"}


async def test_kimi_tool_calling_round_trip_mocked():
    """Kimi rides the OpenAI tool-calling path: tool_calls in the
    response are normalised into the unified {id, name, arguments}
    shape the SDK tool loop consumes."""
    tool_call_response = SimpleNamespace(
        choices=[SimpleNamespace(
            message=SimpleNamespace(
                content=None,
                tool_calls=[SimpleNamespace(
                    id="call_abc",
                    function=SimpleNamespace(
                        name="echo",
                        arguments='{"text": "hi"}',
                    ),
                )],
            ),
            finish_reason="tool_calls",
        )],
    )
    client = LLMClient(provider=LLMProvider.KIMI, api_key="sk-x", model="")
    fake = _FakeOpenAIClient([tool_call_response])
    client._client = fake

    tool_defs = [{
        "name": "echo",
        "description": "Echo text back.",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    }]
    result = await client._call_with_tools(
        messages=[{"role": "user", "content": "run echo"}],
        system="",
        temperature=0.0,
        max_tokens=64,
        tool_defs=tool_defs,
    )

    assert result["tool_calls"] == [
        {"id": "call_abc", "name": "echo", "arguments": {"text": "hi"}},
    ]
    (call,) = fake.chat.completions.calls
    assert call["model"] == "kimi-k2.7-code"
    assert call["tools"][0]["function"]["name"] == "echo"
