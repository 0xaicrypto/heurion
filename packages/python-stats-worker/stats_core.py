"""#404: statistics core — scipy/statsmodels/lifelines implementations.
Every function returns the unified shape the TS handler produces:
{ method, test_stat, p_value, effect_size, df?, interpretation, ci? }.

#严重-1: degenerate inputs (n=1 → 0/0 variance, all-constant groups, empty
tables, all-censored survival) MUST fail loudly. A NaN p-value is falsy
against `p < 0.05`, so returning it would silently masquerade "insufficient
data" as "no statistically significant difference" in a clinical report.
StatsInputError is mapped to HTTP 400 in main.py.
"""
import math
from typing import Any, Dict, List

import numpy as np
from scipy import stats


class StatsInputError(ValueError):
    """Invalid or degenerate statistical input — HTTP 400 at the API boundary."""


def _finite_array(values: List[float], field: str, min_size: int = 1) -> np.ndarray:
    a = np.asarray(values, dtype=float)
    if a.size < min_size:
        raise StatsInputError(f"{field} needs at least {min_size} value(s), got {a.size}")
    if not np.all(np.isfinite(a)):
        raise StatsInputError(f"{field} contains non-finite values (NaN/Inf)")
    return a


def _require_finite(**stats_: float) -> None:
    bad = [name for name, v in stats_.items() if not math.isfinite(float(v))]
    if bad:
        raise StatsInputError(f"non-finite statistic(s) produced: {', '.join(bad)} — inputs too degenerate for a report")


def describe(values: List[float]) -> Dict[str, Any]:
    a = _finite_array(values, "values")
    q1, med, q3 = np.percentile(a, [25, 50, 75])
    return {
        "method": "descriptive",
        "n": int(a.size),
        "mean": round(float(a.mean()), 6),
        "median": round(float(med), 6),
        "sd": round(float(a.std(ddof=1)), 6),
        "q1": round(float(q1), 6),
        "q3": round(float(q3), 6),
        "min": round(float(a.min()), 6),
        "max": round(float(a.max()), 6),
    }


def _shapiro_ok(sample: np.ndarray, alpha: float = 0.05) -> bool:
    # Shapiro needs n>=3; outside [3, 5000] the gate is skipped. welch_t
    # separately rejects n<2 (variance undefined) before reaching here.
    if sample.size < 3 or sample.size > 5000:
        return True  # Shapiro unreliable outside this range — gate skipped
    _, p = stats.shapiro(sample)
    return bool(p >= alpha)


def welch_t(group_a: List[float], group_b: List[float]) -> Dict[str, Any]:
    a = _finite_array(group_a, "group_a")
    b = _finite_array(group_b, "group_b")
    # 严重-1: n=1 → var undefined (0/0) → scipy returns NaN; NaN < 0.05 is
    # False downstream → fabricated "no difference". Reject instead.
    if a.size < 2 or b.size < 2:
        raise StatsInputError(
            "Welch t-test needs at least 2 observations per group "
            f"(got n_a={a.size}, n_b={b.size}) — variance is undefined below that"
        )

    # #405: normality gate — non-normal data auto-degrades to Mann-Whitney
    # and the report declares the switch (never silently).
    norm_a, norm_b = _shapiro_ok(a), _shapiro_ok(b)
    gating = {"normality_gate": "passed", "declared": True}
    if not (norm_a and norm_b):
        gating = {"normality_gate": "failed", "auto_degraded_to": "mann_whitney", "declared": True}
        u, p = stats.mannwhitneyu(a, b, alternative="two-sided")
        _require_finite(u=u, p=p)
        n1, n2 = a.size, b.size
        d = 1 - (2 * u) / (n1 * n2)
        return {
            "method": "mann_whitney",
            "test_stat": round(float(u), 6),
            "p_value": round(float(p), 6),
            "effect_size": round(float(d), 6),
            "interpretation": "差异有统计学意义" if p < 0.05 else "差异无统计学意义",
            "gating": gating,
        }

    n1, n2 = a.size, b.size
    v1, v2 = a.var(ddof=1), b.var(ddof=1)
    # Both groups constant → se=0 → t and df are 0/0; the p-value is
    # undefined, not "not significant".
    if v1 <= 0 and v2 <= 0:
        raise StatsInputError("zero variance in both groups — Welch t-test is undefined")
    se = math.sqrt(v1 / n1 + v2 / n2)
    if not math.isfinite(se) or se <= 0:
        raise StatsInputError("zero standard error — Welch t-test is undefined for these samples")
    t, p = stats.ttest_ind(a, b, equal_var=False)
    df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
    _require_finite(t=t, p=p, df=df)
    pooled = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
    d = (a.mean() - b.mean()) / pooled if pooled else 0.0
    # Welch–Satterthwaite CI for the mean difference.
    ci_lo = (a.mean() - b.mean()) - stats.t.ppf(0.975, df) * se
    ci_hi = (a.mean() - b.mean()) + stats.t.ppf(0.975, df) * se
    _require_finite(ci_lo=ci_lo, ci_hi=ci_hi, effect_size=d)
    return {
        "method": "welch_t",
        "test_stat": round(float(t), 6),
        "df": round(float(df), 6),
        "p_value": round(float(p), 6),
        "effect_size": round(float(d), 6),
        "ci_95": [round(float(ci_lo), 6), round(float(ci_hi), 6)],
        "interpretation": "差异有统计学意义" if p < 0.05 else "差异无统计学意义",
        "gating": gating,
    }


