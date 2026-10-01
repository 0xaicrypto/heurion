#!/usr/bin/env bash
# 用 podman（或 docker）构建并运行 Heurion 平台单机容器。
#   scripts/container.sh build | up | down | logs | sh
# 数据在命名卷 heurion2-data（macOS 上 bind mount 的属主映射会让非 root 用户无法写入）。
#
# ⚠️ 不要用 `lsof -ti :8787 | xargs kill` 之类按端口杀进程：podman 的网络进程
#    gvproxy 同时监听 8787（容器端口转发）和 machine 控制通道，误杀它会让
#    machine 显示"运行中"却完全失联。杀本地 dev server 用：
#      pkill -f 'tsx.*src/index.ts'
set -euo pipefail
cd "$(dirname "$0")/.."
ENGINE="${ENGINE:-$(command -v podman || command -v docker)}"
IMAGE=heurion2:dev
NAME=heurion2
case "${1:-up}" in
  build) "$ENGINE" build -t "$IMAGE" . ;;
  up)
    [ -f .env ] || { echo "缺少 .env（cp .env.example .env 并填写 DEEPSEEK_API_KEY）"; exit 1; }
    "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
    "$ENGINE" run -d --name "$NAME" --env-file .env \
      -e HEURION_DATA_DIR=/app/data \
      -p 8787:8787 -v heurion2-data:/app/data \
      --memory 3g "$IMAGE"
    echo "http://localhost:8787" ;;
  down) "$ENGINE" rm -f "$NAME" 2>/dev/null || true ;;
  logs) "$ENGINE" logs -f "$NAME" ;;
  sh) "$ENGINE" exec -it "$NAME" bash ;;
  *) echo "usage: $0 build|up|down|logs|sh"; exit 2 ;;
esac
