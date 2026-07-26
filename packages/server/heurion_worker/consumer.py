"""Execution Plane consumer — polls Redis for Sidecar jobs and runs them.

This module intentionally lives outside the ``nexus_server`` package so that
importing it does **not** trigger FastAPI app creation or other Control Plane
side effects.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from heurion_worker.sidecar import dispatch

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("heurion-worker.consumer")

REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")


def get_redis():
    import redis

    # socket_timeout must be larger than the longest BRPOP timeout we use,
    # otherwise redis-py raises TimeoutError while waiting for the server to
    # unblock. 30 seconds gives plenty of headroom for the 5-second poll loop.
    return redis.from_url(REDIS_URL, decode_responses=True, socket_timeout=30)


def _update_job(
    r,
    job_id: str,
    status: str,
    result: dict[str, Any] | None = None,
    error: str = "",
):
    now = str(time.time())
    fields = {"status": status, "updated_at": now}
    if result is not None:
        fields["result"] = json.dumps(result)
    if error:
        fields["error"] = error
    r.hset(f"heurion:job:{job_id}", mapping=fields)


def _parse_payload(record: dict[str, str]) -> dict[str, Any]:
    raw = record.get("payload", "")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        logger.warning("Job payload is not valid JSON, using empty dict")
        return {}


def _handle(job_id: str, record: dict[str, str]) -> dict:
    job_type = record.get("type", "")
    payload = _parse_payload(record)

    logger.info("Processing job %s of type %s", job_id, job_type)

    # Non-sidecar jobs are acknowledged but not rendered.
    if not job_type.startswith("sidecar."):
        return {"acknowledged": True, "type": job_type}

    return dispatch(job_type, payload)


def run():
    r = get_redis()
    logger.info("Execution consumer started, waiting for jobs on heurion:jobs")
    while True:
        try:
            item = r.brpop("heurion:jobs", timeout=5)
            if item is None:
                continue
            _, job_id = item
            record = r.hgetall(f"heurion:job:{job_id}")
            if not record:
                logger.warning("Job %s not found in store", job_id)
                continue

            _update_job(r, job_id, "running")
            try:
                result = _handle(job_id, record)
                _update_job(r, job_id, "completed", result=result)
                logger.info("Job %s completed", job_id)
            except Exception as exc:
                logger.exception("Job %s failed", job_id)
                _update_job(r, job_id, "failed", error=str(exc))
        except Exception:
            logger.exception("Consumer loop error")
            time.sleep(2)


if __name__ == "__main__":
    run()
