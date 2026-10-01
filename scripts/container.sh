#!/usr/bin/env bash
# 用 podman（或 docker）构建并运行 Heurion 2.0 单机容器。
#   scripts/container.sh build | up | down | logs | collabora
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
      -e HEURION_COLLABORA_URL=http://heurion2-collabora:9980 \
      -e HEURION_PUBLIC_URL=http://heurion2:8787 \
      -p 8787:8787 -v heurion2-data:/app/data \
      --memory 3g --network podman "$IMAGE"
    echo "http://localhost:8787" ;;
  down) "$ENGINE" rm -f "$NAME" heurion2-collabora 2>/dev/null || true ;;
  logs) "$ENGINE" logs -f "$NAME" ;;
  collabora)
    # 编辑面（#4 spike → S4）：Collabora CODE，明文 HTTP 仅限本地。
    # 浏览器从宿主机访问 9980；它回连 WOPI host 走容器网络别名。
    "$ENGINE" rm -f heurion2-collabora >/dev/null 2>&1 || true
    "$ENGINE" run -d --name heurion2-collabora -p 9980:9980 \
      -e extra_params='--o:ssl.enable=false --o:net.protocol=ipv4' \
      docker.io/collabora/code:latest
    echo "http://localhost:9980" ;;
  *) echo "usage: $0 build|up|down|logs|collabora"; exit 2 ;;
esac
