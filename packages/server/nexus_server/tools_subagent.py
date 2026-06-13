"""``delegate`` tool — subagent invocation primitive.

Since #91, ``delegate`` is the *only* way the main agent invokes a
specialist sub-skill. The previous ``run_workflow`` tool (fire-and-
forget background pipeline) was deleted because its semantic
repeatedly tricked Gemini into hallucinating success messages without
actually emitting a function_call. Now workflows are described to the
agent as RECIPES — ordered lists of ``delegate(skill, task)`` calls —
which the agent executes inline. Each call is a visible tool card in
chat, so there's no place for a silent no-op to hide.

Use cases:
  - Single-step specialist: extract findings from a scan, rate severity,
    translate a passage.
  - Multi-step workflow: chain delegates to traverse a recipe from the
    WORKFLOW RECIPES block.
  - Ad-hoc coordination: pick specialists at runtime based on context
    without a pre-baked workflow definition.

Design notes
============
* Each delegate call is a SINGLE LLM completion — its system_prompt is
  the skill's instructions, its user message is the task string. No
  nested tools, no tool-loop inside the delegate. Keeps cost
  predictable and avoids recursion explosions.
* The sub-call inherits the user's model preferences via the shared
  llm_gateway.call_llm path.
* Output is the sub-agent's raw text back to the main agent. The
  main agent decides how to use it (forward into the next step, edit,
  present to user, etc.).
"""
from __future__ import annotations

import logging
from typing import Optional

from nexus_core.tools.base import BaseTool, ToolResult

logger = logging.getLogger(__name__)


def _resolve_skill(skill_name: str) -> Optional[dict]:
    """Look up a skill by name. Returns ``{instructions, model}`` or
    None if the skill isn't installed. Mirrors the resolver shape used
    by the workflow runner."""
    try:
        from nexus_server.workflows import _default_skill_resolver
        return _default_skill_resolver(skill_name)
    except Exception as e:  # noqa: BLE001
        logger.debug("delegate: skill resolver failed for %s: %s", skill_name, e)
        return None


def _list_available_skill_names() -> list[str]:
    """Cheap enumeration so the tool description can advertise what's
    callable. Reads the user-level skills directory (the SkillManager
    drops every installed skill there)."""
    from pathlib import Path
    out: list[str] = []
    try:
        skill_dir = Path.cwd() / ".nexus" / "skills"
        if skill_dir.exists():
            for p in sorted(skill_dir.glob("*.md")):
                out.append(p.stem)
    except Exception as e:  # noqa: BLE001
        logger.debug("delegate: skill listing failed: %s", e)
    return out


