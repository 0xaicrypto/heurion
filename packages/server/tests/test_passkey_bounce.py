"""
Tests for the passkey bounce + poll bridge endpoints.

These two routes are the v2 desktop's substitute for v1's .NET
HttpListener callback: the browser hits /bounce after WebAuthn
success, the desktop polls /poll until the token lands.

Coverage:

  /bounce/{session_id}?token=<jwt>
    - Stashes (session, token) → HTML 200
    - Missing token query → 400 HTML page (no stash)
    - Bad session_id shape → 400
    - Stores so that next /poll returns the token

  /poll/{session_id}
    - Pending when no entry
    - Ready + token after a /bounce
    - Token is POPPED on first ready response (replay protection)
    - TTL eviction: stale entries are GC'd after 5 minutes
    - Bad session_id → pending (don't leak info)

  Source-level guards:
    - api-client.ts wires both URLs
    - LoginView renders Sign-in-with-passkey + Sign-up-with-passkey
    - i18n keys exist in both en-US and zh-CN
    - main.py still includes the auth router (sanity — passkey
      page must be reachable for the bounce flow to start)
"""
from __future__ import annotations

import asyncio
import pathlib
import re
import sys
import time

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from nexus_server.auth import routes as auth_routes  # noqa: E402


# ─────────────────────────────────────────────────────────────────────
# Helpers — clear the in-memory bounce store between tests so a prior
# test's stashed token can't leak into the next.
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clear_bounce_store():
    auth_routes._BOUNCE_TOKENS.clear()
    yield
    auth_routes._BOUNCE_TOKENS.clear()


SESSION_ID = "abcdef0123456789abcdef0123456789"  # 32 hex chars — valid UUID-shaped


# ─────────────────────────────────────────────────────────────────────
# /bounce
# ─────────────────────────────────────────────────────────────────────


def test_bounce_stashes_token():
    """Happy path: the browser hits /bounce after WebAuthn, the token
    lands in the in-memory store keyed by session_id."""
    resp = asyncio.run(auth_routes.passkey_bounce(
        session_id=SESSION_ID, token="jwt-fake-12345",
    ))
    assert resp.status_code == 200
    body = resp.body.decode("utf-8")
    assert "Signed in" in body
    assert "close this window" in body.lower()
    # The token should now be retrievable via the poll endpoint.
    with auth_routes._BOUNCE_LOCK:
        assert SESSION_ID in auth_routes._BOUNCE_TOKENS
        stashed_token, _ts = auth_routes._BOUNCE_TOKENS[SESSION_ID]
    assert stashed_token == "jwt-fake-12345"


def test_bounce_without_token_returns_400_and_no_stash():
    """No token query param → render a 400 error page; nothing stashed.
    Otherwise an attacker could probe the endpoint to learn session IDs."""
    resp = asyncio.run(auth_routes.passkey_bounce(
        session_id=SESSION_ID, token=None,
    ))
    assert resp.status_code == 400
    body = resp.body.decode("utf-8")
    assert "incomplete" in body.lower() or "no token" in body.lower()
    # Critical: nothing got stashed.
    assert SESSION_ID not in auth_routes._BOUNCE_TOKENS


def test_bounce_rejects_short_session_id():
    """session_id < 24 chars looks too small to be a UUID — refuse,
    so this endpoint can't be abused as a generic kv store."""
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(auth_routes.passkey_bounce(
            session_id="abc",  # way too short
            token="jwt-fake",
        ))
    assert exc_info.value.status_code == 400


def test_bounce_rejects_too_long_session_id():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(auth_routes.passkey_bounce(
            session_id="x" * 100,
            token="jwt-fake",
        ))
    assert exc_info.value.status_code == 400


# ─────────────────────────────────────────────────────────────────────
# /poll
# ─────────────────────────────────────────────────────────────────────


def test_poll_pending_when_no_entry():
    r = asyncio.run(auth_routes.passkey_poll(session_id=SESSION_ID))
    assert r.status == "pending"
    assert r.token is None


def test_poll_returns_ready_after_bounce():
    """Standard happy-path: bounce stashes, poll retrieves."""
    asyncio.run(auth_routes.passkey_bounce(
        session_id=SESSION_ID, token="jwt-real-9876",
    ))
    r = asyncio.run(auth_routes.passkey_poll(session_id=SESSION_ID))
    assert r.status == "ready"
    assert r.token == "jwt-real-9876"


def test_poll_pops_on_read_no_replay():
    """First /poll for a session returns ready+token. SECOND /poll
    must return pending — the token is single-use, even within the
    TTL. This neutralises replay even if the session_id leaks."""
    asyncio.run(auth_routes.passkey_bounce(
        session_id=SESSION_ID, token="jwt-once",
    ))
    r1 = asyncio.run(auth_routes.passkey_poll(session_id=SESSION_ID))
    assert r1.status == "ready"
    assert r1.token == "jwt-once"
    # Replay attempt:
    r2 = asyncio.run(auth_routes.passkey_poll(session_id=SESSION_ID))
    assert r2.status == "pending"
    assert r2.token is None


