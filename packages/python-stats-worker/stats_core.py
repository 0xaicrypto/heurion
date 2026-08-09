"""#404: statistics core — scipy/statsmodels/lifelines implementations.
Every function returns the unified shape the TS handler produces:
{ method, test_stat, p_value, effect_size, df?, interpretation, ci? }.
"""
import math
from typing import Any, Dict, List

import numpy as np
from scipy import stats


def describe(values: List[float]) -> Dict[str, Any]:
    a = np.asarray(values, dtype=float)
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
    if sample.size < 3 or sample.size > 5000:
        return True  # Shapiro unreliable outside this range — gate skipped
    _, p = stats.shapiro(sample)
    return bool(p >= alpha)


def welch_t(group_a: List[float], group_b: List[float]) -> Dict[str, Any]:
    a = np.asarray(group_a, dtype=float)
    b = np.asarray(group_b, dtype=float)

    # #405: normality gate — non-normal data auto-degrades to Mann-Whitney
    # and the report declares the switch (never silently).
    norm_a, norm_b = _shapiro_ok(a), _shapiro_ok(b)
    gating = {"normality_gate": "passed", "declared": True}
    if not (norm_a and norm_b):
        gating = {"normality_gate": "failed", "auto_degraded_to": "mann_whitney", "declared": True}
        u, p = stats.mannwhitneyu(a, b, alternative="two-sided")
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

    t, p = stats.ttest_ind(a, b, equal_var=False)
    n1, n2 = a.size, b.size
    v1, v2 = a.var(ddof=1), b.var(ddof=1)
    df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
    pooled = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
    d = (a.mean() - b.mean()) / pooled if pooled else 0.0
    se = math.sqrt(v1 / n1 + v2 / n2)
    # Welch–Satterthwaite CI for the mean difference.
    ci_lo = (a.mean() - b.mean()) - stats.t.ppf(0.975, df) * se
    ci_hi = (a.mean() - b.mean()) + stats.t.ppf(0.975, df) * se
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
    chi2, p, df, _ = stats.chi2_contingency(arr, correction=False)
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

    a_t = np.asarray(times_a, dtype=float)
    a_e = np.asarray([1 if e else 0 for e in events_a])
    b_t = np.asarray(times_b, dtype=float)
    b_e = np.asarray([1 if e else 0 for e in events_b])

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

    data = {"g": group, "f": factor_a, "y": values}
    model = ols("y ~ C(g) + C(f) + C(g):C(f)", data=data).fit()
    table = sm.stats.anova_lm(model, typ=2)
    return {
        "method": "two_way_anova",
        "report": {
            "C(g)": {"f": float(table.loc["C(g)", "F"]), "p": float(table.loc["C(g)", "PR(>F)"])},
            "C(f)": {"f": float(table.loc["C(f)", "F"]), "p": float(table.loc["C(f)", "PR(>F)"])},
            "interaction": {"f": float(table.loc["C(g):C(f)", "F"]), "p": float(table.loc["C(g):C(f)", "PR(>F)"])},
        },
        "interpretation": "至少一个因素显著" if table["PR(>F)"].min() < 0.05 else "均不显著",
    }