class DelegateTool(BaseTool):
    """Run a single installed skill as a one-shot specialist.

    The main agent calls this when it wants a specialist to handle a
    narrowly-scoped task without setting up a full multi-step workflow.
    Think of it as the difference between ``run_workflow`` (call a
    whole orchestra) and ``delegate`` (call one violinist)."""

    def __init__(self, user_id: str, twin=None):
        self._user_id = user_id
        # #127 — twin ref lets us peek at the current turn's vision
        # parts (set by twin.chat()) so we can forward them to the
        # sub-agent's one-shot call. None during tests / when the
        # tool was wired up without a twin context.
        self._twin = twin

    @property
    def name(self) -> str:
        return "delegate"

    def _available_block(self) -> str:
        names = _list_available_skill_names()
        if not names:
            return (
                "  (No skills installed yet. Install a starter pack from "
                "the Workflows library to make subagents available.)\n"
            )
        # Don't print every skill — keep it scannable. Cap at 30.
        shown = names[:30]
        rest = max(0, len(names) - len(shown))
        line = "  • " + "\n  • ".join(shown)
        if rest:
            line += f"\n  …and {rest} more"
        return line + "\n"

    @property
    def description(self) -> str:
        return (
            "Delegate a narrowly-scoped task to one installed specialist "
            "skill (sub-agent). The sub-agent receives ONLY the task "
            "string you provide — its system prompt is the skill's "
            "instructions, and it does NOT see your conversation history. "
            "Use this when:\n"
            "\n"
            "  - You need ONE narrow specialist output (e.g. "
            "    'extract findings', 'rate severity', 'translate this').\n"
            "  - You're executing a workflow recipe (see WORKFLOW RECIPES "
            "    in your context) — call delegate() once per step, in "
            "    order, feeding each step's output into the next.\n"
            "  - You want to compose an ad-hoc multi-agent flow.\n"
            "\n"
            "DO NOT use this for tasks you can answer yourself with your "
            "own knowledge or one of the simpler tools (web_search, etc.).\n"
            "\n"
            "INSTALLED SUB-AGENTS (one-shot callable):\n"
            f"{self._available_block()}"
            "\n"
            "Returns the sub-agent's raw text output. Costs ~1 LLM "
            "call's worth of tokens."
        )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": (
                        "Name of the installed skill to delegate to. "
                        "Must exactly match one of the INSTALLED "
                        "SUB-AGENTS shown above."
                    ),
                },
                "task": {
                    "type": "string",
                    "description": (
                        "The user-message body sent to the sub-agent. "
                        "Be specific — include all context the "
                        "sub-agent needs. The sub-agent doesn't see "
                        "your conversation history."
                    ),
                },
            },
            "required": ["skill_name", "task"],
        }

    async def execute(
        self, skill_name: str = "", task: str = "", **kwargs,
    ) -> ToolResult:
        skill_name = (skill_name or "").strip()
        task = (task or "").strip()
        if not skill_name:
            return ToolResult(
                success=False, error="`skill_name` is required.",
            )
        if not task:
            return ToolResult(
                success=False, error="`task` is required and cannot be empty.",
            )

        skill = _resolve_skill(skill_name)
        if skill is None:
            available = _list_available_skill_names()
            hint = (
                f" Installed skills: {', '.join(available[:10])}."
                if available else " No skills installed."
            )
            return ToolResult(
                success=False,
                error=f"Skill not installed: {skill_name!r}.{hint}",
            )

        system_prompt = skill.get("instructions", "")
        model = skill.get("model") or None

        # #127 — forward the main turn's vision parts so the
        # sub-agent can see the same screenshot / image the user
        # just pasted. Without this, delegate("paper-polish-inspector",
        # "describe the figure on page 3") would hit a sub-agent that
        # only sees text and gets confused — defeats the point of
        # multi-agent vision flows.
        active_images: list[dict] | None = None
        if self._twin is not None:
            try:
                active_images = getattr(self._twin, "_active_turn_images", None)
            except Exception:  # noqa: BLE001
                active_images = None

        user_msg: dict = {"role": "user", "content": task}
        if active_images:
            user_msg["images"] = list(active_images)

        # Dispatch to the LLM via the shared gateway path. We do NOT
        # pass tools — this is a single-shot specialist call, not a
        # nested tool-using agent. (D-3 work, deferred.)
        try:
            from nexus_server.llm_gateway import call_llm
            # max_tokens=8192: sub-agents often produce long-form
            # outputs (a full article body, a multi-section review).
            # Leaving this at None means Anthropic falls back to its
            # 8192 default but Gemini's default is sometimes lower —
            # being explicit avoids silent truncation of writer/editor
            # stages mid-recipe.
            content, model_used, _stop, _tools = await call_llm(
                messages=[user_msg],
                system_prompt=system_prompt,
                model=model,
                temperature=None,
                max_tokens=8192,
                tools=None,
            )
        except Exception as e:  # noqa: BLE001
            logger.exception(
                "delegate(%s) crashed for user %s: %s",
                skill_name, self._user_id, e,
            )
            return ToolResult(
                success=False, error=f"Sub-agent {skill_name!r} crashed: {e}",
            )

        logger.info(
            "delegate(%s) ok for user %s — %d chars via %s",
            skill_name, self._user_id, len(content or ""), model_used,
        )
        return ToolResult(
            output=(
                f"[Sub-agent: {skill_name}, model: {model_used}]\n"
                f"{content or ''}"
            ),
        )


def register_subagent_tools(twin, user_id: str) -> None:
    """Register the delegate tool onto the given twin."""
    # #127 — twin reference lets DelegateTool forward the current
    # turn's vision parts to the sub-agent. Keeps the test path
    # easy (no twin → ``active_images`` stays None).
    twin.register_tool(DelegateTool(user_id=user_id, twin=twin))
    logger.info("Subagent tools registered for user %s", user_id)
