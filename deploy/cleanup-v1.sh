#!/usr/bin/env bash
# 彻底清理 1.0（不可恢复；2026-10-03 决定放弃 1.0 的全部数据，之前留下的备份也一起删）。
# 只能在切换完成（/opt/heurion2/.cutover-done）且 2.0 健康时运行，并且必须传 CONFIRM=DELETE-V1。
#   CONFIRM=DELETE-V1 bash cleanup-v1.sh
set -euo pipefail
# 可重复运行：已经删掉的东西找不到时不算失败（grep 无匹配退出 1，在 pipefail 下会中止整个脚本）

DIR="${DEPLOY_DIR:-/opt/heurion2}"
V1="${V1_DIR:-/opt/heurion}"
[ "${CONFIRM:-}" = "DELETE-V1" ] || { echo "需要 CONFIRM=DELETE-V1" >&2; exit 1; }
[ -f "${DIR}/.cutover-done" ] || { echo "还没有切换到 2.0（缺 ${DIR}/.cutover-done），不清理" >&2; exit 1; }
HOSTNAME=$(grep '^HOSTNAME=' "${DIR}/.env.production" | head -1 | cut -d= -f2-)
curl -fsS "https://${HOSTNAME}/healthz" >/dev/null || { echo "2.0 当前不健康，不清理" >&2; exit 1; }

echo "== 删除 1.0 容器"
{ docker ps -a --format '{{.Names}}' | grep -E '^nexus-' || true; } | xargs -r docker rm -f

echo "== 删除 1.0 的卷（heurion_*，不碰 heurion2_*）"
{ docker volume ls -q | grep -E '^heurion_' || true; } | xargs -r docker volume rm

echo "== 删除 1.0 的镜像"
{ docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'nexus-(server|embedding-server|stats-worker)|heurion-worker' || true; } | xargs -r docker rmi -f || true

echo "== 删除 ${V1}（含 Reactome 图库、旧 web dist、旧配置）"
rm -rf "${V1}"
rm -rf /opt/nexus-embedding-models

echo "== 删除之前留下的 1.0 备份"
rm -rf "${DIR}"/backups/v1-final-* "${DIR}"/backups/upload-*.log "${DIR}/v1-images.env"

docker image prune -f >/dev/null 2>&1 || true
df -h / | tail -1
echo "✓ 1.0 已清理"
