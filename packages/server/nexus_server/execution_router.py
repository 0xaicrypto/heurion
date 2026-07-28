"""Execution Plane API — job enqueue/status for the Sidecar worker.

Control Plane posts jobs here; the worker consumer pulls them from Redis
and executes them asynchronously. This keeps the heavy rendering logic off
the main API server.
"""

import os
import json
import uuid
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/v1/jobs", tags=["execution"])
file_router = APIRouter(prefix="/api/v1/files", tags=["files"])

WORKER_TOKEN = os.environ.get("WORKER_API_TOKEN", "")
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")


def _get_redis():
    import redis
    return redis.from_url(REDIS_URL, decode_responses=True)


def verify_worker_token(x_worker_token: str = Header(...)):
    if not WORKER_TOKEN:
        raise HTTPException(status_code=500, detail="WORKER_API_TOKEN not configured")
    if x_worker_token != WORKER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid worker token")
    return x_worker_token


class JobPayload(BaseModel):
    type: str = Field(..., description="Job type, e.g. sidecar.generate_docx")
    payload: dict[str, Any] = Field(default_factory=dict)
    tenant: dict[str, str] = Field(default_factory=dict)
    callback_url: str | None = None


class JobResponse(BaseModel):
    job_id: str
    status: str
    created_at: float
    result: dict[str, Any] | None = None
    error: str | None = None


@router.post("", response_model=JobResponse)
def enqueue_job(job: JobPayload, token: str = Depends(verify_worker_token)):
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = time.time()
    record = {
        "job_id": job_id,
        "type": job.type,
        "payload": json.dumps(job.payload),
        "tenant": json.dumps(job.tenant),
        "callback_url": job.callback_url or "",
        "status": "pending",
        "created_at": str(now),
        "updated_at": str(now),
        "result": "",
        "error": "",
    }
    r = _get_redis()
    r.hset(f"heurion:job:{job_id}", mapping=record)
    r.lpush("heurion:jobs", job_id)
    return _to_response(record)


@router.get("/{job_id}", response_model=JobResponse)
def get_job(job_id: str, token: str = Depends(verify_worker_token)):
    r = _get_redis()
    record = r.hgetall(f"heurion:job:{job_id}")
    if not record:
        raise HTTPException(status_code=404, detail="Job not found")
    return _to_response(record)


@file_router.get("/{file_id}/download")
def download_file(file_id: str, token: str = Depends(verify_worker_token)):
    """Return a time-limited presigned URL for a rendered Sidecar output file."""
    from heurion_worker.storage import get_download_url

    r = _get_redis()
    mapping = r.hgetall(f"heurion:file:{file_id}")
    if not mapping or not mapping.get("storage_key"):
        raise HTTPException(status_code=404, detail="File not found")

    try:
        url = get_download_url(mapping["storage_key"])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to generate download URL: {exc}")

    return {
        "file_id": file_id,
        "file_name": mapping.get("file_name", ""),
        "mime_type": mapping.get("mime_type", ""),
        "download_url": url,
        "expires_in": 300,
    }


def _to_response(record: dict[str, str]) -> JobResponse:
    result = {}
    if record.get("result"):
        try:
            result = json.loads(record["result"])
        except Exception:
            result = {"value": record["result"]}
    error = record.get("error") or None
    return JobResponse(
        job_id=record["job_id"],
        status=record.get("status", "unknown"),
        created_at=float(record.get("created_at", 0)),
        result=result if result else None,
        error=error,
    )
