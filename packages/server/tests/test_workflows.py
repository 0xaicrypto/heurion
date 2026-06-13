"""Tests for the workflow CRUD + starter-pack HTTP surface.

Post-#91 (workflow execution removed in favour of agent-driven
``delegate(skill, task)`` recipes), the only server-side workflow
behaviour worth testing here is:

  * CRUD on workflows (create / get / list / update / delete)
  * User scoping (alice doesn't see bob's workflows)
  * Starter-pack catalog + install (POST /packs/<id>/install)
  * HTTP CRUD endpoints

The old run-lifecycle tests (start_run → execute_run → succeeded/failed)
moved to /dev/null when the runtime was deleted in #92. Sub-agent
recipe traversal is now tested via DelegateTool unit tests + the
recipe-block builder tests in test_tools_workflow.py.
"""
from __future__ import annotations

import pytest

from nexus_server import workflows


def _seed_user(user_id: str) -> None:
    """Insert a minimal users row so the FK on workflows.user_id holds."""
    from nexus_server.database import get_db_connection
    with get_db_connection() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO users
               (id, display_name, created_at, updated_at)
               VALUES (?, ?, datetime('now'), datetime('now'))""",
            (user_id, user_id),
        )
        conn.commit()


# ── CRUD ──────────────────────────────────────────────────────────────


def test_create_and_read_back():
    _seed_user("alice")
    wf = workflows.create_workflow(
        user_id="alice", name="P1",
        definition=workflows.WorkflowDefinition(
            inputs=[workflows.WorkflowInputSpec(key="topic", required=True)],
            steps=[
                workflows.WorkflowStep(skill="strategist"),
                workflows.WorkflowStep(skill="writer"),
            ],
        ),
    )
    assert wf.id.startswith("wf_")
    assert wf.name == "P1"
    assert len(wf.definition.steps) == 2

    fetched = workflows.get_workflow("alice", wf.id)
    assert fetched is not None
    assert fetched.id == wf.id
    assert fetched.definition.inputs[0].key == "topic"


def test_user_scoping_enforced():
    _seed_user("alice")
    _seed_user("bob")
    wf = workflows.create_workflow(
        user_id="alice", name="P1",
        definition=workflows.WorkflowDefinition(
            steps=[workflows.WorkflowStep(skill="s1")],
        ),
    )
    # Bob can't see alice's row.
    assert workflows.get_workflow("bob", wf.id) is None
    assert workflows.list_workflows("bob") == []
    assert workflows.list_workflows("alice")[0].id == wf.id


def test_update_partial_preserves_unchanged_fields():
    _seed_user("alice")
    wf = workflows.create_workflow(
        user_id="alice", name="P1",
        description="Original description.",
        definition=workflows.WorkflowDefinition(
            steps=[workflows.WorkflowStep(skill="s1")],
        ),
    )
    updated = workflows.update_workflow("alice", wf.id, description="Tweaked")
    assert updated is not None
    assert updated.description == "Tweaked"
    assert updated.name == "P1"  # unchanged


def test_delete_removes_row():
    _seed_user("alice")
    wf = workflows.create_workflow(
        user_id="alice", name="X",
        definition=workflows.WorkflowDefinition(
            steps=[workflows.WorkflowStep(skill="s1")],
        ),
    )
    assert workflows.delete_workflow("alice", wf.id) is True
    assert workflows.get_workflow("alice", wf.id) is None
    # Second delete is a no-op.
    assert workflows.delete_workflow("alice", wf.id) is False


# ── HTTP endpoints ────────────────────────────────────────────────────


def _register(client, name: str = "Workflow Tester") -> tuple[str, str]:
    """Register a fresh user, returning (jwt_token, user_id)."""
    reg = client.post("/api/v1/auth/register", json={"display_name": name})
    assert reg.status_code in (200, 201), reg.text
    token = reg.json()["jwt_token"]
    me = client.get(
        "/api/v1/chain/me", headers={"Authorization": f"Bearer {token}"},
    )
    user_id = me.json()["user_id"]
    return token, user_id


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_http_list_packs(client):
    """GET /packs returns the bundled starter pack catalog."""
    token, _ = _register(client)
    resp = client.get("/api/v1/workflows/packs", headers=_h(token))
    assert resp.status_code == 200, resp.text
    packs = resp.json()["packs"]
    ids = [p["id"] for p in packs]
    assert "content-studio" in ids
    cs = next(p for p in packs if p["id"] == "content-studio")
    assert cs["available"] is True
    assert cs["step_count"] == 5
    assert cs["tier"] == "free"


def test_http_install_content_studio_pack(client, tmp_path, monkeypatch):
    """POST /packs/content-studio/install creates the workflow row + skill files."""
    from nexus_server import starter_packs

    skills_target = tmp_path / "skills"
    monkeypatch.setattr(
        starter_packs, "_user_skills_dir", lambda: skills_target,
    )

    token, _ = _register(client)
    resp = client.post(
        "/api/v1/workflows/packs/content-studio/install",
        headers=_h(token),
    )
    assert resp.status_code == 201, resp.text
    wf = resp.json()
    assert wf["name"] == "Content Studio"
    assert len(wf["definition"]["steps"]) == 5
    step_skills = [s["skill"] for s in wf["definition"]["steps"]]
    assert step_skills == [
        "content-strategist", "content-researcher", "content-writer",
        "content-editor", "content-publisher",
    ]
    written = sorted(p.name for p in skills_target.glob("*.md"))
    assert written == [
        "content-editor.md", "content-publisher.md",
        "content-quality-verifier.md", "content-researcher.md",
        "content-strategist.md", "content-writer.md",
    ]


def test_http_install_pack_idempotent(client, tmp_path, monkeypatch):
    """Re-installing replaces the prior workflow + skill files."""
    from nexus_server import starter_packs
    skills_target = tmp_path / "skills"
    monkeypatch.setattr(
        starter_packs, "_user_skills_dir", lambda: skills_target,
    )
    token, _ = _register(client)
    r1 = client.post(
        "/api/v1/workflows/packs/content-studio/install", headers=_h(token),
    )
    assert r1.status_code == 201
    r2 = client.post(
        "/api/v1/workflows/packs/content-studio/install", headers=_h(token),
    )
    assert r2.status_code == 201
    assert r2.json()["id"] != r1.json()["id"]
    listing = client.get("/api/v1/workflows", headers=_h(token))
    same_name = [
        w for w in listing.json()["workflows"]
        if w["name"] == "Content Studio"
    ]
    assert len(same_name) == 1  # not 2 — prior install was replaced


def test_http_install_unavailable_pack_returns_403(client):
    """Coming-soon packs surface a clean 403, not 500."""
    token, _ = _register(client)
    resp = client.post(
        "/api/v1/workflows/packs/radiology-pro/install", headers=_h(token),
    )
    assert resp.status_code == 403, resp.text
    body = resp.json()
    err_field = body.get("error") or body.get("detail") or ""
    assert "radiology-pro" in err_field or "coming soon" in err_field.lower()


def test_http_install_unknown_pack_returns_404(client):
    token, _ = _register(client)
    resp = client.post(
        "/api/v1/workflows/packs/does-not-exist/install", headers=_h(token),
    )
    assert resp.status_code == 404


def test_http_create_list_get_delete(client):
    token, _ = _register(client)
    body = {
        "name": "Pipeline 1",
        "description": "Hand-wired pipeline",
        "definition": {
            "inputs": [{
                "key": "topic", "label": "Topic", "type": "text",
                "required": True, "options": []
            }],
            "steps": [
                {"skill": "strategist", "model": None, "label": ""},
                {"skill": "writer", "model": None, "label": ""},
            ],
            "metadata": {},
        },
    }
    resp = client.post("/api/v1/workflows", json=body, headers=_h(token))
    assert resp.status_code == 201, resp.text
    wf_id = resp.json()["id"]

    listing = client.get("/api/v1/workflows", headers=_h(token))
    assert "Pipeline 1" in [w["name"] for w in listing.json()["workflows"]]

    one = client.get(f"/api/v1/workflows/{wf_id}", headers=_h(token))
    assert one.json()["id"] == wf_id

    delete = client.delete(f"/api/v1/workflows/{wf_id}", headers=_h(token))
    assert delete.status_code == 204
    after = client.get(f"/api/v1/workflows/{wf_id}", headers=_h(token))
    assert after.status_code == 404
