"""Router-level tests for the v2 email endpoints.

  POST /api/v1/email/send
  GET  /api/v1/email/transport

These tests use the FastAPI route functions directly (no TestClient)
because the sandbox can't actually open SMTP / HTTPS connections.
The relay / SMTP layers are stubbed via monkeypatch.setattr on
``email_send`` — the only thing the router itself owns is:

  - Pydantic request validation (empty to / oversize body / etc.).
  - The 503 short-circuit when nothing is configured.
  - Forwarding the authenticated user_id into ``send_email_async``.
  - Mapping the SendResult dataclass back to JSON.
"""
from __future__ import annotations

import asyncio
import pathlib
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from nexus_server import email_router, email_send  # noqa: E402


# ─────────────────────────────────────────────────────────────────────
# Helpers — invoke routes without a real TestClient (no auth wiring,
# no http.client). We pass user_id directly to bypass Depends.
# ─────────────────────────────────────────────────────────────────────


def _clear_email_env(monkeypatch):
    for k in (
        "NEXUS_RELAY_URL", "NEXUS_RELAY_API_KEY",
        "NEXUS_SMTP_HOST", "NEXUS_SMTP_PORT", "NEXUS_SMTP_USER",
        "NEXUS_SMTP_PASSWORD", "NEXUS_SMTP_FROM",
        "NEXUS_SMTP_ALLOWED_RECIPIENTS", "NEXUS_SMTP_BUNDLED_CREDS",
    ):
        monkeypatch.delenv(k, raising=False)


# ─────────────────────────────────────────────────────────────────────
# GET /transport
# ─────────────────────────────────────────────────────────────────────


def test_transport_endpoint_neither_configured(monkeypatch):
    _clear_email_env(monkeypatch)
    r = asyncio.run(email_router.get_transport_status(_=""))
    assert r.configured is False
    assert r.relay_configured is False
    assert r.smtp_configured is False
    assert r.relay_url_host == ""
    assert r.default_from == ""


