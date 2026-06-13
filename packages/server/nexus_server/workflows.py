"""Workflow registry — CRUD + read-only run history.

Post-#91 + #92 this module no longer contains an *executor*. Workflows
are now described to the agent as recipes (see
``llm_gateway._build_workflow_recipes_block``); the agent executes
them by chaining ``delegate(skill, task)`` calls itself. The old
fire-and-forget runner — ``execute_run``, ``_execute_one_pass``,
``_run_gatekeeper``, ``cancel_run`` and their ~700 lines of step /
iteration / wave bookkeeping — was deleted because it was the source
of repeated hallucination failures (#74 / #77 / #90) and adding more
guards never closed the gap.

What survives
=============
* :class:`WorkflowInputSpec` / :class:`WorkflowStep` /
  :class:`GatekeeperSpec` / :class:`WorkflowDefinition` /
  :class:`Workflow` — the recipe shape. Read by the system-prompt
  recipe block, the ListWorkflowsTool, the workflows_router CRUD
  endpoints, and ``starter_packs.install_pack``.
* :class:`WorkflowRunStep` / :class:`WorkflowRun` — historical run
  rows. Still readable via :func:`get_run` / :func:`list_runs` so
  pre-deletion run records remain queryable from the desktop. No new
  rows are ever produced.
* CRUD: :func:`create_workflow` / :func:`get_workflow` /
  :func:`list_workflows` / :func:`update_workflow` /
  :func:`delete_workflow`.
* :func:`_default_skill_resolver` — used by the DelegateTool to look
  up skill instructions when the agent calls ``delegate(skill, task)``.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field

from nexus_server.database import get_db_connection

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────


class WorkflowInputSpec(BaseModel):
    """One declared input field on a workflow."""
    key: str = Field(..., min_length=1, max_length=64)
    label: str = Field(default="", max_length=120)
    type: str = Field(default="text")             # text | select | longtext
    required: bool = Field(default=True)
    options: list[str] = Field(default_factory=list)  # for type=select


class VerifierSpec(BaseModel):
    """#106: per-step verification subagent (D-3 layer).

    When a ``WorkflowStep`` declares a verifier, the orchestrating
    agent runs an extra ``delegate(verifier.skill, …)`` call AFTER the
    step's main delegate returns, hands the step output to the
    verifier, and reads back a structured verdict. On a fail, the
    agent retries the step with the verifier's suggestions injected,
    up to ``max_retries`` times. The verifier itself is just another
    installed skill — the wire contract is the verdict JSON shape:

        {"pass": bool, "issues": [str, ...], "suggestions": [str, ...]}

    Lifted from PaperOrchestra-style multi-agent verification. Lives
    in the recipe text the agent reads, not in a separate runtime —
    the agent does the verify-retry loop itself via delegate calls.
    """
    skill: str = Field(..., min_length=1, max_length=128)
    # Per-verifier-call acceptance criteria injected into the verifier
    # prompt so the same skill can be reused across steps with
    # different bars (e.g. "no factual claims without sources" vs
    # "no plagiarism, no >3-sentence run-ons").
    criteria: str = Field(default="", max_length=2000)
    # Maximum retries when the verifier returns pass=false. 1 is a
    # reasonable default — most quality issues resolve on the second
    # attempt, and runaway loops burn tokens. Set to 0 to make the
    # verifier purely advisory (run, log, but never retry).
    max_retries: int = Field(default=1, ge=0, le=5)


class WorkflowStep(BaseModel):
    """One step in a workflow — references an installed skill by name.

    All the per-step knobs (model override, depends_on, timeout, tools)
    survive even though the local runner is gone: the agent reading the
    recipe block can still surface them in its ``delegate()`` task
    framing (e.g. "this step uses web_search"), and starter packs
    bundle them as authored data.
    """
    skill: str = Field(..., min_length=1, max_length=128)
    model: Optional[str] = None
    label: str = Field(default="", max_length=120)
    id: str = Field(default="", max_length=128)
    depends_on: list[str] = Field(default_factory=list)
    parallel_root: bool = Field(default=False)
    timeout_seconds: int = Field(default=180, ge=5, le=900)
    tools: list[str] = Field(default_factory=list)
    # #106 D-3: optional per-step verifier subagent.
    verifier: Optional[VerifierSpec] = None


class GatekeeperSpec(BaseModel):
    """Iterative-mode quality gate spec (data-only after #92 — the
    iterative runner is gone, but the recipe block tells the agent to
    invoke the gatekeeper skill as the final delegate() of an
    iterative recipe)."""
    skill: str = Field(..., min_length=1, max_length=128)
    pass_criteria: str = Field(default="")
    label: str = Field(default="gatekeeper", max_length=120)


class WorkflowDefinition(BaseModel):
    """The recipe — what the workflow does, independent of who's running it."""
    inputs: list[WorkflowInputSpec] = Field(default_factory=list)
    steps: list[WorkflowStep] = Field(..., min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)
    mode: str = Field(default="linear")           # linear | iterative
    gatekeeper: Optional[GatekeeperSpec] = None
    max_iterations: int = Field(default=3, ge=1, le=10)


