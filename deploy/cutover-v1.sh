#!/usr/bin/env bash
# 1.0 → 2.0 切换（deploy.sh 第一次部署时调用，可重复执行）：
#   1. 停 1.0 的应用容器（停写），2. 全量备份 1.0 的卷到 /opt/heurion2/backups（配置了 S3 时同时上传），
#   3. 把 1.0 的用户账户导入 2.0（文档 / 知识库 / 记忆不迁移，见 MIGRATION_PLAN.md），
#   4. 停掉 1.0 的整套 compose（含 Caddy、统计 worker）与监控栈，腾出 80/443。
# 1.0 的卷与 /opt/heurion 不删：切换失败时 deploy.sh 用它们恢复 1.0；确认无误后由 cleanup-v1.sh 清理。
set -euo pipefail

DIR="${DEPLOY_DIR:-/opt/heurion2}"
V1="${V1_DIR:-/opt/heurion}"
cd "$DIR"
COMPOSE=(docker compose -p heurion2 --env-file .env.production -f docker-compose.yml)
STAMP=$(date -u +%Y%m%d-%H%M%S)
BACKUP="$DIR/backups/v1-final-$STAMP"
mkdir -p "$BACKUP"
chmod 700 "$DIR/backups"

echo "== 1. 停 1.0 应用容器（停写）"
docker stop nexus-server nexus-embedding-server nexus-stats-worker >/dev/null 2>&1 || true

echo "== 2. 全量备份 1.0 → $BACKUP"
for v in $(docker volume ls -q | grep -E '^heurion_' || true); do
  docker run --rm -v "$v":/src:ro alpine tar czf - -C /src . > "$BACKUP/$v.tar.gz"
  echo "  $v → $(du -h "$BACKUP/$v.tar.gz" | cut -f1)"
done
[ -f "$V1/.env.production" ] && cp "$V1/.env.production" "$BACKUP/v1.env.production"
chmod -R go-rwx "$BACKUP"
if [ ! -s "$BACKUP/heurion_nexus-db-data.tar.gz" ]; then
  echo "❌ 没有备份到 1.0 数据库卷（heurion_nexus-db-data），停止切换" >&2
  docker start nexus-server nexus-embedding-server nexus-stats-worker >/dev/null 2>&1 || true
  exit 1
fi
if grep -q '^S3_ACCESS_KEY=' .env.production && grep -q '^S3_BUCKET=.' .env.production && command -v rclone >/dev/null 2>&1; then
  set -a; . ./.env.production; set +a
  bash "$DIR/scripts/backup-to-s3.sh" upload-dir "$BACKUP" "v1-final/$STAMP" || echo "⚠️  上传 S3 失败，本机备份仍在 $BACKUP"
fi

echo "== 3. 导入 1.0 用户账户（同名跳过，可重复执行）"
"${COMPOSE[@]}" run --rm --no-deps -T -v heurion_nexus-db-data:/v1:ro heurion2 \
  pnpm --filter @heurion2/platform import-h1-users /v1/nexus_server.db --apply

echo "== 4. 停掉 1.0 的 compose 与监控栈（卷保留）"
if [ -f "$V1/docker-compose.yml" ]; then
  ( cd "$V1" && docker compose --env-file .env.production down ) || true
fi
if [ -f "$V1/docker-compose.monitoring.yml" ]; then
  ( cd "$V1" && docker compose -f docker-compose.monitoring.yml --env-file .env.production down ) || true
fi
docker rm -f nexus-caddy nexus-server nexus-embedding-server nexus-stats-worker >/dev/null 2>&1 || true
# 1.0 的备份定时任务会因为卷不在而失败：去掉
( crontab -l 2>/dev/null | grep -v "cd $V1 &&" || true ) | crontab -
echo "✓ 切换准备完成"
