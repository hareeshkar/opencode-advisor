#!/usr/bin/env python3
"""Mechanical row reconciliation: every scenario id in the test plan must have a
verdict row in the report. Extracts plan IDs and report IDs and diffs them.
Also counts PASS/FAIL verdicts in the report matrix rows."""
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).parent
PLAN = HERE.parent / "TEST-PLAN-v0.9.1.md"
REPORT = HERE.parent / "REGRESSION-0.8.0.md"

plan = PLAN.read_text()
report = REPORT.read_text()
# Only the v0.9.1 section counts; earlier sections of this file belong to the
# v0.7.1 / v0.9.0 reports and reuse the same row-id space (B1..B6, C11, D8).
MARK = "# v0.9.1 full verification"
if MARK in report:
    report = report[report.index(MARK):]
else:
    print("WARNING: v0.9.1 section marker not found; scanning whole file")

# Scenario ids: A1..A6, B1..B8, C1..C5, D1..D7, E1..E7, F1..F8, G1..G6, H1..H10
plan_ids = sorted(set(re.findall(r"^\| \*{0,2}([A-H]\d{1,2})\*{0,2} \|", plan, re.M)))
# Report matrix rows: | A1 | ... | **PASS** | ... |
rep_rows = re.findall(r"^\| \*{0,2}([A-H]\d{1,2})\*{0,2} \|.*?\|\s*\*\*(PASS|FAIL|PARTIAL|SKIP|N/A)\b", report, re.M)
report_ids = [i for i, _ in rep_rows]

missing = [i for i in plan_ids if i not in report_ids]
extra = [i for i in report_ids if i not in plan_ids]

print(f"plan scenario ids   : {len(plan_ids)}  {plan_ids}")
print(f"report matrix rows  : {len(report_ids)}  {sorted(set(report_ids))}")
print(f"MISSING from report : {missing if missing else 'none'}")
print(f"in report not in plan: {extra if extra else 'none'}")

verdicts = {}
for _, v in rep_rows:
    verdicts[v] = verdicts.get(v, 0) + 1
print(f"verdict tally       : {verdicts}")
dupes = [i for i in set(report_ids) if report_ids.count(i) > 1]
print(f"duplicate rows      : {dupes if dupes else 'none'}")
print("RECONCILED=" + ("YES" if not missing else "NO"))
sys.exit(0 if not missing else 1)
