"""#404: correctness smoke — scipy implementations vs known values."""
import math

import pytest

from stats_core import StatsInputError, chi_square, describe, kaplan_meier, welch_t


def test_describe():
    out = describe([1, 2, 3, 4, 5])
    assert out["n"] == 5
    assert out["mean"] == 3
    assert out["median"] == 3


def test_welch_significant():
    out = welch_t([10, 11, 12, 13, 14], [1, 2, 3, 4, 5])
    assert out["p_value"] < 0.01
    assert out["test_stat"] > 5


def test_chi_square_table_reference():
    # 2x2 with strong association → small p.
    out = chi_square([[90, 10], [20, 80]])
    assert out["p_value"] < 0.001
    assert out["df"] == 1


def test_kaplan_meier_logrank():
    ta = list(range(1, 11))
    ea = [True] * 10
    tb = [i + 5 for i in range(1, 11)]
    eb = [True] * 10
    out = kaplan_meier(ta, ea, tb, eb)
    assert out["method"] == "kaplan_meier_logrank"
    assert out["p_value"] < 0.05
    assert len(out["curve_a"]) > 0
    assert out["curve_a"][0]["survival"] <= 1.0


def test_chi_square_no_association():
    out = chi_square([[50, 50], [50, 50]])
    assert out["p_value"] > 0.9


# ── #严重-1: degenerate inputs must fail loud, never report NaN as "n.s." ──

def test_welch_rejects_single_observation():
    # n=1 → variance 0/0 = NaN. Pre-fix this returned p_value=nan, which
    # downstream read as "差异无统计学意义".
    with pytest.raises(StatsInputError, match="at least 2"):
        welch_t([5.0], [100, 101, 102])


def test_welch_rejects_constant_groups():
    with pytest.raises(StatsInputError, match="zero variance"):
        welch_t([5.0, 5.0, 5.0], [7.0, 7.0, 7.0])


def test_welch_rejects_non_finite_values():
    with pytest.raises(StatsInputError, match="non-finite"):
        welch_t([1.0, float("nan"), 3.0], [4.0, 5.0, 6.0])


def test_describe_rejects_empty():
    with pytest.raises(StatsInputError):
        describe([])


def test_chi_square_rejects_zero_table():
    with pytest.raises(StatsInputError):
        chi_square([[0, 0], [0, 0]])


def test_kaplan_meier_rejects_all_censored():
    with pytest.raises(StatsInputError, match="all censored"):
        kaplan_meier([1, 2], [False, False], [3, 4], [False, False])


def test_kaplan_meier_rejects_length_mismatch():
    with pytest.raises(StatsInputError, match="length mismatch"):
        kaplan_meier([1, 2], [True], [3], [True])