def test_transport_endpoint_relay_configured(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.nexus.io")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "k")
    r = asyncio.run(email_router.get_transport_status(_=""))
    assert r.configured is True
    assert r.relay_configured is True
    assert r.smtp_configured is False
    assert r.relay_url_host == "relay.nexus.io"


def test_transport_endpoint_smtp_configured(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.x.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")
    monkeypatch.setenv("NEXUS_SMTP_FROM", "ops@x.com")
    monkeypatch.setenv("NEXUS_SMTP_ALLOWED_RECIPIENTS", "a@x.com, b@x.com")
    r = asyncio.run(email_router.get_transport_status(_=""))
    assert r.configured is True
    assert r.relay_configured is False
    assert r.smtp_configured is True
    assert r.default_from == "ops@x.com"
    assert r.allowed_recipients == ["a@x.com", "b@x.com"]


def test_transport_endpoint_re_reads_env_each_call(monkeypatch):
    """No caching — the dialog can poll this every open and pick up
    new creds the operator dropped into $RUNE_HOME/.env. Without this
    contract the medic would have to restart the sidecar to recover
    from a typo'd relay URL."""
    _clear_email_env(monkeypatch)
    r1 = asyncio.run(email_router.get_transport_status(_=""))
    assert r1.configured is False

    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.nexus.io")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "k")
    r2 = asyncio.run(email_router.get_transport_status(_=""))
    assert r2.configured is True


# ─────────────────────────────────────────────────────────────────────
# POST /send
# ─────────────────────────────────────────────────────────────────────


def test_send_endpoint_503_when_no_transport_configured(monkeypatch):
    _clear_email_env(monkeypatch)
    req = email_router.SendEmailRequest(
        to=["a@x.com"], subject="s", body="b",
    )
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(email_router.send_email(req, user_id="u1"))
    assert exc_info.value.status_code == 503
    assert "not configured" in exc_info.value.detail.lower()


def test_send_endpoint_forwards_user_id_into_relay_payload(monkeypatch):
    """The relay keys its audit log on nexus_user_id. If the router
    drops the dependency-injected user_id on the floor the relay
    can't attribute the send to a medic — and per-user rate limits
    would all bucket into "anonymous" instead of per-medic."""
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.nexus.io")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "k")

    captured = {}

    async def fake_post(url, key, payload):
        captured.update(payload)
        return email_send.SendResult(
            ok=True, transport="relay", status_code=200,
            message="ok", sent_to=[payload["to"]],
        )

    monkeypatch.setattr(email_send, "_post_to_relay", fake_post)

    req = email_router.SendEmailRequest(
        to=["dr@hospital.org"],
        subject="CT findings",
        body="please review",
    )
    resp = asyncio.run(email_router.send_email(req, user_id="medic-jane"))
    assert resp.ok is True
    assert resp.transport == "relay"
    assert captured["nexus_user_id"] == "medic-jane"
    assert captured["to"] == "dr@hospital.org"
    assert captured["subject"] == "CT findings"


def test_send_endpoint_returns_200_with_ok_false_on_send_failure(monkeypatch):
    """A relay rejection (rate-limited, blocked, etc.) must NOT raise
    HTTPException — UI relies on a 200 + ok=false envelope so it can
    show the relay's verbatim error in the inline status strip
    without parsing a 4xx body."""
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.nexus.io")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "k")

    async def fake_post(*a, **k):
        return email_send.SendResult(
            ok=False, transport="relay", status_code=429,
            message="rate limit hit · 0 sends remaining today",
        )

    monkeypatch.setattr(email_send, "_post_to_relay", fake_post)

    req = email_router.SendEmailRequest(
        to=["dr@hospital.org"], subject="s", body="b",
    )
    resp = asyncio.run(email_router.send_email(req, user_id="u1"))
    assert resp.ok is False
    assert resp.transport == "relay"
    assert resp.status_code == 429
    assert "rate limit hit" in resp.message


def test_send_endpoint_rejects_empty_required_fields():
    """Pydantic should catch this client-side — but if the client
    pokes the API directly we still want loud failures."""
    with pytest.raises(Exception):
        email_router.SendEmailRequest(to=[], subject="s", body="b")
    with pytest.raises(Exception):
        email_router.SendEmailRequest(to=["a@x.com"], subject="", body="b")
    with pytest.raises(Exception):
        email_router.SendEmailRequest(to=["a@x.com"], subject="s", body="")


def test_send_endpoint_returns_smtp_transport_when_relay_absent(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.x.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")

    def fake_smtp_sync(cfg, to, cc, subject, body):
        return email_send.SendResult(
            ok=True, transport="smtp",
            message=f"sent to {','.join(to)}", sent_to=list(to),
        )

    monkeypatch.setattr(email_send, "_send_smtp_sync", fake_smtp_sync)

    req = email_router.SendEmailRequest(
        to=["dr@hospital.org"],
        subject="follow up",
        body="see attached",
    )
    resp = asyncio.run(email_router.send_email(req, user_id="u1"))
    assert resp.ok is True
    assert resp.transport == "smtp"
    assert "dr@hospital.org" in resp.message


# ─────────────────────────────────────────────────────────────────────
# Source-level guards — make sure the router is wired into main.py
# (catches regressions where someone deletes the include_router call)
# ─────────────────────────────────────────────────────────────────────


def test_email_router_wired_into_main():
    main_src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "main.py"
    ).read_text()
    # Strip comments so this isn't satisfied by the docstring alone.
    code_only = "\n".join(
        line.split("#", 1)[0] for line in main_src.splitlines()
    )
    assert "from nexus_server import email_router" in code_only, (
        "main.py no longer imports email_router — the email endpoints "
        "won't be reachable until include_router is called."
    )
    assert "email_router" in code_only and "include_router" in code_only
    # And the prefix is what the desktop client expects.
    router_src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "email_router.py"
    ).read_text()
    assert 'prefix="/api/v1/email"' in router_src, (
        "email_router prefix changed — desktop api-client expects "
        "/api/v1/email/send + /api/v1/email/transport."
    )
