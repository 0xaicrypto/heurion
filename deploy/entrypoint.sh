#!/bin/sh
# 平台容器入口（root 启动）：整理数据目录权限，再降到 node 运行平台。
# AI 执行的代码以每个平台用户专属的 uid 运行（heurion-sandbox-exec）：它只能进自己的工作区，
# 读不到数据库、其他用户的工作区和平台进程的环境（密钥）。
set -e
D="${HEURION_DATA_DIR:-/app/data}"
P="$D/platform"
mkdir -p "$P/workspaces" "$P/dsh-homes"
chown node:node "$D" "$P" "$P/workspaces" "$P/dsh-homes"
# 数据目录：其他用户只能穿过、不能列出；平台自己的文件（数据库、渲染缓存、OCR 模型等）只有 node 能读
chmod 0711 "$D" "$P" "$P/workspaces" "$P/dsh-homes"
find "$D" -mindepth 1 -maxdepth 1 ! -name platform -exec chown -R node:node {} + -exec chmod -R go-rwx {} +
find "$P" -mindepth 1 -maxdepth 1 ! -name workspaces ! -name dsh-homes -exec chown -R node:node {} + -exec chmod -R go-rwx {} +
# 平台新建的文件默认组可读、其他人不可读
export HOME=/home/node USER=node
exec setpriv --reuid=node --regid=node --init-groups sh -c 'umask 027; exec "$@"' sh "$@"
