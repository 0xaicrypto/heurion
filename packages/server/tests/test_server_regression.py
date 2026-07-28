"""Regression tests for rune-server.

Covers: auth, LLM gateway format, sync endpoints, config.
All tests use mocked LLM calls — no real API keys needed.
"""
import json
import pytest
from unittest.mock import patch, AsyncMock


# ── Health Check ──────────────────────────────────────────────────────


class TestHealthCheck:
    def test_health_endpoint(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
        assert "timestamp" in data
        assert "version" in data


# ── Auth: Register ────────────────────────────────────────────────────


class TestAuthRegister:
    def test_register_returns_jwt(self, client):
        resp = client.post("/api/v1/auth/register", json={"username": "TestUser", "password": "Str0ng-Pass-123"})
        assert resp.status_code == 201
        data = resp.json()
        assert "jwt_token" in data
        assert "user_id" in data
        assert len(data["jwt_token"]) > 20

    def test_register_empty_name_rejected(self, client):
        resp = client.post("/api/v1/auth/register", json={"username": "", "password": "Str0ng-Pass-123"})
        assert resp.status_code == 422

    def test_register_missing_name_rejected(self, client):
        resp = client.post("/api/v1/auth/register", json={})
        assert resp.status_code == 422

    def test_register_twice_same_name_conflicts(self, client):
        # Usernames are the login key now — duplicates are rejected.
        r1 = client.post("/api/v1/auth/register", json={"username": "Alice", "password": "Str0ng-Pass-123"})
        r2 = client.post("/api/v1/auth/register", json={"username": "Alice", "password": "Str0ng-Pass-123"})
        assert r1.status_code == 201
        assert r2.status_code == 409


# ── Auth: JWT Validation ──────────────────────────────────────────────


class TestAuthJWT:
    def _get_token(self, client):
        resp = client.post("/api/v1/auth/register", json={"username": "JWTUser", "password": "Str0ng-Pass-123"})
        return resp.json()["jwt_token"]

    def test_protected_endpoint_without_token_returns_401(self, client):
        resp = client.post("/api/v1/llm/chat", json={
            "messages": [{"role": "user", "content": "hi"}]
        })
        assert resp.status_code in (401, 403)

    def test_protected_endpoint_with_invalid_token_returns_401(self, client):
        resp = client.post(
            "/api/v1/llm/chat",
            json={"messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": "Bearer invalid-token-here"},
        )
        assert resp.status_code in (401, 403)

    def test_protected_endpoint_with_valid_token_accepted(self, client):
        token = self._get_token(client)
        # This will fail at LLM call (mocked), but should NOT fail at auth
        with patch("nexus_server.llm_gateway.call_llm", new_callable=AsyncMock,
                    return_value=("Hello!", "gemini-2.5-flash", "stop", [])):
            resp = client.post(
                "/api/v1/llm/chat",
                json={"messages": [{"role": "user", "content": "hi"}]},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200


# ── LLM Gateway: Request Format ──────────────────────────────────────


class TestLLMGateway:
    def _get_token(self, client):
        resp = client.post("/api/v1/auth/register", json={"username": "LLMUser", "password": "Str0ng-Pass-123"})
        return resp.json()["jwt_token"]

    def test_chat_returns_correct_format(self, client):
        token = self._get_token(client)
        with patch("nexus_server.llm_gateway.call_llm", new_callable=AsyncMock,
                    return_value=("Hello world!", "gemini-2.5-flash", "stop", [])):
            resp = client.post(
                "/api/v1/llm/chat",
                json={
                    "messages": [{"role": "user", "content": "hello"}],
                    "system_prompt": "You are helpful.",
                },
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["role"] == "assistant"
            assert data["content"] == "Hello world!"
            assert data["model"] == "gemini-2.5-flash"
            assert "tool_calls_executed" in data

    def test_chat_with_tool_calls_executed(self, client):
        token = self._get_token(client)
        # First call returns tool call, second returns final answer
        call_count = 0

        async def mock_call_llm(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return ("", "gemini", "tool_calls", [
                    {"id": "1", "name": "web_search", "arguments": {"query": "test"}}
                ])
            return ("Search result: found it!", "gemini", "stop", [])

        with patch("nexus_server.llm_gateway.call_llm", side_effect=mock_call_llm), \
             patch("nexus_server.llm_gateway.execute_tool", new_callable=AsyncMock,
                   return_value="Mock search result"):
            resp = client.post(
                "/api/v1/llm/chat",
                json={"messages": [{"role": "user", "content": "search something"}]},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert "web_search" in data["tool_calls_executed"]

    def test_chat_invalid_role_rejected(self, client):
        token = self._get_token(client)
        resp = client.post(
            "/api/v1/llm/chat",
            json={"messages": [{"role": "admin", "content": "hi"}]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422

    def test_chat_empty_messages_rejected(self, client):
        token = self._get_token(client)
        resp = client.post(
            "/api/v1/llm/chat",
            json={"messages": []},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422


# ── Sync Endpoints ────────────────────────────────────────────────────




# ── Config ────────────────────────────────────────────────────────────


class TestConfig:
    def test_config_loads_env_vars(self):
        from nexus_server.config import get_config
        cfg = get_config()
        assert cfg.SERVER_SECRET == "test-secret-key"
        assert cfg.GEMINI_API_KEY == "fake-key-for-testing"

    def test_config_has_defaults(self):
        from nexus_server.config import get_config
        cfg = get_config()
        assert cfg.SERVER_PORT in (8001, 8000)
        assert cfg.JWT_ALGORITHM == "HS256"


# ── Monorepo Integration ─────────────────────────────────────────────


class TestMonorepoIntegration:
    """Verify monorepo refactoring didn't break imports."""

    def test_sdk_llm_client_importable(self):
        from nexus_core.llm import LLMClient
        assert LLMClient is not None

    def test_sdk_tools_importable(self):
        from nexus_core.tools import BaseTool, WebSearchTool, ReadUploadedFileTool
        assert BaseTool is not None

    def test_sdk_memory_importable(self):
        from nexus_core.memory import EventLog, CuratedMemory
        assert EventLog is not None

    def test_server_does_not_eagerly_import_nexus_framework(self):
        """Server should not eagerly import the Nexus agent framework.

        Post-S2 server CAN import Nexus — twin_manager._create_twin
        does ``from nexus.twin import DigitalTwin`` lazily on first
        chat. But the import is **deferred**: importing the server's
        always-on modules (auth, llm_gateway, agent_state) must not pull
        the ``nexus`` framework package into ``sys.modules``. Otherwise
        dev environments without ``nexus`` installed couldn't even start
        the server.

        Phase D rename note: the ``nexus`` package (was ``rune_twin``)
        has the same top-level name as a substring of ``nexus_server``
        and ``nexus_core``. Match the framework package precisely:
        ``name == "nexus"`` or starts with ``"nexus."`` (a submodule)."""
        import sys

        def _is_framework(m: str) -> bool:
            return m == "nexus" or m.startswith("nexus.")

        # Drop any prior framework import from earlier tests.
        for m in list(sys.modules):
            if _is_framework(m):
                sys.modules.pop(m, None)

        import nexus_server.llm_gateway as gw  # noqa: F401
        import nexus_server.auth as auth_mod  # noqa: F401
        import nexus_server.agent_state as agent_state_mod  # noqa: F401

        framework_modules = [m for m in sys.modules if _is_framework(m)]
        assert len(framework_modules) == 0, (
            f"Server eagerly imported Nexus framework modules: {framework_modules}"
        )


# ── Server .env Loading ───────────────────────────────────────────────


class TestEnvLoading:
    def test_dotenv_loaded_gemini_key(self):
        """Verify .env values are loaded into os.environ."""
        import os
        assert os.environ.get("GEMINI_API_KEY") == "fake-key-for-testing"

    def test_dotenv_does_not_override_existing(self):
        """Existing env vars should not be overridden by .env."""
        import os
        os.environ["TEST_EXISTING_VAR"] = "original"
        # _load_dotenv won't override since key already exists
        assert os.environ["TEST_EXISTING_VAR"] == "original"


# ── LLM Gateway: Tool Loop ───────────────────────────────────────────




# ── User Registration Persistence ─────────────────────────────────────


class TestUserPersistence:
    def test_registered_user_persists_across_requests(self, client):
        """User data should persist in the database."""
        reg = client.post("/api/v1/auth/register", json={"username": "PersistUser", "password": "Str0ng-Pass-123"})
        user_id = reg.json()["user_id"]

        # Verify the user can log back in with the same credentials
        resp = client.post("/api/v1/auth/login", json={
            "username": "PersistUser",
            "password": "Str0ng-Pass-123",
        })
        assert resp.status_code == 200
        assert resp.json()["user_id"] == user_id

    def test_multiple_users_isolated(self, client):
        """Different users get different JWT tokens."""
        r1 = client.post("/api/v1/auth/register", json={"username": "User1", "password": "Str0ng-Pass-123"})
        r2 = client.post("/api/v1/auth/register", json={"username": "User2", "password": "Str0ng-Pass-123"})
        assert r1.json()["jwt_token"] != r2.json()["jwt_token"]
        assert r1.json()["user_id"] != r2.json()["user_id"]


# ── Sync roundtrip: retired in Phase B (was push then pull) ───────────
# Whole class deleted — /sync/push and /sync/pull return 404. See
# TestSyncEndpointsRetired above for the 404 + ImportError contract.


# ── LLM Chat: attachments fold-in ─────────────────────────────────────


class TestLLMChatAttachments:
    """Verify the /llm/chat endpoint handles file attachments correctly:
    - Text content is folded into the last user message.
    - Binary-only attachments produce a metadata note.
    - Total payload over MAX_ATTACHMENT_BYTES_TOTAL → 413.
    - Empty/missing attachments behave exactly like before (regression).
    """

    def _get_token(self, client):
        resp = client.post("/api/v1/auth/register", json={"username": "AttUser", "password": "Str0ng-Pass-123"})
        return resp.json()["jwt_token"]

    def _patched_call_llm(self, captured: list):
        """Build a stub for llm_gateway.call_llm that records what messages
        the gateway would have sent to the model and returns a canned reply."""
        from unittest.mock import AsyncMock

        async def _fake(messages, system_prompt, model, temperature, max_tokens, tools):
            captured.append([dict(m) for m in messages])
            return ("ok", "stub-model", "stop", [])

        return AsyncMock(side_effect=_fake)

    # NOTE: pre-distill fold tests removed. The handler now ALWAYS distills
    # attachments first and folds the SUMMARY into the user message. The
    # tests below (test_text_attachment_is_distilled_and_event_persisted,
    # test_distill_falls_back_when_llm_errors, etc.) cover the new contract.

    def test_attachment_over_total_cap_returns_413(self, client, monkeypatch):
        """The cap is now 100 MB by default, but the per-test override
        below temporarily drops it to 1 KB so we can trigger 413 without
        actually shoveling 100 MB through TestClient."""
        from nexus_server import llm_gateway as gw
        monkeypatch.setattr(gw, "MAX_ATTACHMENT_BYTES_TOTAL", 1024)

        token = self._get_token(client)
        chunk = "x" * 800
        resp = client.post(
            "/api/v1/llm/chat",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "attachments": [
                    {"name": "a.txt", "mime": "text/plain",
                     "size_bytes": len(chunk), "content_text": chunk},
                    {"name": "b.txt", "mime": "text/plain",
                     "size_bytes": len(chunk), "content_text": chunk},
                ],
            },
        )
        assert resp.status_code == 413

    def test_text_attachment_is_distilled_and_summary_returned(self, client):
        """When a text attachment is sent, the server distills it via the
        LLM (mocked here), folds the SUMMARY into the user message (not
        the raw text), and returns the summary on the chat response.

        Phase B: persistence to ``sync_events`` was removed alongside
        the table itself. The summary now rides back inline only;
        ``sync_id`` is always None."""
        from unittest.mock import patch

        token = self._get_token(client)

        # Two LLM calls per turn-with-attachment: one for distill, one
        # for the actual chat. Track who called what.
        calls = []

        async def _fake_llm(messages, system_prompt, model, temp, max_tokens, tools):
            calls.append({"system": system_prompt, "messages": messages})
            if system_prompt and "file summarizer" in system_prompt:
                return ("Distilled: this file is about widgets.",
                        "stub-distill", "stop", [])
            return ("noted", "stub-chat", "stop", [])

        with patch("nexus_server.llm_gateway.call_llm", side_effect=_fake_llm):
            resp = client.post(
                "/api/v1/llm/chat",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [{"role": "user",
                                  "content": "what's in foo.txt?"}],
                    "attachments": [{
                        "name": "foo.txt", "mime": "text/plain",
                        "size_bytes": 11,
                        "content_text": "hello world",
                    }],
                },
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Two LLM calls happened — distill THEN chat
        assert len(calls) == 2
        assert "file summarizer" in calls[0]["system"]
        # The chat call sees the SUMMARY in the folded user message,
        # NOT the raw "hello world" content
        chat_msgs = calls[1]["messages"]
        last_user = chat_msgs[-1]["content"]
        assert "Distilled: this file is about widgets." in last_user
        assert "hello world" not in last_user

        # Response carries one summary inline. sync_id is None now —
        # see Phase B docstring above for why.
        assert len(body["attachment_summaries"]) == 1
        s = body["attachment_summaries"][0]
        assert s["name"] == "foo.txt"
        assert "widgets" in s["summary"]
        assert s["sync_id"] is None

    def test_distill_falls_back_when_llm_errors(self, client):
        """LLM raising during distill should NOT 500 the request — we
        fall back to a head excerpt, mark source as '+fallback', and
        keep going."""
        from unittest.mock import patch

        token = self._get_token(client)

        async def _fake_llm(messages, system_prompt, model, temp, max_tokens, tools):
            if system_prompt and "file summarizer" in system_prompt:
                raise RuntimeError("LLM provider down")
            return ("ok", "stub-chat", "stop", [])

        with patch("nexus_server.llm_gateway.call_llm", side_effect=_fake_llm):
            resp = client.post(
                "/api/v1/llm/chat",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [{"role": "user", "content": "summarize"}],
                    "attachments": [{
                        "name": "report.txt", "mime": "text/plain",
                        "size_bytes": 13, "content_text": "important data",
                    }],
                },
            )

        assert resp.status_code == 200
        s = resp.json()["attachment_summaries"][0]
        assert "fallback" in s["source"]
        assert "important data" in s["summary"]

    def test_binary_attachment_distill_uses_metadata_stub(self, client):
        """Pure binary (no content_text, opaque base64) should still
        produce a summary — derived from filename + mime + size."""
        from unittest.mock import patch
        import base64

        token = self._get_token(client)

        async def _fake_llm(messages, system_prompt, model, temp, max_tokens, tools):
            if system_prompt and "file summarizer" in system_prompt:
                # Verify the distiller saw a binary-stub note
                user_msg = messages[-1]["content"]
                assert "binary" in user_msg.lower() or "thing.bin" in user_msg
                return ("Stub summary for binary file thing.bin",
                        "stub", "stop", [])
            return ("noted", "stub", "stop", [])

        # Truly non-UTF-8 bytes: \xff alone isn't a valid lead byte
        b64 = base64.b64encode(b"\xff\xfe\xfd\xfc\xfb").decode()
        with patch("nexus_server.llm_gateway.call_llm", side_effect=_fake_llm):
            resp = client.post(
                "/api/v1/llm/chat",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [{"role": "user", "content": "what is this?"}],
                    "attachments": [{
                        "name": "thing.bin",
                        "mime": "application/octet-stream",
                        "size_bytes": 5,
                        "content_base64": b64,
                    }],
                },
            )
        assert resp.status_code == 200
        s = resp.json()["attachment_summaries"][0]
        assert s["source"] in ("binary-stub", "binary-stub+fallback")
        assert "thing.bin" in s["summary"]

    def test_large_text_attachment_is_distilled_to_summary(self, client):
        """Whatever the user attaches — small text, big text, binary —
        the model sees the DISTILLED summary, never the raw bytes.
        This is what makes 100MB attachments feasible without blowing
        the model's context window."""
        from unittest.mock import patch
        token = self._get_token(client)
        big_text = "A" * 500_000  # 500 KB of A's

        async def _fake(messages, system_prompt, model, temp, max_tokens, tools):
            if system_prompt and "file summarizer" in system_prompt:
                return ("Summary: a 500KB block of letter A.",
                        "stub", "stop", [])
            # Capture what the chat-leg saw
            _fake.last_chat_messages = list(messages)
            return ("noted", "stub", "stop", [])
        _fake.last_chat_messages = None

        with patch("nexus_server.llm_gateway.call_llm", side_effect=_fake):
            resp = client.post(
                "/api/v1/llm/chat",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [{"role": "user", "content": "summarize"}],
                    "attachments": [{
                        "name": "big.txt", "mime": "text/plain",
                        "size_bytes": len(big_text),
                        "content_text": big_text,
                    }],
                },
            )

        assert resp.status_code == 200
        last_user_to_chat = _fake.last_chat_messages[-1]["content"]
        # Summary is folded
        assert "Summary: a 500KB block of letter A." in last_user_to_chat
        # Raw 500KB never reaches the chat leg
        assert big_text not in last_user_to_chat
        assert "AAAAA" * 100 not in last_user_to_chat

    def test_empty_attachments_field_is_backward_compatible(self, client):
        """Regression: chat with no attachments behaves like before."""
        from unittest.mock import patch
        captured = []
        token = self._get_token(client)

        with patch("nexus_server.llm_gateway.call_llm",
                   side_effect=self._patched_call_llm(captured).side_effect):
            resp = client.post(
                "/api/v1/llm/chat",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [{"role": "user", "content": "hi"}],
                    # no "attachments" key at all
                },
            )

        assert resp.status_code == 200
        last_user = captured[0][-1]
        assert last_user["content"] == "hi"  # untouched


# ── Chain Proxy: real path + graceful fallback ────────────────────────




# ── Sync Anchor: BSC anchoring pipeline ──────────────────────────────






