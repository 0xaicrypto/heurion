#!/usr/bin/env bash
# 用 podman（或 docker）构建并运行 Heurion 2.0 单机容器。
#   scripts/container.sh build | up | down | logs
# 数据在命名卷 heurion2-data（macOS 上 bind mount 的属主映射会让非 root 用户无法写入）。
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
      -e HEURION_DATA_DIR=/app/data -e DSH_PRIMARY_RUNTIME= \
      -p 8787:8787 -v heurion2-data:/app/data \
      --memory 3g "$IMAGE"
    echo "http://localhost:8787" ;;
  down) "$ENGINE" rm -f "$NAME" ;;
  logs) "$ENGINE" logs -f "$NAME" ;;
  *) echo "usage: $0 build|up|down|logs"; exit 2 ;;
esac
