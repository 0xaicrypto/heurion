#!/usr/bin/env bash
# One-off probe for staging (port 8002). Runs after the regression suite so
# HZ + a patient already exist. Prints the raw chat SSE and server logs.
set -u
BASE="http://localhost:8002"

printf '%s' '{"username":"HZ","password":"hz123456"}' > /tmp/login.json
LOGIN=$(curl -s -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' --data-binary @/tmp/login.json)
TOKEN=$(echo "$LOGIN" | grep -oE 'eyJ[A-Za-z0-9._-]+' | head -1)
echo "login: $(echo "$LOGIN" | head -c 120)"
echo "token: ${TOKEN:0:12}..."
PATIENT=$(curl -s "$BASE/api/v1/dicom/patients/full" -H "Authorization: Bearer $TOKEN" | grep -oE 'patient_[a-z0-9]+' | head -1)
echo "patient: $PATIENT"

printf '{"text":"ping","patient_hash":"%s"}' "$PATIENT" > /tmp/chat.json
echo "--- chat SSE (first 800 chars) ---"
curl -sN -m 90 -X POST "$BASE/api/v1/agent/chat" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @/tmp/chat.json | head -c 800
echo
echo "--- last 25 lines staging error log ---"
tail -25 ~/.pm2/logs/heurion-staging-error.log 2>/dev/null || tail -25 /root/.pm2/logs/heurion-staging-error.log 2>/dev/null || true
echo "--- last 12 error-ish lines staging out log ---"
tail -400 ~/.pm2/logs/heurion-staging-out.log 2>/dev/null | grep -iE "error|fail|401|400|500|abort|timeout|LLM|llm" | tail -12 || tail -400 /root/.pm2/logs/heurion-staging-out.log 2>/dev/null | grep -iE "error|fail|401|400|500|abort|timeout|LLM|llm" | tail -12 || true
