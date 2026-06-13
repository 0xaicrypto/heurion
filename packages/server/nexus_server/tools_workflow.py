"""Workflow tools — `list_workflows` only.

After #91 the workflow runtime is *recipe-based*, not fire-and-forget.
There is no `run_workflow` tool any more — the main agent executes
installed workflows by chaining ``delegate(skill, task)`` calls itself,
following per-workflow "recipes" injected into its system context by
``llm_gateway._build_workflow_recipes_block``.

Why we killed RunWorkflowTool
=============================
The original tool spawned a background asyncio task and returned a
"the workflow will arrive as a separate message in ~30-90s" success
string. Gemini repeatedly parroted that success string as its
*plain-text* reply WITHOUT ever emitting a function_call (tickets
#74, #77, #90). Every patch made the rescue layer more elaborate
without fixing the attractor: a tool whose semantic is "I promise
the future will deliver" is irresistible bait for an LLM that wants
to sound helpful with the least effort.

Replacing it with delegate-based recipes means each step of a
workflow is a *visible, in-context* tool call. The agent can't
silently no-op a workflow — if it doesn't call ``delegate``, the
user sees nothing happen, and the agent's next step is obvious.

This module now exposes only :class:`ListWorkflowsTool` — handy when
the agent wants a fresh re-read of installed workflows mid-session
(e.g. the user just said "I installed X"). The recipes block in the
system context already covers the common case.
"""
from __future__ import annotations

import json
import logging

from nexus_core.tools.base import BaseTool, ToolResult

logger = logging.getLogger(__name__)


class ListWorkflowsTool(BaseTool):
    """Enumerate the user's installed workflows + their input specs.

    Mostly redundant with the recipes block injected at turn start,
    but useful when the user installs a new pack mid-session and the
    agent wants to verify.
    """

    def __init__(self, user_id: str):
        self._user_id = user_id

    @property
    def name(self) -> str:
        return "list_workflows"

    @property
    def description(self) -> str:
        return (
            "List the multi-agent workflow recipes the user has installed. "
            "Returns each workflow's name, one-line description, and the "
            "structured inputs it accepts (key, label, required). The "
            "full step-by-step recipes are already in your system context — "
            "call this only when you suspect that list is stale (e.g. the "
            "user just said 'I installed X' or 'do you see my new pack?')."
        )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {},
            "required": [],
        }

    async def execute(self, **kwargs) -> ToolResult:
        try:
            from nexus_server import workflows as wf_mod
            installed = wf_mod.list_workflows(self._user_id)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "list_workflows: db read failed for %s: %s", self._user_id, e,
            )
            return ToolResult(success=False, error=f"Workflow lookup failed: {e}")

        if not installed:
            return ToolResult(
                output=(
                    "No workflows installed. The user can install a starter "
                    "pack (e.g. content-studio) from the Workflows library "
                    "view. Until they do, handle multi-step tasks yourself."
                ),
            )

        payload = []
        for wf in installed:
            payload.append({
                "id": wf.id,
                "name": wf.name,
                "description": wf.description,
                "inputs": [
                    {
                        "key": i.key,
                        "label": i.label or i.key,
                        "type": i.type,
                        "required": i.required,
                    }
                    for i in wf.definition.inputs
                ],
                "step_count": len(wf.definition.steps),
                "steps": [s.skill for s in wf.definition.steps],
            })
        return ToolResult(output=json.dumps(payload, indent=2))


def register_workflow_tools(twin, user_id: str) -> None:
    """Register list_workflows on the given twin instance.

    The old RunWorkflowTool is gone (see module docstring). Workflows
    now execute via the agent's delegate() loop against per-workflow
    recipes injected at turn start by llm_gateway._build_workflow_recipes_block.
    """
    twin.register_tool(ListWorkflowsTool(user_id=user_id))
    logger.info("Workflow tools registered for user %s (list_workflows only)", user_id)
