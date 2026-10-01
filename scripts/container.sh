#!/usr/bin/env bash
# 用 podman（或 docker）构建并运行 Heurion 2.0 单机容器。
#   scripts/container.sh build | up | down | logs | collabora
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
    # 专用网络：容器名互为 DNS 别名（默认 podman 网络没有 DNS）。
    "$ENGINE" network create heurion2-net 2>/dev/null || true
    "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
    "$ENGINE" run -d --name "$NAME" --env-file .env \
      --network heurion2-net \
      -e HEURION_DATA_DIR=/app/data -e DSH_PRIMARY_RUNTIME= \
      -e HEURION_COLLABORA_URL=http://heurion2-collabora:9980 \
      -e HEURION_PUBLIC_URL=http://heurion2:8787 \
      -p 8787:8787 -v heurion2-data:/app/data \
      --memory 3g "$IMAGE"
    echo "http://localhost:8787" ;;
  down) "$ENGINE" rm -f "$NAME" heurion2-collabora 2>/dev/null || true ;;
  logs) "$ENGINE" logs -f "$NAME" ;;
  collabora)
    # 编辑面（#4 spike → S4）：Collabora CODE，明文 HTTP 仅限本地。
    # 浏览器从宿主机访问 9980；它回连 WOPI host 走容器网络别名。
    # CODE 镜像极简无 shell，中文字体用挂载注入（/tmp/h2-fonts/noto 由
    #   podman cp heurion2:/usr/share/fonts/opentype/noto /private/tmp/h2-fonts/noto
    # 生成；缺失时跳过挂载，退化为豆腐块）。
    "$ENGINE" network create heurion2-net 2>/dev/null || true
    "$ENGINE" rm -f heurion2-collabora >/dev/null 2>&1 || true
    FONT_ARGS=''
    [ -d /private/tmp/h2-fonts/noto ] && FONT_ARGS="-v /private/tmp/h2-fonts/noto:/usr/share/fonts/opentype/noto-cjk:ro,Z"
    # shellcheck disable=SC2086
    "$ENGINE" run -d --name heurion2-collabora --network heurion2-net \
      -p 9980:9980 $FONT_ARGS \
      -e extra_params='--o:ssl.enable=false --o:net.protocol=ipv4' \
      docker.io/collabora/code:latest
    echo "http://localhost:9980" ;;
  *) echo "usage: $0 build|up|down|logs|collabora"; exit 2 ;;
esac
