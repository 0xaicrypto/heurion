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
# 出站白名单：隔离 uid（20000–59999）只能连本机平台端口（MCP 与模型代理），其他网络一律拒绝。
# 需要容器有 NET_ADMIN（compose 里 cap_add）；没有时如实打出警告，不阻止启动。
SBX=20000-59999
if iptables -w -L OUTPUT >/dev/null 2>&1; then
  for t in iptables ip6tables; do
    $t -w -D OUTPUT -m owner --uid-owner $SBX -j HEURION_SBX 2>/dev/null || true
    $t -w -F HEURION_SBX 2>/dev/null || $t -w -N HEURION_SBX 2>/dev/null || true
    $t -w -A HEURION_SBX -o lo -p tcp --dport "${PORT:-8787}" -j ACCEPT
    $t -w -A HEURION_SBX -j REJECT
    $t -w -A OUTPUT -m owner --uid-owner $SBX -j HEURION_SBX
  done 2>/dev/null && echo "AI 代码出站白名单：只允许连本机 ${PORT:-8787}" || echo "⚠️  AI 代码出站白名单设置失败"
else
  echo "⚠️  容器没有 NET_ADMIN：AI 代码的出站网络没有限制（compose 里加 cap_add: [NET_ADMIN]）"
fi
# 平台新建的文件默认组可读、其他人不可读
export HOME=/home/node USER=node
exec setpriv --reuid=node --regid=node --init-groups sh -c 'umask 027; exec "$@"' sh "$@"
