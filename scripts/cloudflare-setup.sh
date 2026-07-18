#!/usr/bin/env bash
# Cloudflare DNS + SSL setup for Heurion
# Run once during initial deployment. Idempotent.
# Requires GitHub Secrets: CF_API_TOKEN, CF_ZONE_ID, VPS_HOST

set -e

CF_TOKEN="${CF_API_TOKEN:?missing CF_API_TOKEN}"
ZONE_ID="${CF_ZONE_ID:?missing CF_ZONE_ID}"
SERVER_IP="${VPS_HOST:?missing VPS_HOST}"
API="https://api.cloudflare.com/client/v4/zones/$ZONE_ID"

echo "=== Configuring Cloudflare for $SERVER_IP ==="

# 1. DNS records — create or update
for NAME in heurion.org www.heurion.org; do
  EXISTING=$(curl -sf "$API/dns_records?type=A&name=$NAME" -H "Authorization: Bearer $CF_TOKEN")
  RECORD_ID=$(echo "$EXISTING" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || echo "")

  if [ -n "$RECORD_ID" ]; then
    curl -sf -X PATCH "$API/dns_records/$RECORD_ID" \
      -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
      -d "{\"type\":\"A\",\"name\":\"$NAME\",\"content\":\"$SERVER_IP\",\"ttl\":1,\"proxied\":true}" > /dev/null
    echo "  $NAME → $SERVER_IP (updated)"
  else
    curl -sf -X POST "$API/dns_records" \
      -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
      -d "{\"type\":\"A\",\"name\":\"$NAME\",\"content\":\"$SERVER_IP\",\"ttl\":1,\"proxied\":true}" > /dev/null
    echo "  $NAME → $SERVER_IP (created)"
  fi
done

# 2. SSL mode — Flexible (Cloudflare ↔ origin over HTTP)
curl -sf -X PATCH "$API/settings/ssl" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"flexible"}' > /dev/null
echo "  SSL: flexible"

# 3. Always HTTPS
curl -sf -X PATCH "$API/settings/always_use_https" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"on"}' > /dev/null
echo "  Always HTTPS: on"

echo "=== Done ==="
