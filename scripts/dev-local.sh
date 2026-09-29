#!/usr/bin/env bash
# 本地单实例启动（staging 下线后的日常开发入口）:
#   1) 构建 llm-markdown-fix / contracts / web 产物
#   2) web dist 拷到 packages/server-ts/web-dist（Fastify 静态托管 + SPA fallback）
#   3) SQLite(dev.db) 迁移并启动 Fastify —— API 与前端同端口。
#
# 用法: bash scripts/dev-local.sh [port]   # 默认 8001 → http://localhost:8001
# 注意: LLM 功能需要 DEEPSEEK_API_KEY 等；启动本身不需要 key。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8001}"

echo "── build llm-markdown-fix ──"
cd "$ROOT/packages/llm-markdown-fix" && ./node_modules/.bin/tsc
echo "── build contracts ──"
cd "$ROOT/packages/contracts" && ./node_modules/.bin/tsc
echo "── build web ──"
cd "$ROOT/packages/web" && ./node_modules/.bin/tsc && ./node_modules/.bin/vite build
rm -rf "$ROOT/packages/server-ts/web-dist" && cp -r dist "$ROOT/packages/server-ts/web-dist"

cd "$ROOT/packages/server-ts"
echo "── prisma generate + db push (dev.db) ──"
DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma generate >/dev/null
DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push --skip-generate >/dev/null

echo "── start server → http://localhost:${PORT} ──"
DATABASE_URL="file:./dev.db" \
SERVER_PORT="$PORT" \
SERVER_SECRET="${SERVER_SECRET:-dev-secret-key}" \
ENVIRONMENT=development \
TWIN_BASE_DIR=./.nexus/twins \
WEB_DIST_DIR=./web-dist \
CORS_ALLOW_ORIGINS="http://localhost:5173" \
EMBEDDING_PROVIDER=local \
LOCAL_EMBEDDING_URL="http://localhost:8003/embed" \
  exec ./node_modules/.bin/tsx src/main.ts
