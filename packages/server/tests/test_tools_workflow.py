"""Tests for the chat-facing workflow tools.

After #91, the only surviving tool is :class:`ListWorkflowsTool` —
the old ``RunWorkflowTool`` was deleted because its fire-and-forget
semantic kept tricking Gemini into hallucinating success messages
without ever emitting a function_call. Workflows are now executed by
the main agent via ``delegate(skill, task)`` calls against per-workflow
recipes injected into context by
``llm_gateway._build_workflow_recipes_block``.

Coverage here:
  * ListWorkflowsTool empty / populated / per-user isolation.
  * Recipe block renders the expected delegate() chain for installed
    workflows and bails empty when none are installed.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def fresh_db(monkeypatch):
    """Each test gets an isolated SQLite DB to avoid bleed-through."""
    tdir = tempfile.mkdtemp(prefix="nexus-wf-tools-test-")
    db_path = Path(tdir) / "test.db"
    monkeypatch.setenv("NEXUS_DB_PATH", str(db_path))
    from nexus_server import database as db_mod
    if hasattr(db_mod, "_initialized"):
        db_mod._initialized = False
    db_mod.init_db()
    yield db_path


def _seed_content_studio(user_id: str):
    """Create a Content-Studio-shaped workflow for the given user."""
    from nexus_server import workflows as wf_mod
    wdef = wf_mod.WorkflowDefinition(
        inputs=[
            wf_mod.WorkflowInputSpec(key="topic", label="Topic", required=True),
            wf_mod.WorkflowInputSpec(key="audience", label="Audience", required=True),
            wf_mod.WorkflowInputSpec(
                key="platform", label="Platform", required=False,
                type="select",
                options=["Twitter/X thread", "Blog post", "LinkedIn"],
            ),
        ],
        steps=[
            wf_mod.WorkflowStep(skill="content-strategist", label="Strategist"),
            wf_mod.WorkflowStep(skill="content-writer", label="Writer"),
            wf_mod.WorkflowStep(skill="content-editor", label="Editor"),
        ],
    )
    return wf_mod.create_workflow(
        user_id=user_id, name="Content Studio",
        description="Multi-agent content creation pipeline.",
        definition=wdef,
    )


# ─────────────────────────────────────────────────────────────────────
# ListWorkflowsTool
# ─────────────────────────────────────────────────────────────────────


def test_list_workflows_returns_empty_message_when_none(fresh_db):
    from nexus_server.tools_workflow import ListWorkflowsTool
    tool = ListWorkflowsTool(user_id="alice")
    result = asyncio.run(tool.execute())
    assert result.success
    assert "No workflows installed" in result.output


def test_list_workflows_returns_structured_json(fresh_db):
    _seed_content_studio("alice")
    from nexus_server.tools_workflow import ListWorkflowsTool
    tool = ListWorkflowsTool(user_id="alice")
    result = asyncio.run(tool.execute())
    assert result.success
    payload = json.loads(result.output)
    assert len(payload) == 1
    wf = payload[0]
    assert wf["name"] == "Content Studio"
    assert wf["step_count"] == 3
    input_keys = [i["key"] for i in wf["inputs"]]
    assert input_keys == ["topic", "audience", "platform"]
    required_map = {i["key"]: i["required"] for i in wf["inputs"]}
    assert required_map == {"topic": True, "audience": True, "platform": False}
    # New in #91: skill list ships in the JSON so the agent can verify
    # the recipe block matches what's installed.
    assert wf["steps"] == ["content-strategist", "content-writer", "content-editor"]


def test_list_workflows_isolated_per_user(fresh_db):
    _seed_content_studio("alice")
    from nexus_server.tools_workflow import ListWorkflowsTool
    bob_tool = ListWorkflowsTool(user_id="bob")
    result = asyncio.run(bob_tool.execute())
    assert "No workflows installed" in result.output


# ─────────────────────────────────────────────────────────────────────
# Recipe block (replaces the old run_workflow tool description)
# ─────────────────────────────────────────────────────────────────────


def test_recipes_block_empty_when_no_workflows(fresh_db):
    from nexus_server.llm_gateway import _build_workflow_recipes_block
    assert _build_workflow_recipes_block("alice") == ""


def test_recipes_block_renders_delegate_chain(fresh_db):
    _seed_content_studio("alice")
    from nexus_server.llm_gateway import _build_workflow_recipes_block
    block = _build_workflow_recipes_block("alice")

    # Header tells the agent how to interpret what follows.
    assert "WORKFLOW RECIPES" in block
    assert "delegate(" in block
    # The "DO NOT announce" framing is the key anti-hallucination guard.
    assert "DO NOT announce" in block

    # Each step renders as a delegate() call with the right skill name.
    assert 'delegate(skill_name="content-strategist"' in block
    assert 'delegate(skill_name="content-writer"' in block
    assert 'delegate(skill_name="content-editor"' in block

    # Input list surfaces required markers + select options inline.
    assert "topic*" in block
    assert "audience*" in block
    assert "Twitter/X thread" in block


def test_recipes_block_handles_iterative_gatekeeper(fresh_db):
    """v2.1 iterative packs get a gatekeeper-loop note in the recipe."""
    from nexus_server import workflows as wf_mod
    wdef = wf_mod.WorkflowDefinition(
        inputs=[wf_mod.WorkflowInputSpec(key="diff", required=True)],
        steps=[
            wf_mod.WorkflowStep(skill="bug-hunter"),
            wf_mod.WorkflowStep(skill="security-reviewer"),
        ],
        mode="iterative",
        gatekeeper=wf_mod.GatekeeperSpec(
            skill="review-gatekeeper",
            pass_criteria="No critical findings remain.",
        ),
        max_iterations=3,
    )
    wf_mod.create_workflow(
        user_id="alice", name="Code Review",
        description="Iterative PR review.",
        definition=wdef,
    )
    from nexus_server.llm_gateway import _build_workflow_recipes_block
    block = _build_workflow_recipes_block("alice")
    assert "Code Review" in block
    assert 'delegate(skill_name="review-gatekeeper"' in block
    assert "Max 3 iterations" in block