class Workflow(BaseModel):
    """A stored workflow definition + its server-side metadata row."""
    id: str
    user_id: str
    name: str
    description: str = ""
    definition: WorkflowDefinition
    created_at: str
    updated_at: str
    archived: bool = False


class WorkflowRunStep(BaseModel):
    """One step's execution trace within a (historical) run."""
    step_index: int
    skill_name: str
    status: str                        # pending | running | succeeded | failed | skipped
    input: str = ""
    output: str = ""
    model_used: str = ""
    cost_usd: float = 0.0
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error_message: str = ""
    iteration: int = 0


class WorkflowRun(BaseModel):
    """A historical execution of a workflow. No new rows are produced
    after #92 — the local runner was deleted. Kept here so the desktop
    can still read pre-deletion runs."""
    id: str
    workflow_id: str
    user_id: str
    status: str                        # pending | running | succeeded | failed | cancelled
    inputs: dict[str, str] = Field(default_factory=dict)
    error_message: str = ""
    current_step: int = 0
    total_steps: int = 0
    total_cost_usd: float = 0.0
    started_at: str
    finished_at: Optional[str] = None
    anchor_tx: Optional[str] = None
    steps: list[WorkflowRunStep] = Field(default_factory=list)
    current_iteration: int = 0
    max_iterations: int = 0
    last_gatekeeper_verdict: str = ""


# ─────────────────────────────────────────────────────────────────────
# ID generators
# ─────────────────────────────────────────────────────────────────────


def new_workflow_id() -> str:
    return f"wf_{uuid.uuid4().hex[:12]}"


# ─────────────────────────────────────────────────────────────────────
# CRUD: Workflows
# ─────────────────────────────────────────────────────────────────────


def create_workflow(
    user_id: str,
    name: str,
    definition: WorkflowDefinition,
    description: str = "",
) -> Workflow:
    """Persist a new workflow row and return it."""
    wf_id = new_workflow_id()
    now = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO nexus_workflows
                (id, user_id, name, description, definition, created_at, updated_at, archived)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                wf_id, user_id, name, description,
                json.dumps(definition.model_dump()),
                now, now,
            ),
        )
        conn.commit()
    logger.info("Created workflow %s (user=%s) — %s", wf_id, user_id, name)
    return Workflow(
        id=wf_id, user_id=user_id, name=name, description=description,
        definition=definition, created_at=now, updated_at=now, archived=False,
    )


def get_workflow(user_id: str, workflow_id: str) -> Optional[Workflow]:
    """Fetch one workflow scoped to ``user_id``. Returns None on miss."""
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM nexus_workflows WHERE id = ? AND user_id = ?",
            (workflow_id, user_id),
        ).fetchone()
    return _row_to_workflow(row) if row else None


