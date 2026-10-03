#!/usr/bin/env bash
# 1.0 → 2.0 切换（deploy.sh 第一次部署时调用，可重复执行；失败时 deploy.sh 负责恢复 1.0）。
# 2026-10-03 决定：放弃 1.0 的全部数据（含账户），2.0 从零开始；切换只是停掉 1.0、腾出 80/443。
# 1.0 的卷、/opt/heurion 与之前留下的备份（/opt/heurion2/backups）不删：切换失败时 deploy.sh 用它们恢复 1.0，
# 确认 2.0 无误后由 cleanup-v1.sh 一起清理。
set -euo pipefail

DIR="${DEPLOY_DIR:-/opt/heurion2}"
V1="${V1_DIR:-/opt/heurion}"
cd "$DIR"

echo "== 记下 1.0 在用的镜像（恢复 1.0 时按它们重建；1.0 的 compose 缺省值指向本地不存在的 :latest）"
{
  for pair in NEXUS_IMAGE:nexus-server EMBEDDING_IMAGE:nexus-embedding-server STATS_IMAGE:nexus-stats-worker; do
    img=$(docker inspect --format '{{.Image}}' "${pair#*:}" 2>/dev/null || true)
    [ -n "$img" ] && echo "${pair%%:*}=$img"
  done
} > "$DIR/v1-images.env"
cat "$DIR/v1-images.env"

echo "== 停掉 1.0 的 compose（含 Caddy、统计 worker）与监控栈（卷保留）"
if [ -f "$V1/docker-compose.yml" ]; then
  ( cd "$V1" && docker compose --env-file .env.production down ) || true
fi
if [ -f "$V1/docker-compose.monitoring.yml" ]; then
  ( cd "$V1" && docker compose -f docker-compose.monitoring.yml --env-file .env.production down ) || true
fi
docker rm -f nexus-caddy nexus-server nexus-embedding-server nexus-stats-worker nexus-loki nexus-alloy nexus-grafana >/dev/null 2>&1 || true
# 1.0 的备份定时任务会因为容器不在而失败：去掉
[ -n "${SKIP_CRON:-}" ] || ( crontab -l 2>/dev/null | grep -v "cd $V1 &&" || true ) | crontab -
echo "✓ 1.0 已停，2.0 待启动"
