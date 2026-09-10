"""#404: Python stats worker — serves scipy/statsmodels/lifelines results.

Single entry point: HTTP /analyze (FastAPI). #444: the Redis dual-consumer
was a dead path (no producer ever wrote to heurion:jobs) and is removed.

Wire contract (#689): AnalyzeRequest mirrors
packages/contracts/src/stats.ts (statsRequestSchema) — keep both in sync.
"""
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import stats_core

app = FastAPI(title="Heurion Python Stats Worker")


class AnalyzeRequest(BaseModel):
    """Mirror of contracts/src/stats.ts statsRequestSchema (#689).
    形状对齐由 scripts/check-stats-schema-alignment.sh 机读锁定（#941）。
    """
    # zod 侧 test 为 min(1) — pydantic 镜像同口径（裸 str 会接受空串，漂移）。
    test: str = Field(min_length=1)
    group_a: Optional[List[float]] = None
    group_b: Optional[List[float]] = None
    table: Optional[List[List[float]]] = None
    values: Optional[List[float]] = None
    survival_a: Optional[List[Dict[str, Any]]] = None
    survival_b: Optional[List[Dict[str, Any]]] = None
    group: Optional[List[str]] = None
    factor_a: Optional[List[str]] = None


def run_analysis(req: AnalyzeRequest) -> Dict[str, Any]:
    handlers: Dict[str, Any] = {
        "describe": lambda: stats_core.describe(req.values or []),
        "t-test": lambda: stats_core.welch_t(req.group_a or [], req.group_b or []),
        "chi-square": lambda: stats_core.chi_square(req.table or []),
        "kaplan-meier": lambda: stats_core.kaplan_meier(
            [r.get("time", 0) for r in (req.survival_a or [])],
            [bool(r.get("event")) for r in (req.survival_a or [])],
            [r.get("time", 0) for r in (req.survival_b or [])],
            [bool(r.get("event")) for r in (req.survival_b or [])],
        ),
        "two-way-anova": lambda: stats_core.two_way_anova(req.group or [], req.factor_a or [], req.values or []),
    }
    handler = handlers.get(req.test)
    if handler is None:
        raise HTTPException(status_code=400, detail=f"unknown test: {req.test}")
    return {"report": handler()}


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
