"""#404: HTTP layer — request validation + routing."""
import math

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from main import AnalyzeRequest, run_analysis


def test_run_analysis_routes():
    req = AnalyzeRequest(test="t-test", group_a=[1, 2, 3], group_b=[5, 6, 7])
    assert run_analysis(req)["report"]["method"] == "welch_t"

    req2 = AnalyzeRequest(test="describe", values=[1, 2, 3])
    assert run_analysis(req2)["report"]["n"] == 3


def test_unknown_test_rejected():
    with pytest.raises(HTTPException):
        run_analysis(AnalyzeRequest(test="anova"))


# ── #严重-2: survival records are required-field shaped (zod parity) ──

def test_survival_record_requires_time_and_event():
    with pytest.raises(ValidationError):
        AnalyzeRequest(test="kaplan-meier", survival_a=[{"time": 1}])
    with pytest.raises(ValidationError):
        AnalyzeRequest(test="kaplan-meier", survival_a=[{"event": True}])
    req = AnalyzeRequest(test="kaplan-meier", survival_a=[{"time": 1, "event": True}], survival_b=[{"time": 2, "event": False}])
    assert run_analysis(req)["report"]["method"] == "kaplan_meier_logrank"


# ── #严重-1: degenerate stats are a 400, never a NaN report ──

def test_single_observation_is_http_400_not_nan():
    with pytest.raises(HTTPException) as exc:
        run_analysis(AnalyzeRequest(test="t-test", group_a=[5.0], group_b=[100, 101, 102]))
    assert exc.value.status_code == 400
    assert "at least 2" in str(exc.value.detail)


def test_valid_small_group_report_is_finite():
    out = run_analysis(AnalyzeRequest(test="t-test", group_a=[1, 2, 3], group_b=[4, 5, 6]))["report"]
    assert math.isfinite(out["p_value"])
