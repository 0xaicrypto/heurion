"""D-2: tests for the `delegate` tool (ad-hoc subagent invocation)."""
from __future__ import annotations

import asyncio

import pytest


@pytest.fixture
def with_skills_dir(monkeypatch, tmp_path):
    """Drop a few skill markdown files into a fake .nexus/skills so
    the delegate tool can resolve them."""
    monkeypatch.chdir(tmp_path)
    skills = tmp_path / ".nexus" / "skills"
    skills.mkdir(parents=True)

    (skills / "foo-extractor.md").write_text(
        "---\nname: foo-extractor\n---\n\nYou extract foos from text. "
        "Output one foo per line.",
        encoding="utf-8",
    )
    (skills / "bar-checker.md").write_text(
        "---\nname: bar-checker\n---\n\nYou check whether claims are bar-compliant.",
        encoding="utf-8",
    )
    yield tmp_path


def test_description_lists_installed_skills(with_skills_dir):
    from nexus_server.tools_subagent import DelegateTool
    tool = DelegateTool(user_id="alice")
    desc = tool.description
    assert "INSTALLED SUB-AGENTS" in desc
    assert "foo-extractor" in desc
    assert "bar-checker" in desc


def test_description_empty_when_no_skills(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    from nexus_server.tools_subagent import DelegateTool
    desc = DelegateTool(user_id="alice").description
    assert "No skills installed" in desc


def test_delegate_missing_args_errors(with_skills_dir):
    from nexus_server.tools_subagent import DelegateTool
    tool = DelegateTool(user_id="alice")
    r1 = asyncio.run(tool.execute(skill_name="", task="hello"))
    assert not r1.success
    assert "skill_name" in r1.error.lower()

    r2 = asyncio.run(tool.execute(skill_name="foo-extractor", task=""))
    assert not r2.success
    assert "task" in r2.error.lower()


def test_delegate_unknown_skill_errors(with_skills_dir):
    from nexus_server.tools_subagent import DelegateTool
    tool = DelegateTool(user_id="alice")
    result = asyncio.run(tool.execute(
        skill_name="nonexistent-skill", task="do a thing",
    ))
    assert not result.success
    assert "not installed" in result.error.lower()
    # Should hint at what IS installed
    assert "foo-extractor" in result.error or "bar-checker" in result.error


def test_delegate_happy_path_calls_llm_with_skill_instructions(
    with_skills_dir, monkeypatch,
):
    """Verify the sub-call uses the skill's instructions as system
    prompt and the task as the user message."""
    captured = {}

    async def fake_call_llm(*, messages, system_prompt, model,
                             temperature, max_tokens, tools):
        captured["system"] = system_prompt
        captured["user"] = messages[0]["content"]
        captured["tools"] = tools
        return "foo1\nfoo2\nfoo3", "test-model", "stop", []

    from nexus_server import llm_gateway as gw
    monkeypatch.setattr(gw, "call_llm", fake_call_llm)

    from nexus_server.tools_subagent import DelegateTool
    tool = DelegateTool(user_id="alice")
    result = asyncio.run(tool.execute(
        skill_name="foo-extractor",
        task="extract foos from: 'foo apple foo orange foo grape'",
    ))
    assert result.success
    assert "foo1" in result.output
    assert "foo-extractor" in result.output  # header annotation

    # Skill instructions became the system prompt.
    assert "extract foos" in captured["system"].lower()
    # Task became the user message.
    assert "extract foos from" in captured["user"]
    # No nested tools — single-shot specialist by design.
    assert captured["tools"] is None


def test_delegate_llm_failure_returns_clean_error(with_skills_dir, monkeypatch):
    async def boom(**kwargs):
        raise RuntimeError("LLM provider exploded")

    from nexus_server import llm_gateway as gw
    monkeypatch.setattr(gw, "call_llm", boom)

    from nexus_server.tools_subagent import DelegateTool
    tool = DelegateTool(user_id="alice")
    result = asyncio.run(tool.execute(
        skill_name="foo-extractor", task="anything",
    ))
    assert not result.success
    assert "exploded" in result.error.lower() or "crashed" in result.error.lower()
