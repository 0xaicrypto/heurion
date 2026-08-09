"""#404: Python stats worker — serves scipy/statsmodels/lifelines results.

Single entry point: HTTP /analyze (FastAPI). #444: the Redis dual-consumer
was a dead path (no producer ever wrote to heurion:jobs) and is removed.
"""
import os
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


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=os.environ.get("STATS_HOST", "0.0.0.0"), port=int(os.environ.get("STATS_PORT", "8005")))


if __name__ == "__main__":
    main()
