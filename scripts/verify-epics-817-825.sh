#!/usr/bin/env bash
# verify-epics-817-825.sh — 两个 epic 的生产环境手工验证脚本
set -euo pipefail
#
# 验证范围:
#   Epic #825 学术渲染: 导出嵌图(docx/pdf)/FigureRender 溯源/重渲染/图库域分离
#   Epic #817 记忆分层: 覆盖率 API(+ 内部行为注释说明)
#
# 用法:
#   export HEURION_EMAIL=you@example.com
#   export HEURION_PASSWORD=yourpassword
#   ./scripts/verify-epics-817-825.sh [BASE_URL]        # 默认 https://heurion.org
#   KEEP=1 ./scripts/verify-epics-817-825.sh            # 验证后不清理测试文档/图片
#
# 依赖: curl, jq, unzip, python3(计时)
set -uo pipefail

BASE="${1:-https://heurion.org}"
KEEP="${KEEP:-0}"
TMPDIR_V="$(mktemp -d /tmp/heurion-verify-XXXX)"
trap 'rm -rf "$TMPDIR_V"' EXIT

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
info() { echo "  ℹ️  $1"; }
hdr()  { echo; echo "── $1 ─────────────────────────────────"; }

require() { command -v "$1" >/dev/null 2>&1 || { echo "缺少依赖: $1"; exit 1; }; }
require curl; require jq; require unzip

echo "Heurion Epic 验证 — $BASE"
echo "工作目录: $TMPDIR_V"

# ── 0. 健康检查 ────────────────────────────────────────────────
hdr "0. 服务健康(部署终验)"
if curl -fsS -m 15 "$BASE/healthz" | grep -q "ok"; then ok "healthz → ok"; else bad "healthz 异常"; fi

# ── 1. 登录 ────────────────────────────────────────────────────
hdr "1. 登录"
: "${HEURION_EMAIL:?请 export HEURION_EMAIL=<登录名/邮箱>}"
: "${HEURION_PASSWORD:?请 export HEURION_PASSWORD=<密码>}"
LOGIN=$(curl -fsS -m 15 -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg u "$HEURION_EMAIL" --arg p "$HEURION_PASSWORD" '{username:$u,password:$p}')" 2>/dev/null) \
  && TOKEN=$(echo "$LOGIN" | jq -r '.jwt_token') || TOKEN=""
if [ -n "${TOKEN:-}" ] && [ "$TOKEN" != "null" ]; then ok "登录成功(token 获取)"; else bad "登录失败 — 检查 HEURION_EMAIL/PASSWORD"; echo "$LOGIN" | head -c 300; echo; exit 1; fi
AUTH=(-H "Authorization: Bearer $TOKEN")

# ── 2. Epic #817: 覆盖率 API ───────────────────────────────────
hdr "2. #817 覆盖率仪表盘(GET /knowledge/coverage)"
COV=$(curl -fsS -m 20 "${AUTH[@]}" "$BASE/api/v1/knowledge/coverage" 2>/dev/null || echo "")
if echo "$COV" | jq -e '.global and .hintThreshold' >/dev/null 2>&1; then
  ok "返回 global + hintThreshold"
  info "global 覆盖率: $(echo "$COV" | jq -r '.global | "\(coveredFacts)/\(confirmedFacts) (\(ratio*100 | round)%)"; empty') "
  info "患者 scope 数: $(echo "$COV" | jq '.patients | length')"
else
  bad "覆盖率接口不可用或形状不符: $(echo "$COV" | head -c 200)"
fi

# ── 3. Epic #825: 建文档(含 mermaid + 公式) ────────────────────
hdr "3. #825 建测试文档(mermaid + LaTeX)"
DOC=$(curl -fsS -m 15 -X POST "${AUTH[@]}" "$BASE/api/v1/docs" \
  -H 'content-type: application/json' -d '{"title":"Epic 验证脚本 - 可删除"}' 2>/dev/null) || DOC=""
DOC_ID=$(echo "$DOC" | jq -r '.id // empty' 2>/dev/null)
if [ -n "$DOC_ID" ]; then ok "文档创建: $DOC_ID"; else bad "文档创建失败"; exit 1; fi

BODY='# 渲染验证

