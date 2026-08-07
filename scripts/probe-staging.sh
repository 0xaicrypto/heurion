#!/usr/bin/env bash
# One-off probe for staging (port 8002). Uploaded and run via the
# vps-volume-inspect diagnostic workflow.
set -u
BASE="http://localhost:8002"

printf '%s' '{"username":"HZ","password":"hz123456","display_name":"Test"}' > /tmp/reg.json
REG=$(curl -s -X POST "$BASE/api/v1/auth/register" -H 'Content-Type: application/json' --data-binary @/tmp/reg.json)
TOKEN=$(echo "$REG" | grep -oE 'eyJ[A-Za-z0-9._-]+' | head -1)
echo "register: $(echo "$REG" | head -c 100)"
echo "token: ${TOKEN:0:12}..."

printf '%s' '{"text":"ping","patient_hash":"__probe__"}' > /tmp/chat.json
echo "--- chat response (first 700 chars) ---"
curl -sN -m 90 -X POST "$BASE/api/v1/agent/chat" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @/tmp/chat.json | head -c 700
echo
echo "--- last 30 lines of staging error log ---"
tail -30 ~/.pm2/logs/heurion-staging-error.log 2>/dev/null || true
echo "--- last 15 chat-ish lines of staging out log ---"
tail -300 ~/.pm2/logs/heurion-staging-out.log 2>/dev/null | grep -iE "chat|error|llm|provider|statusCode|401|400|500" | tail -15 || true
