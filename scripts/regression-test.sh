#!/usr/bin/env bash
# Heurion 完整回归测试 — 模拟肿瘤医生全流程
# 用法: bash scripts/regression-test.sh [base_url]
# 默认: https://heurion.org

BASE="${1:-https://heurion.org}"
USERNAME="HZ"
PASSWORD="hz123456"
PASS=0
FAIL=0
SAMPLE_DIR="packages/server-ts"

check() {
  local label="$1" condition="$2"
  if [ "$condition" = "ok" ]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label — $condition"
    FAIL=$((FAIL + 1))
  fi
}

echo "════════════════════════════════════════════════"
echo "  Heurion 回归测试 — $BASE"
echo "════════════════════════════════════════════════"

# ── 0. Login ──
TOKEN=$(curl -sf -X POST "$BASE/api/v1/auth/login" -H "Content-Type: application/json" -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jwt_token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "✗ Login failed"
  exit 1
fi
H="Authorization: Bearer $TOKEN"
check "Login" ok

# ── 0. Clean data ──
ssh -o StrictHostKeyChecking=no -i ~/.ssh/heurion-do root@174.138.31.245 "
cd ~/heurion/packages/server-ts
node scripts/clear-data.js
rm -rf .nexus/twins/*/event_log.jsonl .nexus/twins/*/facts/ .nexus/twins/*/episodes/ .nexus/twins/*/uploads/*
" 2>/dev/null
check "Clear data" ok

# ── 1. Patient ──
HASH=$(curl -sf -X POST "$BASE/api/v1/dicom/patients/register-manual" -H "$H" -H "Content-Type: application/json" -d '{"initials":"ZQ","age":58,"sex":"M","chief_complaint":"咳嗽胸痛3周"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('patient_hash',''))" 2>/dev/null)
check "Create patient" "$([ -n "$HASH" ] && echo ok || echo 'no hash')"

DETAIL=$(curl -sf "$BASE/api/v1/dicom/patients/$HASH/detail" -H "$H" 2>/dev/null)
check "Patient detail" "$(echo "$DETAIL" | python3 -c "import sys,json; j=json.load(sys.stdin); print('ok' if j.get('initials')=='ZQ' else 'wrong')" 2>/dev/null)"

LIST=$(curl -sf "$BASE/api/v1/dicom/patients/full" -H "$H" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
check "Patient count=1" "$([ "$LIST" = "1" ] && echo ok || echo "got $LIST")"

# ── 2. Upload DICOM + Quick Scan ──
DCM=$(curl -sf -X POST "$BASE/api/v1/files/upload" -H "$H" -F "file=@$SAMPLE_DIR/sample-chest-ct.dcm" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_id',''))" 2>/dev/null)
check "Upload DICOM" "$([ -n "$DCM" ] && echo ok || echo 'no file_id')"

SCAN=$(curl -sf -X POST "$BASE/api/v1/dicom/studies/$DCM/quick-scan" -H "$H" 2>/dev/null)
FINDINGS=$(echo "$SCAN" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('findings',[])))" 2>/dev/null)
check "Quick Scan findings > 0" "$([ "${FINDINGS:-0}" -gt 0 ] && echo ok || echo "got $FINDINGS")"

# ── 3. Viewer Thumbnail ──
THUMB=$(curl -sf -o /dev/null -w "%{http_code},%{size_download}" "$BASE/api/v1/dicom/studies/$DCM/series/0/render?index=0&format=png" -H "$H" 2>/dev/null)
check "Viewer thumbnail" "$(echo "$THUMB" | python3 -c "import sys; parts=sys.stdin.read().split(','); print('ok' if parts[0]=='200' and int(parts[1])>100 else f'{parts[0]}/{parts[1]}B')" 2>/dev/null)"

# ── 4. Chat AI Analysis ──
CHAT=$(curl -sf -N -X POST "$BASE/api/v1/agent/chat" -H "$H" -H "Content-Type: application/json" -d "{\"text\":\"分析这个患者的CT结果，简短回答\",\"patient_hash\":\"$HASH\"}" 2>/dev/null)
check "Chat response" "$(echo "$CHAT" | grep -q 'turn_complete' && echo ok || echo 'no turn_complete')"

# ── 5. Gemini Vision ──
sleep 8
PROFILE=$(curl -sf "$BASE/api/v1/dicom/patients/$HASH/detail" -H "$H" 2>/dev/null)
AI_VISION=$(echo "$PROFILE" | python3 -c "import sys,json; j=json.load(sys.stdin); print('ok' if '[AI Vision]' in j.get('chief_complaint','') else 'missing')" 2>/dev/null)
check "Gemini Vision in profile" "$AI_VISION"

# ── 6. Memory Projection ──
MEMORY=$(curl -sf "$BASE/api/v1/memory/patient/$HASH/projection" -H "$H" 2>/dev/null)
MEM_FINDINGS=$(echo "$MEMORY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('findings',[])))" 2>/dev/null)
check "Memory findings > 0" "$([ "${MEM_FINDINGS:-0}" -gt 0 ] && echo ok || echo "got $MEM_FINDINGS")"

# ── 7. Research Study ──
SID=$(curl -sf -X POST "$BASE/api/v1/research/studies" -H "$H" -H "Content-Type: application/json" -d '{"display_name":"NSCLC Immunotherapy Phase II","short_code":"NSCLC001"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('study_id',''))" 2>/dev/null)
check "Create study" "$([ -n "$SID" ] && echo ok || echo 'no study_id')"

STUDIES=$(curl -sf "$BASE/api/v1/research/studies" -H "$H" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
check "Study count=1" "$([ "$STUDIES" = "1" ] && echo ok || echo "got $STUDIES")"

# ── 8. Document ──
DID=$(curl -sf -X POST "$BASE/api/v1/docs" -H "$H" -H "Content-Type: application/json" -d '{"title":"ZQ Case Report"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "Create document" "$([ -n "$DID" ] && echo ok || echo 'no doc_id')"

curl -sf -X PUT "$BASE/api/v1/docs/$DID" -H "$H" -H "Content-Type: application/json" -d '{"body":"58yo M, cT2aN2M0 IIIA NSCLC"}' > /dev/null 2>&1
DOC_BODY=$(curl -sf "$BASE/api/v1/docs/$DID" -H "$H" | python3 -c "import sys,json; print(json.load(sys.stdin).get('body',''))" 2>/dev/null)
check "Document content" "$(echo "$DOC_BODY" | grep -q 'IIIA' && echo ok || echo 'missing IIIA')"

DOCS=$(curl -sf "$BASE/api/v1/docs" -H "$H" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('docs',[])))" 2>/dev/null)
check "Doc count=1" "$([ "$DOCS" = "1" ] && echo ok || echo "got $DOCS")"

# ── 9. Calendar ──
CAL=$(curl -sf "$BASE/api/v1/calendar/export.ics?token=$TOKEN" 2>/dev/null)
check "Calendar iCal" "$(echo "$CAL" | grep -q 'VCALENDAR' && echo ok || echo 'no VCALENDAR')"

# ── 10. Summary ──
echo ""
echo "════════════════════════════════════════════════"
echo "  Results: $((PASS + FAIL)) tests, $PASS passed, $FAIL failed"
echo "  Patient: $HASH | Study: ${SID:-N/A} | Doc: ${DID:-N/A}"
echo "  $BASE"
echo "════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
