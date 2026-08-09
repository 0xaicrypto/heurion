"""#404: correctness smoke — scipy implementations vs known values."""
import math

from stats_core import chi_square, describe, kaplan_meier, welch_t


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
