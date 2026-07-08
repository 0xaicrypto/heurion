"""Unit tests for ``email_send`` — the transport layer ported from
v1's ``tools_calendar.py`` SendEmailNowTool.

What we lock down here
══════════════════════

  1. Env-probe precedence
     • _live_relay returns None when either URL or KEY is missing.
     • _live_relay rejects ``REPLACE_WITH_*`` placeholders so the
       bundled .env template never accidentally points at nowhere.
     • _live_smtp_config returns None when host/user/password aren't
       all populated; also rejects ``REPLACE_WITH_*`` placeholders.
     • _live_smtp_config respects NEXUS_SMTP_PORT default (587) and
       handles non-numeric port without crashing.
     • Bundled-creds flag is read from NEXUS_SMTP_BUNDLED_CREDS=1 and
       the allow-list parses comma-separated NEXUS_SMTP_ALLOWED_RECIPIENTS.

  2. Recipient allow-list
     • Empty allow-list means no restriction.
     • Non-empty allow-list rejects out-of-list addresses; the error
       string names the disallowed recipients so the caller can show
       them to the medic without a second round-trip.
     • Bundled creds + empty allow-list = REFUSE (v1 #115).

  3. Address sanity check
     • Garbage strings rejected before any SMTP/relay round-trip.
     • Simple form ``a@b.c`` accepted.

  4. send_email_async orchestration
     • Routes to relay when relay env set (even if SMTP also set).
     • Routes to SMTP when only SMTP set.
     • Returns transport='none' error when neither is set.
     • user_id forwarded into relay payload (audit-log key).
     • Empty to/subject/body refused with field name in error.
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from nexus_server import email_send  # noqa: E402


# ─────────────────────────────────────────────────────────────────────
# _live_relay
# ─────────────────────────────────────────────────────────────────────


def _clear_email_env(monkeypatch):
    """Wipe every email-related env var so each test starts blank."""
    for k in (
        "NEXUS_RELAY_URL", "NEXUS_RELAY_API_KEY",
        "NEXUS_SMTP_HOST", "NEXUS_SMTP_PORT", "NEXUS_SMTP_USER",
        "NEXUS_SMTP_PASSWORD", "NEXUS_SMTP_FROM",
        "NEXUS_SMTP_ALLOWED_RECIPIENTS", "NEXUS_SMTP_BUNDLED_CREDS",
    ):
        monkeypatch.delenv(k, raising=False)


def test_relay_probe_returns_none_without_env(monkeypatch):
    _clear_email_env(monkeypatch)
    assert email_send._live_relay() is None


def test_relay_probe_returns_none_when_url_only(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.example.com")
    # API key still unset.
    assert email_send._live_relay() is None


def test_relay_probe_returns_none_when_key_only(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "k-abc")
    assert email_send._live_relay() is None


def test_relay_probe_rejects_placeholder_sentinels(monkeypatch):
    """REPLACE_WITH_* in either field means the bundled .env template
    hasn't been replaced yet — caller should treat as unconfigured."""
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_URL", "https://REPLACE_WITH_RELAY/")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "real-key-123")
    assert email_send._live_relay() is None

    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.example.com")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "REPLACE_WITH_KEY")
    assert email_send._live_relay() is None


def test_relay_probe_returns_tuple_when_both_set(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.example.com")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "k-abc")
    assert email_send._live_relay() == ("https://relay.example.com", "k-abc")


# ─────────────────────────────────────────────────────────────────────
# _live_smtp_config
# ─────────────────────────────────────────────────────────────────────


def test_smtp_probe_returns_none_without_env(monkeypatch):
    _clear_email_env(monkeypatch)
    assert email_send._live_smtp_config() is None


def test_smtp_probe_returns_none_with_partial_config(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "support@nexus.io")
    # password missing
    assert email_send._live_smtp_config() is None


def test_smtp_probe_rejects_placeholder_sentinels(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "REPLACE_WITH_USER")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "real-app-password")
    assert email_send._live_smtp_config() is None


def test_smtp_probe_returns_full_config_with_defaults(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "support@nexus.io")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "app-pass-1234567")
    cfg = email_send._live_smtp_config()
    assert cfg is not None
    assert cfg["host"] == "smtp.gmail.com"
    assert cfg["port"] == 587           # default
    assert cfg["from"] == "support@nexus.io"  # falls back to USER
    assert cfg["allowed"] == []
    assert cfg["bundled"] is False


