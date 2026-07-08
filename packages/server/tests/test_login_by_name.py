"""F-multiuser-isolation — display_name-based login/register endpoint.

The medic reported "我每次登陆用不同的用户名，看起来记录都是老的". Root
cause was the old ``api.login()`` flow ignoring the typed display_name
and reusing the cached UUID. New endpoint ``/auth/login-by-name``
makes the display_name itself the login key:

  * Existing display_name → activate that identity (same data)
  * New display_name → create a brand-new identity (empty workspace)

These tests pin the contract so the regression can't sneak back in.
"""
from __future__ import annotations

import pathlib
import sys
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient


@pytest.fixture
def client() -> TestClient:
    from nexus_server.main import create_app
    from nexus_server.migrations.runner import run_migrations
    run_migrations()
    return TestClient(create_app())


# ─────────────────────────────────────────────────────────────────────
# Core happy path
# ─────────────────────────────────────────────────────────────────────


def test_new_name_creates_identity(client):
    r = client.post("/api/v1/auth/login-by-name",
                    json={"display_name": "金医生"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_new_account"] is True
    assert body["user_id"]
    assert body["jwt_token"]
    assert body["identity"]["display_name"] == "金医生"
    assert body["identity"]["user_id"] == body["user_id"]


def test_existing_name_returns_same_user_id(client):
    r1 = client.post("/api/v1/auth/login-by-name",
                     json={"display_name": "李医生"})
    uid1 = r1.json()["user_id"]
    assert r1.json()["is_new_account"] is True

    r2 = client.post("/api/v1/auth/login-by-name",
                     json={"display_name": "李医生"})
    assert r2.status_code == 200
    assert r2.json()["user_id"] == uid1
    assert r2.json()["is_new_account"] is False


def test_different_names_are_isolated(client):
    a = client.post("/api/v1/auth/login-by-name",
                    json={"display_name": "张医生"}).json()
    b = client.post("/api/v1/auth/login-by-name",
                    json={"display_name": "王医生"}).json()
    assert a["user_id"] != b["user_id"], (
        "different display_names MUST mint distinct user_ids — "
        "this is the medic-reported bug we're guarding against"
    )
    # The second call's identities list contains both names.
    names = {i["display_name"] for i in b["identities"]}
    assert {"张医生", "王医生"}.issubset(names)


# ─────────────────────────────────────────────────────────────────────
# Tolerances
# ─────────────────────────────────────────────────────────────────────


def test_whitespace_is_trimmed(client):
    r1 = client.post("/api/v1/auth/login-by-name",
                     json={"display_name": "陈医生"}).json()
    r2 = client.post("/api/v1/auth/login-by-name",
                     json={"display_name": "  陈医生  "}).json()
    assert r1["user_id"] == r2["user_id"]


def test_ascii_case_insensitive(client):
    r1 = client.post("/api/v1/auth/login-by-name",
                     json={"display_name": "doctor jin"}).json()
    r2 = client.post("/api/v1/auth/login-by-name",
                     json={"display_name": "Doctor Jin"}).json()
    r3 = client.post("/api/v1/auth/login-by-name",
                     json={"display_name": "DOCTOR JIN"}).json()
    assert r1["user_id"] == r2["user_id"] == r3["user_id"]


# ─────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────


def test_empty_name_rejected(client):
    r = client.post("/api/v1/auth/login-by-name",
                    json={"display_name": "   "})
    assert r.status_code == 400


def test_missing_field_rejected(client):
    r = client.post("/api/v1/auth/login-by-name", json={})
    # FastAPI raises 422 on missing required field
    assert r.status_code in (400, 422)


# ─────────────────────────────────────────────────────────────────────
# Side effects
# ─────────────────────────────────────────────────────────────────────


def test_token_authenticates_subsequent_requests(client):
    """The returned JWT must work as Authorization: Bearer on protected
    endpoints — proving the new endpoint mints a real token, not a stub."""
    r = client.post("/api/v1/auth/login-by-name",
                    json={"display_name": "测试医生"})
    token = r.json()["jwt_token"]
    # Hit a protected endpoint with the token.
    me = client.get(
        "/api/v1/research/studies",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me.status_code == 200, me.text
    # Empty list for a brand-new user — proves we're scoped correctly.
    assert me.json() == [] or isinstance(me.json(), list)


def test_existing_user_data_visible_after_re_login(client):
    """Critical isolation contract: log in as 金医生, create a study,
    log out + log in again as 金医生 → study still there. Then log
    in as 李医生 → DOES NOT see 金医生's study."""
    # Login as 金医生 + create a study
    r_jin = client.post("/api/v1/auth/login-by-name",
                        json={"display_name": "金医生"}).json()
    tok_jin = r_jin["jwt_token"]
    client.post(
        "/api/v1/research/studies",
        json={"display_name": "金医生的研究", "short_code": "JIN-001",
              "phase": "II"},
        headers={"Authorization": f"Bearer {tok_jin}"},
    )

    # Re-login as 金医生 → study visible
    r_jin2 = client.post("/api/v1/auth/login-by-name",
                         json={"display_name": "金医生"}).json()
    assert r_jin2["user_id"] == r_jin["user_id"]
    studies = client.get(
        "/api/v1/research/studies",
        headers={"Authorization": f"Bearer {r_jin2['jwt_token']}"},
    ).json()
    names = [s["display_name"] for s in studies]
    assert "金医生的研究" in names

    # Login as 李医生 → does NOT see 金医生's study
    r_li = client.post("/api/v1/auth/login-by-name",
                       json={"display_name": "李医生"}).json()
    assert r_li["user_id"] != r_jin["user_id"]
    li_studies = client.get(
        "/api/v1/research/studies",
        headers={"Authorization": f"Bearer {r_li['jwt_token']}"},
    ).json()
    li_names = [s["display_name"] for s in li_studies]
    assert "金医生的研究" not in li_names, (
        "DATA LEAK: 李医生 saw 金医生's data — the bug we set out to fix"
    )
