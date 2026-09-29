"""#404: Python stats worker — serves scipy/statsmodels/lifelines results.

Single entry point: HTTP /analyze (FastAPI). #444: the Redis dual-consumer
was a dead path (no producer ever wrote to heurion:jobs) and is removed.

Wire contract (#689): AnalyzeRequest mirrors
packages/contracts/src/stats.ts (statsRequestSchema) — keep both in sync.
"""
import os
from typing import Annotated, Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, BeforeValidator, Field, StrictBool

import stats_core

app = FastAPI(title="Heurion Python Stats Worker")

# #1149: 数组长度上限（与 contracts statsRequestSchema 的 .max 镜像）—
# 无上限的巨型数组会打爆 scipy 内存。
MAX_SERIES_LEN = 100_000
MAX_TABLE_ROWS = 10_000
MAX_TABLE_COLS = 1_000


def _reject_coerced_number(v: Any) -> Any:
    """#1149: 只收真正的 JSON number — pydantic 宽松模式此前接受 `"5"`/`true`
    （str/bool→float 强转），zod 侧 z.number() 拒绝；两端行为必须一致。
    bool 是 int 子类，必须显式拒绝。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError("must be a JSON number")
    return v


StrictNumber = Annotated[float, BeforeValidator(_reject_coerced_number)]
Series = Annotated[List[StrictNumber], Field(max_length=MAX_SERIES_LEN)]
Table = Annotated[
    List[Annotated[List[StrictNumber], Field(max_length=MAX_TABLE_COLS)]],
    Field(max_length=MAX_TABLE_ROWS),
]


class SurvivalRecord(BaseModel):
    """#严重-2: time/event are REQUIRED — zod already requires both. Optional
    fields silently coerced missing time to t=0 and missing event to censored,
    corrupting the KM curve and log-rank p without any error.
    #1149: event 严格 bool、time 严格数字（拒绝 "yes"/"1" 强转）。"""
    time: StrictNumber
    event: StrictBool


class AnalyzeRequest(BaseModel):
    """Mirror of contracts/src/stats.ts statsRequestSchema (#689).
    形状对齐由 scripts/check-stats-schema-alignment.sh 机读锁定（#941）。
    """
    # zod 侧 test 为 min(1) — pydantic 镜像同口径（裸 str 会接受空串，漂移）。
    test: str = Field(min_length=1)
    group_a: Optional[Series] = None
    group_b: Optional[Series] = None
    table: Optional[Table] = None
    values: Optional[Series] = None
    survival_a: Optional[Annotated[List[SurvivalRecord], Field(max_length=MAX_SERIES_LEN)]] = None
    survival_b: Optional[Annotated[List[SurvivalRecord], Field(max_length=MAX_SERIES_LEN)]] = None
    group: Optional[Annotated[List[str], Field(max_length=MAX_SERIES_LEN)]] = None
    factor_a: Optional[Annotated[List[str], Field(max_length=MAX_SERIES_LEN)]] = None


def run_analysis(req: AnalyzeRequest) -> Dict[str, Any]:
    handlers: Dict[str, Any] = {
        "describe": lambda: stats_core.describe(req.values or []),
        "t-test": lambda: stats_core.welch_t(req.group_a or [], req.group_b or []),
        "chi-square": lambda: stats_core.chi_square(req.table or []),
        "kaplan-meier": lambda: stats_core.kaplan_meier(
            [r.time for r in (req.survival_a or [])],
            [r.event for r in (req.survival_a or [])],
            [r.time for r in (req.survival_b or [])],
            [r.event for r in (req.survival_b or [])],
        ),
        "two-way-anova": lambda: stats_core.two_way_anova(req.group or [], req.factor_a or [], req.values or []),
    }
    handler = handlers.get(req.test)
    if handler is None:
        raise HTTPException(status_code=400, detail=f"unknown test: {req.test}")
    try:
        return {"report": handler()}
    except stats_core.StatsInputError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


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