def test_smtp_probe_handles_non_numeric_port(monkeypatch):
    """A junk NEXUS_SMTP_PORT shouldn't crash the probe — fall back to 587."""
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")
    monkeypatch.setenv("NEXUS_SMTP_PORT", "not-a-number")
    cfg = email_send._live_smtp_config()
    assert cfg is not None
    assert cfg["port"] == 587


def test_smtp_probe_picks_up_bundled_and_allow_list(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")
    monkeypatch.setenv("NEXUS_SMTP_FROM", "ops@nexus.io")
    monkeypatch.setenv("NEXUS_SMTP_BUNDLED_CREDS", "1")
    monkeypatch.setenv("NEXUS_SMTP_ALLOWED_RECIPIENTS", "a@x.com, B@x.COM, c@x.com")
    cfg = email_send._live_smtp_config()
    assert cfg["bundled"] is True
    assert cfg["from"] == "ops@nexus.io"
    # Allow-list normalised lowercase, whitespace stripped.
    assert cfg["allowed"] == ["a@x.com", "b@x.com", "c@x.com"]


# ─────────────────────────────────────────────────────────────────────
# Recipient validator
# ─────────────────────────────────────────────────────────────────────


def test_empty_allowlist_permits_anything():
    assert email_send._validate_recipients(
        ["a@x.com", "b@y.com"], allowed=[],
    ) is None


def test_allowlist_rejects_out_of_list():
    err = email_send._validate_recipients(
        ["dr.smith@hospital.org", "intruder@evil.com"],
        allowed=["dr.smith@hospital.org"],
    )
    assert err is not None
    assert "intruder@evil.com" in err
    # The allow-list should be quoted back so the medic can see what
    # the operator actually allowed.
    assert "dr.smith@hospital.org" in err


def test_allowlist_case_insensitive():
    err = email_send._validate_recipients(
        ["Dr.SMITH@Hospital.Org"],
        allowed=["dr.smith@hospital.org"],
    )
    assert err is None


# ─────────────────────────────────────────────────────────────────────
# Address sanity check
# ─────────────────────────────────────────────────────────────────────


def test_address_sanity_accepts_plain_form():
    assert email_send._looks_like_email("a@b.co") is True
    assert email_send._looks_like_email("first.last+tag@sub.example.com") is True


def test_address_sanity_rejects_garbage():
    for bad in ("", "a@b", "no-at-sign", " ", "@nodomain.com", "x@x"):
        assert email_send._looks_like_email(bad) is False, bad


# ─────────────────────────────────────────────────────────────────────
# send_email_async orchestration
# ─────────────────────────────────────────────────────────────────────


def test_send_returns_none_transport_when_nothing_configured(monkeypatch):
    _clear_email_env(monkeypatch)
    r = asyncio.run(email_send.send_email_async(
        user_id="u1", to="a@b.com", subject="s", body="b",
    ))
    assert r.ok is False
    assert r.transport == "none"
    assert "not configured" in r.message.lower()


def test_send_validates_required_fields(monkeypatch):
    _clear_email_env(monkeypatch)
    # Even with no transport, the validator runs first.
    r = asyncio.run(email_send.send_email_async(
        user_id="u1", to="", subject="s", body="b",
    ))
    assert r.ok is False
    assert "to" in r.message.lower()

    r = asyncio.run(email_send.send_email_async(
        user_id="u1", to="a@b.com", subject="  ", body="b",
    ))
    assert r.ok is False
    assert "subject" in r.message.lower()

    r = asyncio.run(email_send.send_email_async(
        user_id="u1", to="a@b.com", subject="s", body="",
    ))
    assert r.ok is False
    assert "body" in r.message.lower()


def test_send_validates_address_format(monkeypatch):
    _clear_email_env(monkeypatch)
    r = asyncio.run(email_send.send_email_async(
        user_id="u1", to=["not-an-email", "ok@x.com"],
        subject="s", body="b",
    ))
    assert r.ok is False
    assert "not-an-email" in r.message


def test_send_prefers_relay_over_smtp(monkeypatch):
    """When BOTH are configured, relay wins (this is the documented
    precedence in the email_send module docstring — operator can
    drop in relay creds to override a stale SMTP dev config)."""
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.example.com")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "k")
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")

    posted = {}

    async def fake_post(url, key, payload):
        posted["url"] = url
        posted["key"] = key
        posted["payload"] = payload
        return email_send.SendResult(
            ok=True, transport="relay", status_code=200,
            message="ok", sent_to=payload["to"].split(","),
        )

    monkeypatch.setattr(email_send, "_post_to_relay", fake_post)

    r = asyncio.run(email_send.send_email_async(
        user_id="medic-42", to=["dr@hospital.org"],
        subject="CT findings", body="See attached.",
    ))
    assert r.ok is True
    assert r.transport == "relay"
    assert posted["url"] == "https://relay.example.com"
    assert posted["payload"]["nexus_user_id"] == "medic-42"
    assert posted["payload"]["to"] == "dr@hospital.org"
    assert posted["payload"]["subject"] == "CT findings"


def test_send_falls_through_to_smtp_when_relay_absent(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")

    calls = {}

    def fake_smtp_sync(cfg, to, cc, subject, body):
        calls["cfg"] = cfg
        calls["to"] = list(to)
        return email_send.SendResult(
            ok=True, transport="smtp", message="sent", sent_to=list(to),
        )

    monkeypatch.setattr(email_send, "_send_smtp_sync", fake_smtp_sync)

    r = asyncio.run(email_send.send_email_async(
        user_id="u1", to=["a@x.com", "b@x.com"],
        subject="s", body="b",
    ))
    assert r.ok is True
    assert r.transport == "smtp"
    assert calls["to"] == ["a@x.com", "b@x.com"]


def test_send_refuses_bundled_creds_with_empty_allowlist(monkeypatch):
    """v1 #115 — bundled (.dmg-shipped) SMTP password requires a
    non-empty allow-list. Without it we refuse to send at all,
    regardless of the actual recipient. This is the only way to
    keep the half-public password from being weaponised."""
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")
    monkeypatch.setenv("NEXUS_SMTP_BUNDLED_CREDS", "1")
    # NEXUS_SMTP_ALLOWED_RECIPIENTS deliberately unset.

    r = asyncio.run(email_send.send_email_async(
        user_id="u1", to=["dr@hospital.org"],
        subject="s", body="b",
    ))
    assert r.ok is False
    assert r.transport == "smtp"
    assert "ALLOWED_RECIPIENTS" in r.message


def test_send_smtp_applies_allowlist(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")
    monkeypatch.setenv("NEXUS_SMTP_ALLOWED_RECIPIENTS", "dr@hospital.org")

    monkeypatch.setattr(
        email_send, "_send_smtp_sync",
        lambda *a, **k: pytest.fail("SMTP should NOT be called when allow-list rejects"),
    )

    r = asyncio.run(email_send.send_email_async(
        user_id="u1", to=["intruder@evil.com"],
        subject="s", body="b",
    ))
    assert r.ok is False
    assert "intruder@evil.com" in r.message


# ─────────────────────────────────────────────────────────────────────
# transport_status
# ─────────────────────────────────────────────────────────────────────


def test_transport_status_neither(monkeypatch):
    _clear_email_env(monkeypatch)
    s = email_send.transport_status()
    assert s.configured is False if hasattr(s, "configured") else True  # sanity
    assert s.relay_configured is False
    assert s.smtp_configured is False
    d = s.to_dict()
    assert d["configured"] is False
    assert d["relay_url_host"] == ""


def test_transport_status_relay_only(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_RELAY_URL", "https://relay.example.com:8080/api")
    monkeypatch.setenv("NEXUS_RELAY_API_KEY", "k-abc")
    s = email_send.transport_status()
    assert s.relay_configured is True
    assert s.smtp_configured is False
    assert s.relay_url_host == "relay.example.com"
    assert "relay" in s.default_from.lower()
    d = s.to_dict()
    assert d["configured"] is True


def test_transport_status_smtp_only(monkeypatch):
    _clear_email_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("NEXUS_SMTP_USER", "u@x.com")
    monkeypatch.setenv("NEXUS_SMTP_PASSWORD", "p")
    monkeypatch.setenv("NEXUS_SMTP_FROM", "ops@nexus.io")
    monkeypatch.setenv("NEXUS_SMTP_ALLOWED_RECIPIENTS", "a@x.com")
    s = email_send.transport_status()
    assert s.relay_configured is False
    assert s.smtp_configured is True
    assert s.default_from == "ops@nexus.io"
    assert s.allowed_recipients == ["a@x.com"]


# ─────────────────────────────────────────────────────────────────────
# Address-list parser
# ─────────────────────────────────────────────────────────────────────


def test_parse_addr_list_accepts_string_form():
    assert email_send._parse_addr_list("a@x.com, b@x.com ,c@x.com") == [
        "a@x.com", "b@x.com", "c@x.com",
    ]


def test_parse_addr_list_accepts_list_form():
    assert email_send._parse_addr_list(["a@x.com", " b@x.com ", ""]) == [
        "a@x.com", "b@x.com",
    ]


def test_parse_addr_list_none():
    assert email_send._parse_addr_list(None) == []
