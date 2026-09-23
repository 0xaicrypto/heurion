#!/usr/bin/env bash
# Staging 栈部署/刷新 — 在 VPS 上执行（由 deploy-staging.yml 调用）。
# 前置：/opt/heurion-staging 下已有 docker-compose.staging.yml / .env.staging /
#       web-dist（工作流 scp 上传）；生产网络 heurion_nexus-net 已存在。
set -euo pipefail

DEPLOY_DIR="${STAGING_DEPLOY_DIR:-/opt/heurion-staging}"
COMPOSE="docker compose -p heurion-staging --env-file .env.staging -f docker-compose.staging.yml"

cd "$DEPLOY_DIR"
[ -f docker-compose.staging.yml ] || { echo "❌ missing docker-compose.staging.yml in $DEPLOY_DIR" >&2; exit 1; }
[ -f .env.staging ] || { echo "❌ missing .env.staging (run the deploy workflow)" >&2; exit 1; }
[ -d web-dist ] || { echo "❌ missing web-dist/ (run the deploy workflow)" >&2; exit 1; }

# 生产网络必须存在（staging 靠它被 Caddy 反代）。缺了说明生产未部署过。
if ! docker network inspect heurion_nexus-net >/dev/null 2>&1; then
  echo "❌ docker network heurion_nexus-net not found — deploy production first (it creates the network)" >&2
  exit 1
fi

# 可选：清库重来（RESET_DB=1，手工测试前重置数据）。
if [ "${RESET_DB:-0}" = "1" ]; then
  echo "── RESET_DB=1: tearing down staging stack + volumes …"
  $COMPOSE down -v --remove-orphans || true
fi

# 拉镜像：显式超时（生产卡死教训 — 无超时的 pull 会永久挂住 SSH 会话）。
PULLED=0
for i in 1 2 3; do
  if timeout 900 $COMPOSE pull; then PULLED=1; break; fi
  echo "⚠️  compose pull attempt $i/3 failed/timeout, retrying in 10s…"
  sleep 10
done
[ "$PULLED" -eq 1 ] || { echo "❌ staging image pull failed after 3 attempts" >&2; exit 1; }

$COMPOSE up -d --remove-orphans

# 容器级健康检查（不走公网，先确认应用起来）。
ok=0
for i in $(seq 1 36); do
  if docker exec nexus-server-staging curl -fsS http://localhost:8001/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
if [ "$ok" != "1" ]; then
  echo "❌ staging server unhealthy after 3min — last logs:" >&2
  $COMPOSE logs --tail=80 nexus-server-staging >&2 || true
  exit 1
fi
echo "✓ staging server healthy (container)"

# 共享 Caddy 的站点配置：Caddyfile 由工作流 scp 到 /opt/heurion；先 validate
# 再 reload。validate 失败 = 配置错误 → 明确失败（旧配置与生产都还在跑，
# 不受影响）；不静默半成品。
echo "caddy: $(docker exec nexus-caddy caddy version 2>/dev/null || echo 'container not running')"
if [ ! -f /opt/heurion/Caddyfile ]; then
  echo "❌ /opt/heurion/Caddyfile missing — cannot activate staging site" >&2
  exit 1
fi
if ! docker exec nexus-caddy caddy validate --config /etc/caddy/Caddyfile; then
  echo "❌ Caddyfile validate failed — staging site NOT activated (production unaffected)" >&2
  exit 1
fi
if ! docker exec nexus-caddy caddy reload --config /etc/caddy/Caddyfile; then
  echo "❌ caddy reload failed — staging site NOT activated (production unaffected)" >&2
  exit 1
fi
echo "✓ caddy reloaded (staging site active)"

echo "✓ staging deploy complete"
