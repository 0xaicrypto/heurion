#!/usr/bin/env bash
# #941 — contracts(TS zod) × python-stats-worker(pydantic) 镜像 schema
# 形状对齐检查。golden fixture 双端解析必须全部通过：字段漂移任一端
# 先炸，注释里的「保持同步」升级为机读约束。
#
# Usage: bash scripts/check-stats-schema-alignment.sh   (repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

FIXTURE="$ROOT/packages/python-stats-worker/fixture_stats_request.json"

echo "── 1/3 TS zod 端（contracts dist）…"
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

echo "── 2/3 pydantic 端（python-stats-worker）…"
python3 - "$FIXTURE" << 'PYEOF'
import json, sys, os
os.chdir(os.path.dirname(os.path.abspath(sys.argv[1])))
from main import AnalyzeRequest
fixture = json.load(open(sys.argv[1], 'r'))
AnalyzeRequest(**fixture['request'])
print('  ✓ pydantic 解析通过（%d 字段）' % len(fixture['request']))
PYEOF

echo "── 3/3 双端拒绝负样本（形状漂移会被拦截）…"
BAD="$ROOT/packages/python-stats-worker/fixture_stats_request.bad.json"
node --input-type=module -e "
import { statsRequestSchema } from '$ROOT/packages/contracts/dist/index.js'
import fs from 'fs'
const r = statsRequestSchema.safeParse(JSON.parse(fs.readFileSync('$BAD', 'utf8')).request)
if (r.success) { console.error('zod 端接受了本应拒绝的负样本'); process.exit(1) }
"
python3 - "$BAD" << 'PYEOF'
import json, sys, os
os.chdir(os.path.dirname(os.path.abspath(sys.argv[1])))
from pydantic import ValidationError
from main import AnalyzeRequest
try:
    AnalyzeRequest(**json.load(open(sys.argv[1], 'r'))['request'])
except ValidationError:
    sys.exit(0)
sys.exit('pydantic 端接受了本应拒绝的负样本')
PYEOF

echo "✓ 双端 schema 形状对齐通过（正向 + 负样本）"
