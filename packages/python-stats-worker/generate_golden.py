"""#405: generate golden reference values for the TS↔Python cross-check.
Run with the stats venv: python generate_golden.py > golden/stats_golden.json
Values are frozen into the repo; CI replays the same cases through both the
Python core and the TS stat-tools and asserts < 1e-8 agreement.
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import stats_core

CASES = {
    "welch_normal": {"test": "t-test", "group_a": [10, 11, 12, 13, 14, 15, 16, 17], "group_b": [1, 2, 3, 4, 5, 6, 7, 8]},
    "welch_small_n": {"test": "t-test", "group_a": [5.1, 5.2, 5.3], "group_b": [4.9, 4.8, 4.7]},
    "welch_unequal_var": {"test": "t-test", "group_a": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "group_b": [100, 102, 98, 101, 99]},
    "mann_whitney_degrade": {"test": "t-test", "group_a": [0.1, 0.2, 3.0, 4.0, 5.0, 6.0, 0.3, 0.4, 7.0, 8.0], "group_b": [10, 11, 12, 13, 14, 15, 0.5, 0.6, 16, 17]},
    "chisq_2x2_assoc": {"test": "chi-square", "table": [[90, 10], [20, 80]]},
    "chisq_2x2_indep": {"test": "chi-square", "table": [[50, 50], [50, 50]]},
    "chisq_3x2": {"test": "chi-square", "table": [[30, 20, 10], [10, 20, 30]]},
    "chisq_small": {"test": "chi-square", "table": [[5, 1], [1, 5]]},
    "km_split": {"test": "kaplan-meier", "survival_a": [{"time": t, "event": True} for t in range(1, 11)], "survival_b": [{"time": t + 5, "event": True} for t in range(1, 11)]},
    "km_censored": {"test": "kaplan-meier", "survival_a": [{"time": 2, "event": False}, {"time": 3, "event": True}, {"time": 4, "event": False}, {"time": 5, "event": True}], "survival_b": [{"time": 6, "event": False}, {"time": 7, "event": False}, {"time": 8, "event": True}]},
    "km_small": {"test": "kaplan-meier", "survival_a": [{"time": 1, "event": True}, {"time": 2, "event": True}, {"time": 3, "event": False}], "survival_b": [{"time": 1, "event": False}, {"time": 2, "event": True}]},
    # 复审（覆盖缺漏）：describe / two-way-anova 报告形状此前未进 golden，
    # 漂移只会在运行时 safeParse 才炸。二者为 Python 权威（TS fallback 无
    # two-way-anova 引擎；cross-check 对拍 harness 只比 test_stat/p_value/
    # effect_size/df，describe 无此键），故 ts_skip。
    "describe_basic": {"test": "describe", "values": [10, 12, 9, 15, 11, 13, 10, 14, 12, 11]},
    "anova_2way": {"test": "two-way-anova", "group": ["A", "A", "A", "A", "B", "B", "B", "B"], "factor_a": ["X", "X", "Y", "Y", "X", "X", "Y", "Y"], "values": [5.1, 4.9, 8.2, 8.0, 6.3, 6.5, 9.4, 9.2]},
}


def run_case(name: str, case: dict) -> dict:
    test = case["test"]
    if test == "t-test":
        return stats_core.welch_t(case["group_a"], case["group_b"])
    if test == "chi-square":
        return stats_core.chi_square(case["table"])
    if test == "kaplan-meier":
        return stats_core.kaplan_meier(
            [r["time"] for r in case["survival_a"]], [r["event"] for r in case["survival_a"]],
            [r["time"] for r in case["survival_b"]], [r["event"] for r in case["survival_b"]],
        )
    if test == "describe":
        return stats_core.describe(case["values"])
    if test == "two-way-anova":
        res = stats_core.two_way_anova(case["group"], case["factor_a"], case["values"])
        # engine 对 anova 表不 round — fixture 层按 #1109 报告 6 位小数
        # 约定取整，保证跨 statsmodels/numpy 版本重生成无低位漂移。
        res["report"] = {k: {"f": round(v["f"], 6), "p": round(v["p"], 6)} for k, v in res["report"].items()}
        return res
    raise ValueError(test)


def main() -> None:
    out = {}
    for name, case in CASES.items():
        res = run_case(name, case)
        out[name] = {"input": case, "expected": {k: v for k, v in res.items() if k != "gating"}}
    # TS 启发式门控/删失细节未精确对齐的用例由 Python 权威（#405）——对拍跳过。
    # describe / two-way-anova 同为 Python 权威（见 CASES 注释）——对拍跳过。
    for skip in ("mann_whitney_degrade", "km_censored", "km_small", "describe_basic", "anova_2way"):
        if skip in out:
            out[skip]["ts_skip"] = True
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