def test_poll_returns_pending_for_bad_session_id_shape():
    """Don't leak whether session_id is malformed vs unknown — return
    a plain 'pending' the same as for any other unknown session."""
    r = asyncio.run(auth_routes.passkey_poll(session_id="x"))
    assert r.status == "pending"
    assert r.token is None


# ─────────────────────────────────────────────────────────────────────
# TTL behaviour
# ─────────────────────────────────────────────────────────────────────


def test_stale_bounce_entries_get_gced():
    """Entries older than _BOUNCE_TTL_SECONDS must drop on next access.
    We hand-set the timestamp to simulate the 5-minute TTL elapsing
    instead of sleeping in the test."""
    # Inject a fake entry.
    with auth_routes._BOUNCE_LOCK:
        auth_routes._BOUNCE_TOKENS["staleSession" + "x" * 16] = (
            "old-jwt",
            time.time() - (auth_routes._BOUNCE_TTL_SECONDS + 10),
        )
    # A fresh entry to verify GC keeps the newer one.
    asyncio.run(auth_routes.passkey_bounce(
        session_id=SESSION_ID, token="fresh-jwt",
    ))
    # Stale should be gone now, fresh present.
    with auth_routes._BOUNCE_LOCK:
        assert "staleSession" + "x" * 16 not in auth_routes._BOUNCE_TOKENS
        assert SESSION_ID in auth_routes._BOUNCE_TOKENS


def test_ttl_constant_is_five_minutes():
    """5 minutes is the agreed value — matches v1's HttpListener timeout
    so medics get the same UX expectation. A regression that drops
    this to 30 seconds would silently break long WebAuthn ceremonies
    (e.g. user has to dig out a hardware key from a drawer)."""
    assert auth_routes._BOUNCE_TTL_SECONDS == 5 * 60


# ─────────────────────────────────────────────────────────────────────
# Source-level guards
# ─────────────────────────────────────────────────────────────────────

DESKTOP_SRC = (
    pathlib.Path(__file__).resolve().parents[2] / "desktop-v2" / "src"
)


def _strip_ts_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    out = []
    for line in text.splitlines():
        idx = line.find("//")
        if idx >= 0:
            line = line[:idx]
        out.append(line)
    return "\n".join(out)


def test_api_client_wires_bounce_and_poll():
    src = _strip_ts_comments(
        (DESKTOP_SRC / "lib" / "api-client.ts").read_text(),
    )
    assert "passkeyAuth" in src, (
        "api-client.ts no longer exposes api.passkeyAuth — LoginView "
        "buttons will fail at runtime."
    )
    assert "/api/v1/auth/passkey/bounce/" in src, (
        "api-client.ts doesn't reference the bounce URL — the callback "
        "would go to the wrong endpoint."
    )
    assert "/api/v1/auth/passkey/poll/" in src, (
        "api-client.ts doesn't reference the poll URL — the desktop "
        "would never see the token after the browser flow."
    )


def test_login_view_renders_passkey_buttons():
    src = _strip_ts_comments(
        (DESKTOP_SRC / "login.tsx").read_text(),
    )
    # Two distinct entry points: login (matches existing passkey) and
    # signup (creates a new account bound to a new passkey).
    assert "login.passkey.signIn" in src, (
        "LoginView no longer renders the 'Sign in with passkey' button."
    )
    assert "login.passkey.signUp" in src, (
        "LoginView no longer renders the 'Sign up with passkey' button."
    )
    assert "api.passkeyAuth" in src, (
        "LoginView buttons no longer call api.passkeyAuth — clicking "
        "would be a no-op."
    )


def test_i18n_keys_present_in_both_locales():
    en = (DESKTOP_SRC / "lib" / "i18n" / "en-US.ts").read_text()
    zh = (DESKTOP_SRC / "lib" / "i18n" / "zh-CN.ts").read_text()
    for key in (
        "login.passkey.signIn", "login.passkey.signUp",
        "login.passkey.signingIn", "login.passkey.signupHint",
        "login.passkey.signinHint", "login.passkey.divider",
        "login.passkey.error",
    ):
        assert f"'{key}'" in en, f"missing in en-US.ts: {key}"
        assert f"'{key}'" in zh, f"missing in zh-CN.ts: {key}"


def test_passkey_page_router_still_included():
    """The bounce flow depends on /auth/passkey-page being reachable.
    A regression that drops passkey_page from main.py's include_router
    silently breaks the entire passkey UX."""
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "main.py"
    ).read_text()
    code = "\n".join(l.split("#", 1)[0] for l in src.splitlines())
    assert "passkey_page" in code, (
        "main.py no longer imports passkey_page — /auth/passkey-page "
        "would 404 and the entire passkey UX breaks."
    )
    assert "passkey_page.router" in code, (
        "passkey_page imported but never wired onto the app."
    )
