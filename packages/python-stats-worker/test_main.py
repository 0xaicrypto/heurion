"""#404: HTTP layer — request validation + routing."""
import pytest
from fastapi import HTTPException

from main import AnalyzeRequest, run_analysis


def test_run_analysis_routes():
    req = AnalyzeRequest(test="t-test", group_a=[1, 2, 3], group_b=[5, 6, 7])
    assert run_analysis(req)["report"]["method"] == "welch_t"

    req2 = AnalyzeRequest(test="describe", values=[1, 2, 3])
    assert run_analysis(req2)["report"]["n"] == 3


def test_unknown_test_rejected():
    with pytest.raises(HTTPException):
        run_analysis(AnalyzeRequest(test="anova"))
