#!/usr/bin/env bash
# 1.0 → 2.0 切换（deploy.sh 第一次部署时调用，可重复执行；失败时 deploy.sh 负责恢复 1.0）：
#   0. 预检（1.0 照常运行）：热拷 1.0 数据库，预演导入账户——预演失败就中止，1.0 不受影响
#   1. 备份大卷（1.0 照常运行）：上传文件 / 缓存 / 模型、监控数据
#   2. 停 1.0 应用容器（停写），备份数据库与用户文件卷（小，停机时间短）
#   3. 导入 1.0 用户账户（文档 / 知识库 / 记忆不迁移，见 MIGRATION_PLAN.md）
#   4. 停掉 1.0 的整套 compose（含 Caddy、统计 worker）与监控栈，腾出 80/443
# 1.0 的卷与 /opt/heurion 不删：失败时 deploy.sh 用它们恢复 1.0；确认无误后由 cleanup-v1.sh 清理。
set -euo pipefail

DIR="${DEPLOY_DIR:-/opt/heurion2}"
V1="${V1_DIR:-/opt/heurion}"
cd "$DIR"
COMPOSE=(docker compose -p heurion2 --env-file .env.production -f docker-compose.yml)
STAMP=$(date -u +%Y%m%d-%H%M%S)
BACKUP="$DIR/backups/v1-final-$STAMP"
mkdir -p "$BACKUP"
chmod 700 "$DIR/backups"

# 停机后才备份的卷：会被写入、需要一致的
LIVE_VOLUMES='^heurion_nexus-(db|files)-data$'

import_accounts() { # $1 = 含 nexus_server.db 的目录，$2 = --apply 或空
  chmod -R a+rwX "$1"
  "${COMPOSE[@]}" run --rm --no-deps -T -v "$1":/v1 heurion2 \
    pnpm --filter @heurion2/platform import-h1-users /v1/nexus_server.db ${2:-}
}

echo "== 0. 预检：热拷 1.0 数据库，预演导入账户（1.0 照常运行）"
PRE="$BACKUP/precheck-db"
mkdir -p "$PRE"
docker run --rm -v heurion_nexus-db-data:/src:ro alpine tar cf - -C /src . | tar xf - -C "$PRE"
[ -s "$PRE/nexus_server.db" ] || { echo "❌ 读不到 1.0 数据库（heurion_nexus-db-data/nexus_server.db）" >&2; exit 1; }
if ! import_accounts "$PRE" > "$BACKUP/precheck-import.log" 2>&1; then
  tail -25 "$BACKUP/precheck-import.log" >&2
  echo "❌ 预演导入失败：中止切换，1.0 没有动" >&2
  exit 1
fi
grep -vE '^  - ' "$BACKUP/precheck-import.log" | tail -4
rm -rf "$PRE"

echo "== 1. 备份大卷（1.0 照常运行）→ $BACKUP"
for v in $(docker volume ls -q | grep -E '^heurion_' | grep -vE "$LIVE_VOLUMES" || true); do
  docker run --rm -v "$v":/src:ro alpine tar czf - -C /src . > "$BACKUP/$v.tar.gz"
  echo "  $v → $(du -h "$BACKUP/$v.tar.gz" | cut -f1)"
done
[ -f "$V1/.env.production" ] && cp "$V1/.env.production" "$BACKUP/v1.env.production"

echo "== 2. 停 1.0 应用容器（停写），备份数据库与用户文件"
docker stop nexus-server nexus-embedding-server nexus-stats-worker >/dev/null 2>&1 || true
for v in $(docker volume ls -q | grep -E "$LIVE_VOLUMES" || true); do
  docker run --rm -v "$v":/src:ro alpine tar czf - -C /src . > "$BACKUP/$v.tar.gz"
  echo "  $v → $(du -h "$BACKUP/$v.tar.gz" | cut -f1)"
done
chmod -R go-rwx "$BACKUP"
[ -s "$BACKUP/heurion_nexus-db-data.tar.gz" ] || { echo "❌ 没有备份到 1.0 数据库卷" >&2; exit 1; }
if grep -q '^S3_ACCESS_KEY=.' .env.production && grep -q '^S3_BUCKET=.' .env.production && command -v rclone >/dev/null 2>&1; then
  # 上传放到后台：不占停机时间（失败只影响 S3 副本，本机备份仍在）
  ( set -a; . ./.env.production; set +a
    bash "$DIR/scripts/backup-to-s3.sh" upload-dir "$BACKUP" "v1-final/$STAMP" >> "$DIR/backups/upload-$STAMP.log" 2>&1 ) &
  echo "  S3 上传在后台进行（日志 backups/upload-$STAMP.log）"
fi

echo "== 3. 导入 1.0 用户账户（同名跳过，可重复执行）"
mkdir -p "$BACKUP/v1-db"
tar xzf "$BACKUP/heurion_nexus-db-data.tar.gz" -C "$BACKUP/v1-db"
if ! import_accounts "$BACKUP/v1-db" --apply > "$BACKUP/import.log" 2>&1; then
  tail -25 "$BACKUP/import.log" >&2
  echo "❌ 导入账户失败" >&2
  exit 1
fi
grep -vE '^  - ' "$BACKUP/import.log" | tail -4
chmod -R go-rwx "$BACKUP/v1-db"

echo "== 4. 停掉 1.0 的 compose 与监控栈（卷保留）"
# 记下 1.0 在用的镜像：恢复 1.0 时按它们重建（1.0 的 compose 缺省值指向本地不存在的 :latest）
{
  for pair in NEXUS_IMAGE:nexus-server EMBEDDING_IMAGE:nexus-embedding-server STATS_IMAGE:nexus-stats-worker; do
    img=$(docker inspect --format '{{.Image}}' "${pair#*:}" 2>/dev/null || true)
    [ -n "$img" ] && echo "${pair%%:*}=$img"
  done
} > "$DIR/v1-images.env"
if [ -f "$V1/docker-compose.yml" ]; then
  ( cd "$V1" && docker compose --env-file .env.production down ) || true
fi
if [ -f "$V1/docker-compose.monitoring.yml" ]; then
  ( cd "$V1" && docker compose -f docker-compose.monitoring.yml --env-file .env.production down ) || true
fi
docker rm -f nexus-caddy nexus-server nexus-embedding-server nexus-stats-worker nexus-loki nexus-alloy nexus-grafana >/dev/null 2>&1 || true
[ -n "${SKIP_CRON:-}" ] || ( crontab -l 2>/dev/null | grep -v "cd $V1 &&" || true ) | crontab -

# 之前失败的切换留下的备份：只保留这次的
find "$DIR/backups" -maxdepth 1 -name 'v1-final-*' -type d ! -name "v1-final-$STAMP" -exec rm -rf {} + 2>/dev/null || true
echo "✓ 切换准备完成（1.0 已停，2.0 待启动）"