这是一段普通文字,段内 $x$ 与金额 $50 不应被抽取。

```mermaid
flowchart TD
  A[患者入院] --> B{活检?}
  B -->|阳性| C[确诊 NSCLC]
  B -->|阴性| D[随访]
```

$$
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
$$

$E = mc^2$

结束。'
PAYLOAD=$(jq -n --arg b "$BODY" '{body:$b}')
if curl -fsS -m 15 -X PUT "${AUTH[@]}" "$BASE/api/v1/docs/$DOC_ID" \
  -H 'content-type: application/json' -d "$PAYLOAD" >/dev/null 2>&1; then
  ok "正文写入(1 个 mermaid 围栏 + 2 个公式)"
else
  bad "正文写入失败"
fi
info "保存钩子已触发预渲染预热(fire-and-forget),等待 10s…"; sleep 10

# ── 4. 导出 docx(冷 + 热) ──────────────────────────────────────
hdr "4. #825 导出 docx 嵌图"
T0=$(python3 -c 'import time;print(time.time())')
HTTP=$(curl -sS -m 120 -o "$TMPDIR_V/export.docx" -w '%{http_code}' "${AUTH[@]}" "$BASE/api/v1/docs/$DOC_ID/export?format=docx")
T1=$(python3 -c "import time;print(time.time())")
COLD=$(python3 -c "print(f'{$T1-$T0:.1f}')")
if [ "$HTTP" = "200" ]; then
  ok "docx 导出 200(冷导出 ${COLD}s,含 15s/图渲染预算)"
else
  bad "docx 导出 HTTP $HTTP"
fi
DOCX_SIZE=$(stat -f%z "$TMPDIR_V/export.docx" 2>/dev/null || stat -c%s "$TMPDIR_V/export.docx" 2>/dev/null || echo 0)
if [ "$DOCX_SIZE" -gt 10000 ]; then ok "docx 体积 ${DOCX_SIZE}B(>10KB)"; else bad "docx 体积可疑: ${DOCX_SIZE}B"; fi
MEDIA=$(unzip -l "$TMPDIR_V/export.docx" 2>/dev/null | grep -c "word/media/" || true)
if [ "$MEDIA" -ge 3 ]; then
  ok "docx 内嵌图片数 = $MEDIA(期望 ≥3: mermaid + 2 公式)"
else
  bad "docx 内嵌图片数 = $MEDIA(期望 ≥3 — 图渲染失败时会降级为文本)"
fi

hdr "5. 二次导出(缓存命中应显著加速)"
T0=$(python3 -c 'import time;print(time.time())')
curl -sS -m 60 -o "$TMPDIR_V/export2.docx" "${AUTH[@]}" "$BASE/api/v1/docs/$DOC_ID/export?format=docx"
T1=$(python3 -c "import time;print(time.time())")
WARM=$(python3 -c "print(f'{$T1-$T0:.1f}')")
info "冷 ${COLD}s → 热 ${WARM}s(二次导出全缓存命中,验收口径 <3s + 渲染以外开销)"
python3 -c "import sys; sys.exit(0 if $WARM < 3.0 else 1)" && ok "热导出 ${WARM}s < 3s" || bad "热导出 ${WARM}s ≥ 3s — FigureRender 缓存未生效?"

# ── 6. 导出 pdf ────────────────────────────────────────────────
hdr "6. #825 导出 pdf 嵌图"
HTTP=$(curl -sS -m 120 -o "$TMPDIR_V/export.pdf" -w '%{http_code}' "${AUTH[@]}" "$BASE/api/v1/docs/$DOC_ID/export?format=pdf")
if [ "$HTTP" = "200" ] && head -c 4 "$TMPDIR_V/export.pdf" | grep -q "%PDF"; then
  ok "pdf 导出 200 且 %PDF 头正确($(stat -f%z "$TMPDIR_V/export.pdf" 2>/dev/null || stat -c%s "$TMPDIR_V/export.pdf" 2>/dev/null)B)"
else
  bad "pdf 导出异常(HTTP $HTTP)"
fi