def chi_square(table: List[List[float]]) -> Dict[str, Any]:
    arr = np.asarray(table, dtype=float)
    if arr.ndim != 2 or min(arr.shape) < 2:
        raise StatsInputError("contingency table must be at least 2×2")
    if not np.all(np.isfinite(arr)):
        raise StatsInputError("contingency table contains non-finite values")
    if np.any(arr < 0):
        raise StatsInputError("contingency table contains negative counts")
    if arr.sum() <= 0:
        raise StatsInputError("contingency table is all zeros — chi-square is undefined")
    try:
        chi2, p, df, _ = stats.chi2_contingency(arr, correction=False)
    except ValueError as err:
        # e.g. a zero row/column → zero expected counts.
        raise StatsInputError(f"chi-square undefined for this table: {err}") from err
    _require_finite(chi2=chi2, p=p)
    n = float(arr.sum())
    # Cramér's V effect size.
    v = math.sqrt(max(0.0, float(chi2) / (n * (min(arr.shape) - 1)))) if n > 0 else 0.0
    return {
        "method": "chisq",
        "test_stat": round(float(chi2), 6),
        "df": int(df),
        "p_value": round(float(p), 6),
        "effect_size": round(float(v), 6),
        "interpretation": "存在关联" if p < 0.05 else "无显著关联",
    }


def kaplan_meier(times_a: List[float], events_a: List[bool], times_b: List[float], events_b: List[bool]) -> Dict[str, Any]:
    from lifelines import KaplanMeierFitter
    from lifelines.statistics import logrank_test

    if len(times_a) != len(events_a) or len(times_b) != len(events_b):
        raise StatsInputError("survival times/events length mismatch — each record needs both fields")
    a_t = _finite_array(times_a, "times_a")
    a_e = np.asarray([1 if e else 0 for e in events_a])
    b_t = _finite_array(times_b, "times_b")
    b_e = np.asarray([1 if e else 0 for e in events_b])
    if np.any(a_t < 0) or np.any(b_t < 0):
        raise StatsInputError("survival times must be non-negative")
    # All-censored (or empty) groups → log-rank p is NaN, which downstream
    # would render as "no significant difference".
    if not a_e.any() and not b_e.any():
        raise StatsInputError("no observed events in either group — log-rank test is undefined (all censored)")

    kmf = KaplanMeierFitter()
    kmf.fit(a_t, a_e)
    sf = kmf.survival_function_
    curve_a = [{"time": float(t), "survival": round(float(s), 6)} for t, s in zip(sf.index, sf["KM_estimate"])]
    kmf.fit(b_t, b_e)
    sf = kmf.survival_function_
    curve_b = [{"time": float(t), "survival": round(float(s), 6)} for t, s in zip(sf.index, sf["KM_estimate"])]

    result = logrank_test(a_t, b_t, event_observed_a=a_e, event_observed_b=b_e)
    p = result.p_value
    chi2 = result.test_statistic
    _require_finite(p=p, chi2=chi2)
    return {
        "method": "kaplan_meier_logrank",
        "test_stat": round(float(chi2), 6),
        "p_value": round(float(p), 6),
        "effect_size": None,
        "interpretation": "生存曲线差异有统计学意义" if p < 0.05 else "生存曲线无显著差异",
        "curve_a": curve_a,
        "curve_b": curve_b,
    }


def two_way_anova(group: List[str], factor_a: List[str], values: List[float]) -> Dict[str, Any]:
    """Two-way ANOVA via statsmodels — factor_a is the second factor."""
    import statsmodels.api as sm
    from statsmodels.formula.api import ols

    y = _finite_array(values, "values")
    if len(group) != len(y) or len(factor_a) != len(y):
        raise StatsInputError("group/factor_a/values must all have the same length")
    if len(set(group)) < 2 or len(set(factor_a)) < 2:
        raise StatsInputError("two-way ANOVA needs at least 2 levels in each factor")
    data = {"g": group, "f": factor_a, "y": values}
    try:
        model = ols("y ~ C(g) + C(f) + C(g):C(f)", data=data).fit()
        table = sm.stats.anova_lm(model, typ=2)
    except Exception as err:  # noqa: BLE001 — normalize statsmodels failures to 400
        raise StatsInputError(f"two-way ANOVA undefined for these groups: {err}") from err
    for term in ("C(g)", "C(f)", "C(g):C(f)"):
        _require_finite(**{f"{term}.F": table.loc[term, "F"], f"{term}.p": table.loc[term, "PR(>F)"]})
    return {
        "method": "two_way_anova",
        "report": {
            "C(g)": {"f": float(table.loc["C(g)", "F"]), "p": float(table.loc["C(g)", "PR(>F)"])},
            "C(f)": {"f": float(table.loc["C(f)", "F"]), "p": float(table.loc["C(f)", "PR(>F)"])},
            "interaction": {"f": float(table.loc["C(g):C(f)", "F"]), "p": float(table.loc["C(g):C(f)", "PR(>F)"])},
        },
        "interpretation": "至少一个因素显著" if table["PR(>F)"].min() < 0.05 else "均不显著",
    }
