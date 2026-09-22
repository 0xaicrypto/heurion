#!/usr/bin/env bash
# #941 — contracts(TS zod) × python-stats-worker(pydantic) 镜像 schema
# 形状对齐检查。golden fixture 双端解析必须全部通过：字段漂移任一端
# 先炸，注释里的「保持同步」升级为机读约束。
#
# #1109 — 追加报告形状对齐：golden（python 权威产出）逐条过
# statsReportSchema（method 判别联合）+ 一条报告负样本（缺 p_value 必须
# 被拒绝），request 与 report 两端都有机读约束。
#
# 复审（覆盖缺漏）— step 4 追加：`descriptive` 与 `two_way_anova` 两个
# 联合分支必须在 golden 中有正样本（shape 漂移在机读检查即拦，不再等
# 运行时 safeParse）+ 各自的缺必需键负样本。
#
# Usage: bash scripts/check-stats-schema-alignment.sh   (repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

FIXTURE="$ROOT/packages/python-stats-worker/fixture_stats_request.json"
GOLDEN="$ROOT/packages/python-stats-worker/golden/stats_golden.json"

# Python: repo-root .venv (stats deps installed there) when present, else PATH python3.
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY=python3

echo "── 1/4 TS zod 端（contracts dist）…"
node --input-type=module -e "
import { statsRequestSchema } from '$ROOT/packages/contracts/dist/index.js'
import fs from 'fs'
const fixture = JSON.parse(fs.readFileSync('$FIXTURE', 'utf8'))
const r = statsRequestSchema.safeParse(fixture.request)
if (!r.success) {
  console.error('zod 端拒绝 fixture:', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('；'))
  process.exit(1)
}
console.log('  ✓ zod 解析通过（' + Object.keys(fixture.request).length + ' 字段）')
"

echo "── 2/4 pydantic 端（python-stats-worker）…"
"$PY" - "$FIXTURE" << 'PYEOF'
import json, sys, os
os.chdir(os.path.dirname(os.path.abspath(sys.argv[1])))
from main import AnalyzeRequest
fixture = json.load(open(sys.argv[1], 'r'))
AnalyzeRequest(**fixture['request'])
print('  ✓ pydantic 解析通过（%d 字段）' % len(fixture['request']))
PYEOF

echo "── 3/4 双端拒绝负样本（形状漂移会被拦截）…"
# fixture_stats_request.bad.json        — test 类型错误
# fixture_stats_request.survival-missing.bad.json — survival 记录缺 time/event
# （#严重-2：缺字段曾因 Optional 被静默补成 t=0/删失，必须两端都拒绝）
for BAD in \
  "$ROOT/packages/python-stats-worker/fixture_stats_request.bad.json" \
  "$ROOT/packages/python-stats-worker/fixture_stats_request.survival-missing.bad.json"; do
node --input-type=module -e "
import { statsRequestSchema } from '$ROOT/packages/contracts/dist/index.js'
import fs from 'fs'
const r = statsRequestSchema.safeParse(JSON.parse(fs.readFileSync('$BAD', 'utf8')).request)
if (r.success) { console.error('zod 端接受了本应拒绝的负样本: $BAD'); process.exit(1) }
"
"$PY" - "$BAD" << 'PYEOF'
import json, sys, os
os.chdir(os.path.dirname(os.path.abspath(sys.argv[1])))
from pydantic import ValidationError
from main import AnalyzeRequest
try:
    AnalyzeRequest(**json.load(open(sys.argv[1], 'r'))['request'])
except ValidationError:
    sys.exit(0)
sys.exit('pydantic 端接受了本应拒绝的负样本: ' + sys.argv[1])
PYEOF
done
echo "  ✓ 类型错误 + survival 缺字段负样本双端均被拒绝"

echo "── 4/4 报告形状对齐（golden → statsReportSchema, #1109）…"
node --input-type=module -e "
import { statsReportSchema } from '$ROOT/packages/contracts/dist/index.js'
import fs from 'fs'
const golden = JSON.parse(fs.readFileSync('$GOLDEN', 'utf8'))
const methods = new Set()
for (const [name, entry] of Object.entries(golden)) {
  const r = statsReportSchema.safeParse(entry.expected)
  if (!r.success) {
    console.error('golden 用例 ' + name + ' 未通过报告 schema:', r.error.issues.slice(0, 3).map((i) => i.path.join('.') + ': ' + i.message).join('；'))
    process.exit(1)
  }
  methods.add(r.data.method)
}
console.log('  ✓ ' + Object.keys(golden).length + ' 条 golden 报告全部通过（method 集合: ' + [...methods].join(', ') + '）')
// 联合分支正覆盖：descriptive / two_way_anova 必须有 golden 正样本 —
// 缺位即失败，防止这两个分支的形状漂移只到运行时 safeParse 才暴露。
for (const m of ['descriptive', 'two_way_anova']) {
  if (!methods.has(m)) { console.error('golden 缺少 method=' + m + ' 的正样本（联合分支覆盖缺漏）'); process.exit(1) }
}
console.log('  ✓ 联合分支覆盖: descriptive + two_way_anova 正样本在位')
// 负样本：welch 报告缺 p_value 必须被拒绝（catches missing required keys）
const sample = { ...Object.values(golden)[0].expected }
const drifted = { ...sample, p_value: undefined }
const bad = statsReportSchema.safeParse(drifted)
if (bad.success) { console.error('报告负样本被接受（缺 p_value 未拦截）'); process.exit(1) }
console.log('  ✓ 报告负样本（缺 p_value）被拒绝')
// 分支级负样本：各新覆盖分支缺自己的必需键必须被拒绝（缺位时联合
// 可能落入同 method 字面量外的宽松匹配 — 显式钉死两个分支的判别语义）。
const descSample = Object.values(golden).find((e) => e.expected.method === 'descriptive').expected
if (statsReportSchema.safeParse({ ...descSample, sd: undefined }).success) {
  console.error('descriptive 负样本被接受（缺 sd 未拦截）'); process.exit(1)
}
console.log('  ✓ descriptive 负样本（缺 sd）被拒绝')
const anovaSample = Object.values(golden).find((e) => e.expected.method === 'two_way_anova').expected
if (statsReportSchema.safeParse({ ...anovaSample, report: { ...anovaSample.report, interaction: undefined } }).success) {
  console.error('two_way_anova 负样本被接受（缺 interaction 项未拦截）'); process.exit(1)
}
console.log('  ✓ two_way_anova 负样本（缺 interaction）被拒绝')
"

echo "✓ 双端 schema 形状对齐通过（正向 + 负样本 + golden 报告形状）"
