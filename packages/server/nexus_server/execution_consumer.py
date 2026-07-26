"""Execution Plane consumer — polls Redis for Sidecar jobs and runs them.

Run as a standalone process inside the worker stack:

    python -m nexus_server.execution_consumer

For now the handlers are stubs; they will be replaced with real DOCX/PPTX/PDF
rendering once the Sidecar template system lands.
"""

import json
import os
import time
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("execution-consumer")

REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")


def get_redis():
    import redis
    return redis.from_url(REDIS_URL, decode_responses=True)


def _update_job(r, job_id: str, status: str, result: dict | None = None, error: str = ""):
    now = str(time.time())
    fields = {"status": status, "updated_at": now}
    if result is not None:
        fields["result"] = json.dumps(result)
    if error:
        fields["error"] = error
    r.hset(f"heurion:job:{job_id}", mapping=fields)


def _handle(job_id: str, record: dict) -> dict:
    job_type = record.get("type", "")
    payload = {}
    if record.get("payload"):
        try:
            payload = json.loads(record["payload"])
        except Exception:
            pass

    logger.info("Processing job %s of type %s", job_id, job_type)

    # Stub handlers — replace with real Sidecar rendering in phase 3.
    if job_type == "sidecar.generate_docx":
        return {"file_id": f"docx_{job_id}", "status": "completed"}
    if job_type == "sidecar.generate_pptx":
        return {"file_id": f"pptx_{job_id}", "status": "completed"}
    if job_type == "sidecar.render_table":
        return {"file_id": f"table_{job_id}", "status": "completed"}

    return {"acknowledged": True, "type": job_type, "payload": payload}


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