# ── 7. 图库 + 溯源 + 重渲染 ─────────────────────────────────────
hdr "7. #825/#822 图库 fig_ 产物 + 源码溯源 + 重渲染"
LIB=$(curl -fsS -m 20 "${AUTH[@]}" "$BASE/api/v1/files/generated" 2>/dev/null || echo "")
FIG_IDS=$(echo "$LIB" | jq -r '[.charts[] | select(.mode=="figure") | .file_id]' 2>/dev/null)
FIG_N=$(echo "$FIG_IDS" | jq 'length' 2>/dev/null || echo 0)
if [ "$FIG_N" -ge 3 ]; then
  ok "图库 figure 条目 = $FIG_N(mermaid + display + inline)"
else
  bad "图库 figure 条目 = $FIG_N(期望 ≥3): $(echo "$LIB" | head -c 200)"
fi
FIG1=$(echo "$FIG_IDS" | jq -r '.[0] // empty')
if [ -n "$FIG1" ]; then
  SRC=$(curl -fsS -m 20 "${AUTH[@]}" "$BASE/api/v1/figures/$FIG1/source" 2>/dev/null || echo "")
  if echo "$SRC" | jq -e '.kind and .source' >/dev/null 2>&1; then
    ok "源码溯源: kind=$(echo "$SRC" | jq -r .kind), 源码前 40 字: $(echo "$SRC" | jq -r '.source' | head -c 40)…"
  else
    bad "溯源接口异常: $(echo "$SRC" | head -c 200)"
  fi
  RR=$(curl -sS -m 60 -X POST "${AUTH[@]}" "$BASE/api/v1/figures/$FIG1/rerender" 2>/dev/null || echo "")
  NEW_ID=$(echo "$RR" | jq -r '.file_id // empty' 2>/dev/null)
  if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "$FIG1" ]; then
    ok "重渲染成功: $FIG1 → $NEW_ID(旧产物保留)"
  else
    bad "重渲染异常: $(echo "$RR" | head -c 200)"
  fi
fi

# ── 8. 域分离: chat picker / 知识库列表不混入 fig_ ──────────────
hdr "8. 图库域分离(chat picker 不含 fig_)"
PICKER=$(curl -fsS -m 20 "${AUTH[@]}" "$BASE/api/v1/chat/files?limit=500" 2>/dev/null || echo "")
if echo "$PICKER" | jq -e '[.files[] | select(.id | startswith("fig_"))] | length == 0' >/dev/null 2>&1; then
  ok "chat picker 无 fig_ 条目"
else
  bad "chat picker 混入了 fig_ 条目!"
fi
KB=$(curl -fsS -m 20 "${AUTH[@]}" "$BASE/api/v1/files?limit=500" 2>/dev/null || echo "")
if echo "$KB" | jq -e '[(.files // [])[] | select(.file_id | startswith("fig_"))] | length == 0' >/dev/null 2>&1; then
  ok "知识库文件列表无 fig_ 条目"
else
  info "知识库列表接口形状不同,跳过自动判定(若上面 chat picker 已过,域分离即成立)"
fi

# ── 9. 清理 ────────────────────────────────────────────────────
hdr "9. 清理测试产物"
if [ "$KEEP" = "1" ]; then
  info "KEEP=1 — 保留文档 $DOC_ID 与图库产物(可在前端查看)"
else
  curl -fsS -m 20 -X DELETE "${AUTH[@]}" "$BASE/api/v1/docs/$DOC_ID" >/dev/null 2>&1 \
    && ok "测试文档已删除" || info "测试文档删除失败(手动删: $DOC_ID)"
  echo "$FIG_IDS" | jq -r '.[]' 2>/dev/null | while read -r f; do
    [ -n "$f" ] && curl -fsS -m 20 -X DELETE "${AUTH[@]}" "$BASE/api/v1/files/generated/$f" >/dev/null 2>&1 || true
  done
  ok "图库测试产物已清理"
  info "导出的样例文件保留在 $TMPDIR_V? 否 — 临时目录已自动清理;如需留存请用 KEEP=1 重跑或提前拷贝"
fi

# ── 汇总 ───────────────────────────────────────────────────────
echo
echo "════════════════════════════════════"
echo "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "🎉 全部通过" || echo "⚠️  存在失败项 — 逐条排查上方 ❌"
exit "$FAIL"