def list_workflows(user_id: str, include_archived: bool = False) -> list[Workflow]:
    """List all workflows for a user, newest update first."""
    sql = "SELECT * FROM nexus_workflows WHERE user_id = ?"
    if not include_archived:
        sql += " AND archived = 0"
    sql += " ORDER BY updated_at DESC"
    with get_db_connection() as conn:
        rows = conn.execute(sql, (user_id,)).fetchall()
    return [_row_to_workflow(r) for r in rows]


def update_workflow(
    user_id: str,
    workflow_id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    definition: Optional[WorkflowDefinition] = None,
    archived: Optional[bool] = None,
) -> Optional[Workflow]:
    """Patch-style update. Only non-None fields are applied."""
    current = get_workflow(user_id, workflow_id)
    if current is None:
        return None
    next_name = name if name is not None else current.name
    next_desc = description if description is not None else current.description
    next_def = definition if definition is not None else current.definition
    next_archived = (1 if archived else 0) if archived is not None else (1 if current.archived else 0)
    now = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        conn.execute(
            """
            UPDATE nexus_workflows
            SET name = ?, description = ?, definition = ?, updated_at = ?,
                archived = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                next_name, next_desc,
                json.dumps(next_def.model_dump()),
                now, next_archived,
                workflow_id, user_id,
            ),
        )
        conn.commit()
    return get_workflow(user_id, workflow_id)


def delete_workflow(user_id: str, workflow_id: str) -> bool:
    """Hard delete. Also drops associated (historical) run rows + step rows."""
    with get_db_connection() as conn:
        # Cascade: kill steps → kill runs → kill workflow row.
        run_ids = [
            r["id"] for r in conn.execute(
                "SELECT id FROM nexus_workflow_runs WHERE workflow_id = ? AND user_id = ?",
                (workflow_id, user_id),
            ).fetchall()
        ]
        for run_id in run_ids:
            conn.execute(
                "DELETE FROM nexus_workflow_run_steps WHERE run_id = ?",
                (run_id,),
            )
        conn.execute(
            "DELETE FROM nexus_workflow_runs WHERE workflow_id = ? AND user_id = ?",
            (workflow_id, user_id),
        )
        result = conn.execute(
            "DELETE FROM nexus_workflows WHERE id = ? AND user_id = ?",
            (workflow_id, user_id),
        )
        conn.commit()
        return result.rowcount > 0


# ─────────────────────────────────────────────────────────────────────
# Run history (read-only — no new rows produced after #92)
# ─────────────────────────────────────────────────────────────────────


def get_run(user_id: str, run_id: str) -> Optional[WorkflowRun]:
    """Fetch a historical run + its step rows. Scoped to user."""
    with get_db_connection() as conn:
        run_row = conn.execute(
            "SELECT * FROM nexus_workflow_runs WHERE id = ? AND user_id = ?",
            (run_id, user_id),
        ).fetchone()
        if not run_row:
            return None
        step_rows = conn.execute(
            "SELECT * FROM nexus_workflow_run_steps WHERE run_id = ? "
            "ORDER BY iteration ASC, step_index ASC",
            (run_id,),
        ).fetchall()
    return _row_to_run(run_row, step_rows)


def list_runs(
    user_id: str, workflow_id: Optional[str] = None, limit: int = 50,
) -> list[WorkflowRun]:
    """Most-recent-first list of the user's historical runs."""
    if workflow_id:
        sql = """
            SELECT * FROM nexus_workflow_runs
            WHERE user_id = ? AND workflow_id = ?
            ORDER BY started_at DESC LIMIT ?
        """
        params: tuple = (user_id, workflow_id, limit)
    else:
        sql = """
            SELECT * FROM nexus_workflow_runs
            WHERE user_id = ?
            ORDER BY started_at DESC LIMIT ?
        """
        params = (user_id, limit)
    with get_db_connection() as conn:
        rows = conn.execute(sql, params).fetchall()
        if not rows:
            return []
        run_ids = [r["id"] for r in rows]
        placeholders = ",".join(["?"] * len(run_ids))
        step_rows = conn.execute(
            f"SELECT * FROM nexus_workflow_run_steps "
            f"WHERE run_id IN ({placeholders}) "
            f"ORDER BY run_id, iteration ASC, step_index ASC",
            tuple(run_ids),
        ).fetchall()
    steps_by_run: dict[str, list] = {rid: [] for rid in run_ids}
    for s in step_rows:
        steps_by_run.setdefault(s["run_id"], []).append(s)
    return [_row_to_run(r, steps_by_run.get(r["id"], [])) for r in rows]


# ─────────────────────────────────────────────────────────────────────
# Row mapping helpers
# ─────────────────────────────────────────────────────────────────────


def _row_to_workflow(row) -> Workflow:
    return Workflow(
        id=row["id"],
        user_id=row["user_id"],
        name=row["name"],
        description=row["description"] or "",
        definition=WorkflowDefinition(**json.loads(row["definition"])),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        archived=bool(row["archived"]),
    )


def _row_to_run(run_row, step_rows) -> WorkflowRun:
    def _opt(name: str, default):
        try:
            v = run_row[name]
            return v if v is not None else default
        except (KeyError, IndexError):
            return default

    return WorkflowRun(
        id=run_row["id"],
        workflow_id=run_row["workflow_id"],
        user_id=run_row["user_id"],
        status=run_row["status"],
        inputs=json.loads(run_row["inputs"] or "{}"),
        error_message=run_row["error_message"] or "",
        current_step=int(run_row["current_step"] or 0),
        total_steps=int(run_row["total_steps"] or 0),
        total_cost_usd=float(run_row["total_cost_usd"] or 0.0),
        started_at=run_row["started_at"],
        finished_at=run_row["finished_at"],
        anchor_tx=run_row["anchor_tx"],
        current_iteration=int(_opt("current_iteration", 0) or 0),
        max_iterations=int(_opt("max_iterations", 0) or 0),
        last_gatekeeper_verdict=str(_opt("last_gatekeeper_verdict", "") or ""),
        steps=[
            WorkflowRunStep(
                step_index=int(s["step_index"]),
                skill_name=s["skill_name"],
                status=s["status"],
                input=s["input"] or "",
                output=s["output"] or "",
                model_used=s["model_used"] or "",
                cost_usd=float(s["cost_usd"] or 0.0),
                started_at=s["started_at"],
                finished_at=s["finished_at"],
                error_message=s["error_message"] or "",
                iteration=int(_opt_step(s, "iteration", 0) or 0),
            )
            for s in step_rows
        ],
    )


def _opt_step(row, name: str, default):
    try:
        v = row[name]
        return v if v is not None else default
    except (KeyError, IndexError):
        return default


# ─────────────────────────────────────────────────────────────────────
# Skill resolver (used by the DelegateTool to look up skill metadata)
# ─────────────────────────────────────────────────────────────────────


def _default_skill_resolver(skill_name: str) -> Optional[dict]:
    """Live skill resolver — looks up via the SDK's SkillManager.

    Returns ``{instructions, model, tools}`` or None when the skill
    isn't installed. Builds a fresh ``SkillManager`` against the
    default skills directory each call; the SDK's load path is just
    a disk scan so the cost is negligible.
    """
    try:
        from nexus_core.skills.manager import SkillManager
    except ImportError:
        logger.warning(
            "nexus_core.skills not importable — DelegateTool can't resolve skills"
        )
        return None
    mgr = SkillManager()
    skill = mgr.get(skill_name)
    if skill is None:
        return None
    return {
        "instructions": skill.instructions,
        "model": skill.model,
        "tools": skill.tools,
    }
