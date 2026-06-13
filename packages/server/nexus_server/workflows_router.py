"""HTTP routes for the workflow registry.

Post-#92 (workflow execution runtime deleted) the endpoint surface is:

  GET    /api/v1/workflows                       — list user's workflows
  POST   /api/v1/workflows                       — create
  GET    /api/v1/workflows/{id}                  — read one
  PUT    /api/v1/workflows/{id}                  — partial update
  DELETE /api/v1/workflows/{id}                  — hard delete

  GET    /api/v1/workflows/runs                  — list HISTORICAL runs
  GET    /api/v1/workflows/runs/{run_id}         — read HISTORICAL run + step trace

  GET    /api/v1/workflows/packs                 — list starter packs
  POST   /api/v1/workflows/packs/{id}/install    — install a starter pack

What's gone (deleted in #92)
============================
  POST   /api/v1/workflows/{id}/run              — would create a run
  POST   /api/v1/workflows/{id}/run-in-chat      — chat-first run trigger
  POST   /api/v1/workflows/runs/{id}/cancel      — cancel an in-flight run
  POST   /api/v1/workflows/runs/{id}/send-to-chat — pipe run output into chat

Workflows are now executed by the agent itself: it reads each workflow's
recipe from the system context (built by ``llm_gateway._build_workflow_recipes_block``)
and chains ``delegate(skill, task)`` calls. The run-row tables remain
for historical readability of pre-deletion runs but no new rows are
produced.

Auth: all routes require a bearer JWT. All CRUD funcs WHERE-clause on
``user_id`` so cross-user access is impossible.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from nexus_server import starter_packs, workflows
from nexus_server.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/workflows", tags=["workflows"])


# ─────────────────────────────────────────────────────────────────────
# Request / response shapes
# ─────────────────────────────────────────────────────────────────────


class CreateWorkflowRequest(BaseModel):
    """Body for POST /api/v1/workflows."""
    name: str = Field(..., min_length=1, max_length=120)
    description: str = Field(default="", max_length=4000)
    definition: workflows.WorkflowDefinition


class UpdateWorkflowRequest(BaseModel):
    """Body for PUT /api/v1/workflows/{id}. All fields optional —
    only ones present in the request body get applied."""
    name: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=4000)
    definition: Optional[workflows.WorkflowDefinition] = None
    archived: Optional[bool] = None


class WorkflowListResponse(BaseModel):
    workflows: list[workflows.Workflow]


class RunListResponse(BaseModel):
    runs: list[workflows.WorkflowRun]


class StarterPackInfo(BaseModel):
    """Wire shape for one row in the starter pack catalog."""
    id: str
    name: str
    description: str
    step_count: int
    audience: str
    tier: str
    available: bool
    coming_soon_note: str


class StarterPackListResponse(BaseModel):
    packs: list[StarterPackInfo]


def _pack_to_info(p: starter_packs.StarterPack) -> StarterPackInfo:
    return StarterPackInfo(
        id=p.id, name=p.name, description=p.description,
        step_count=p.step_count, audience=p.audience, tier=p.tier,
        available=p.available, coming_soon_note=p.coming_soon_note,
    )


# ─────────────────────────────────────────────────────────────────────
# Workflow CRUD
# ─────────────────────────────────────────────────────────────────────


@router.get("", response_model=WorkflowListResponse)
def list_workflows_endpoint(
    include_archived: bool = False,
    current_user: str = Depends(get_current_user),
) -> WorkflowListResponse:
    items = workflows.list_workflows(current_user, include_archived=include_archived)
    return WorkflowListResponse(workflows=items)


@router.post("", response_model=workflows.Workflow,
             status_code=status.HTTP_201_CREATED)
def create_workflow_endpoint(
    req: CreateWorkflowRequest,
    current_user: str = Depends(get_current_user),
) -> workflows.Workflow:
    try:
        return workflows.create_workflow(
            user_id=current_user,
            name=req.name,
            description=req.description,
            definition=req.definition,
        )
    except Exception as e:    # noqa: BLE001
        logger.exception("Create workflow failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to create workflow: {e}",
        )


# ─────────────────────────────────────────────────────────────────────
# Runs (read-only; no new rows produced after #92)
# ─────────────────────────────────────────────────────────────────────


@router.get("/runs", response_model=RunListResponse)
def list_runs_endpoint(
    workflow_id: Optional[str] = None,
    limit: int = 50,
    current_user: str = Depends(get_current_user),
) -> RunListResponse:
    """List historical runs. Declared BEFORE the /{workflow_id} route
    so FastAPI's matcher doesn't capture 'runs' as a workflow id."""
    runs = workflows.list_runs(current_user, workflow_id=workflow_id, limit=limit)
    return RunListResponse(runs=runs)


@router.get("/runs/{run_id}", response_model=workflows.WorkflowRun)
def get_run_endpoint(
    run_id: str,
    current_user: str = Depends(get_current_user),
) -> workflows.WorkflowRun:
    """Read a single historical run + its step trace."""
    run = workflows.get_run(current_user, run_id)
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Run not found",
        )
    return run


# ─────────────────────────────────────────────────────────────────────
# Starter packs
# ─────────────────────────────────────────────────────────────────────


@router.get("/packs", response_model=StarterPackListResponse)
def list_packs_endpoint(
    current_user: str = Depends(get_current_user),
) -> StarterPackListResponse:
    """List the bundled starter packs."""
    items = [_pack_to_info(p) for p in starter_packs.list_packs()]
    return StarterPackListResponse(packs=items)


@router.post("/packs/{pack_id}/install", response_model=workflows.Workflow,
             status_code=status.HTTP_201_CREATED)
def install_pack_endpoint(
    pack_id: str,
    current_user: str = Depends(get_current_user),
) -> workflows.Workflow:
    """One-click install. Copies the pack's skill files into the
    user's skills dir AND creates the workflow row. Idempotent —
    re-installing replaces the same-name workflow."""
    try:
        return starter_packs.install_pack(current_user, pack_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown pack: {pack_id}",
        )
    except PermissionError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Pack assets missing: {e}",
        )
    except Exception as e:    # noqa: BLE001
        logger.exception("Install pack %s failed for user %s", pack_id, current_user)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Install failed: {e}",
        )


# ─────────────────────────────────────────────────────────────────────
# Workflow read / update / delete  (declared LAST so /runs and /packs
# resolve before the catch-all /{workflow_id} matcher)
# ─────────────────────────────────────────────────────────────────────


@router.get("/{workflow_id}", response_model=workflows.Workflow)
def get_workflow_endpoint(
    workflow_id: str,
    current_user: str = Depends(get_current_user),
) -> workflows.Workflow:
    wf = workflows.get_workflow(current_user, workflow_id)
    if wf is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workflow not found",
        )
    return wf


@router.put("/{workflow_id}", response_model=workflows.Workflow)
def update_workflow_endpoint(
    workflow_id: str,
    req: UpdateWorkflowRequest,
    current_user: str = Depends(get_current_user),
) -> workflows.Workflow:
    updated = workflows.update_workflow(
        user_id=current_user,
        workflow_id=workflow_id,
        name=req.name,
        description=req.description,
        definition=req.definition,
        archived=req.archived,
    )
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workflow not found",
        )
    return updated


@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workflow_endpoint(
    workflow_id: str,
    current_user: str = Depends(get_current_user),
) -> None:
    ok = workflows.delete_workflow(current_user, workflow_id)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workflow not found",
        )


# ─────────────────────────────────────────────────────────────────────
# #111: external skill import (marketplace MVP)
# ─────────────────────────────────────────────────────────────────────


class ImportSkillRequest(BaseModel):
    """Body for POST /skills/import."""
    url: str = Field(..., min_length=1, max_length=2048)


class ImportSkillResponse(BaseModel):
    name: str
    path: str
    bytes_written: int


@router.post("/skills/import", response_model=ImportSkillResponse,
             status_code=status.HTTP_201_CREATED)
def import_skill_endpoint(
    req: ImportSkillRequest,
    current_user: str = Depends(get_current_user),
) -> ImportSkillResponse:
    """Download a remote SKILL.md and install it into the user's skills
    directory. The URL must point at a raw markdown file on an
    allowlisted host (GitHub raw, gist, agentskills.io). The skill's
    name is parsed from the frontmatter and used as the on-disk folder.

    Returns the installed skill's resolved name + path. Caller can
    immediately reference the skill in a new workflow's
    ``WorkflowStep.skill`` field."""
    from nexus_server import skill_import
    try:
        result = skill_import.fetch_and_install_skill(req.url, current_user)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Skill import failed for %s", current_user)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected import error: {e}",
        )
    return ImportSkillResponse(**result)
