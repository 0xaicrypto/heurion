"""#404: Python stats worker — serves scipy/statsmodels/lifelines results.

Two entry points:
1. HTTP /analyze (FastAPI) — called by the TS worker/server for stats jobs.
2. Redis consumer (heurion:jobs, stats.* types) — coexists with the TS
   consumer on the same queue (Redis brpop is atomic per job).
"""
import json
import os
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import stats_core

app = FastAPI(title="Heurion Python Stats Worker")


class AnalyzeRequest(BaseModel):
    test: str
    group_a: Optional[List[float]] = None
    group_b: Optional[List[float]] = None
    table: Optional[List[List[float]]] = None
    values: Optional[List[float]] = None
    survival_a: Optional[List[Dict[str, Any]]] = None
    survival_b: Optional[List[Dict[str, Any]]] = None
    group: Optional[List[str]] = None
    factor_a: Optional[List[str]] = None


def run_analysis(req: AnalyzeRequest) -> Dict[str, Any]:
    test = req.test
    if test == "describe":
        return {"report": stats_core.describe(req.values or [])}
    if test == "t-test":
        return {"report": stats_core.welch_t(req.group_a or [], req.group_b or [])}
    if test == "chi-square":
        return {"report": stats_core.chi_square(req.table or [])}
    if test == "kaplan-meier":
        ta = [r.get("time", 0) for r in (req.survival_a or [])]
        ea = [bool(r.get("event")) for r in (req.survival_a or [])]
        tb = [r.get("time", 0) for r in (req.survival_b or [])]
        eb = [bool(r.get("event")) for r in (req.survival_b or [])]
        return {"report": stats_core.kaplan_meier(ta, ea, tb, eb)}
    if test == "two-way-anova":
        return {"report": stats_core.two_way_anova(req.group or [], req.factor_a or [], req.values or [])}
    raise HTTPException(status_code=400, detail=f"unknown test: {test}")


@app.get("/healthz")
def healthz() -> str:
    return "ok"


@app.post("/analyze")
def analyze(req: AnalyzeRequest) -> Dict[str, Any]:
    return run_analysis(req)


# ── Redis dual-consumer (stats.* job types) ──────────────────────────
def redis_consumer() -> None:
    try:
        import redis

        r = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
        print("Stats worker listening on heurion:jobs (stats.* types)")
        while True:
            result = r.brpop("heurion:jobs", 0)
            if not result:
                continue
            _, raw = result
            try:
                job = json.loads(raw)
            except Exception:
                continue
            if not str(job.get("type", "")).startswith(("stats.", "sidecar.heurion/stats.")):
                continue  # other consumers handle non-stats jobs
            job_id = job.get("id")
            print(f"Processing stats job {job_id}: {job.get('type')}")
            try:
                payload = job.get("payload") or {}
                data = payload.get("data") or payload
                req = AnalyzeRequest(**{k: v for k, v in data.items() if k in AnalyzeRequest.model_fields})
                result_payload = run_analysis(req)
                status_key = f"heurion:job:{job_id}"
                r.set(status_key, json.dumps({"status": "completed", "result": result_payload}), ex=3600)
            except Exception as exc:  # noqa: BLE001
                r.set(f"heurion:job:{job_id}", json.dumps({"status": "failed", "error": str(exc)}), ex=3600)
    except Exception as exc:  # noqa: BLE001
        print(f"Redis consumer unavailable: {exc}")


def main() -> None:
    threading.Thread(target=redis_consumer, daemon=True).start()
    import uvicorn

    uvicorn.run(app, host=os.environ.get("STATS_HOST", "0.0.0.0"), port=int(os.environ.get("STATS_PORT", "8005")))


if __name__ == "__main__":
    main()
