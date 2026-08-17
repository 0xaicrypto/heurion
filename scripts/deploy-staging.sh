#!/usr/bin/env bash
# Deploy to staging (port 8002)
set -e
cd ~/heurion
git fetch origin main 2>/dev/null || { sleep 3; git fetch origin main; }
git reset --hard origin/main
echo "Deploying: $(git log -1 --oneline)"
cd packages/server-ts

# A leftover untracked .env.staging would hijack DATABASE_URL and make
# db push hit an arbitrary historical DB (observed: unique-constraint
# failure on a stale DB). Always generate .env fresh.
rm -f .env.staging
cat > .env << ENVEOF
DATABASE_URL="file:./staging.db"
SERVER_HOST=0.0.0.0
SERVER_PORT=8002
SERVER_SECRET=staging-secret
DEEPSEEK_API_KEY=${DEEPSEEK_KEY}
GEMINI_API_KEY=${GEMINI_KEY}
DEFAULT_LLM_PROVIDER=${DEFAULT_LLM_PROVIDER:-opencode}
DEFAULT_LLM_MODEL=${DEFAULT_LLM_MODEL:-deepseek-v4-flash}
OPENCODE_API_KEY=${OPENCODE_KEY}
CORS_ALLOW_ORIGINS=*
TWIN_BASE_DIR=.nexus/staging-twins
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_BATCH_SIZE=32
EMBEDDING_FALLBACK_PROVIDER=none
LOCAL_EMBEDDING_URL=http://localhost:8004/embed
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
ENVEOF

# ── Staging local embedding service (Node.js / Transformers.js) ─────
cd ~/heurion/packages/embedding-server
EMBEDDING_SERVER_PORT=8004 npm install 2>/dev/null || npm install
EMBEDDING_SERVER_PORT=8004 npm run build 2>/dev/null || true
# #553: 预下载模型(fail fast)— 运行时 60 次健康重试掩盖了模型加载失败,
# 且 pm2 重启循环会让 /health 假阳性(进程在监听但模型不可用)。
if ! EMBEDDING_SERVER_PORT=8004 npm run precache; then
  echo "⚠ embedding model precache failed — clearing HF cache and retrying once"
  rm -rf ~/.cache/huggingface ~/.cache/@xenova 2>/dev/null || true
  EMBEDDING_SERVER_PORT=8004 npm run precache || {
    echo "❌ embedding model unavailable (bge-m3 download/load failed)"
    exit 1
  }
fi
pm2 delete heurion-embedding-staging 2>/dev/null || true
# #565: 与 8002 同理 — 孤儿进程占 8004 会让 embedding 新实例 EADDRINUSE。
pkill -f "dist/index.js" 2>/dev/null || true
kill $(lsof -ti:8004) 2>/dev/null || fuser -k 8004/tcp 2>/dev/null || true
for pid in $(ss -ltnp 2>/dev/null | grep ':8004' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 1
EMBEDDING_SERVER_PORT=8004 pm2 start node --name heurion-embedding-staging -- dist/index.js

# 健康检查:先 /health,再真实 embed 探针(验证模型真正就绪)。
EMBEDDING_HEALTH_URL="http://localhost:8004/health"
EMBEDDING_MAX_RETRIES=60
for i in $(seq 1 $EMBEDDING_MAX_RETRIES); do
  if curl -fsS "$EMBEDDING_HEALTH_URL" >/dev/null 2>&1 && \
     curl -fsS -X POST "http://localhost:8004/embed" -H 'content-type: application/json' -d '{"texts":["health"]}' >/dev/null 2>&1; then
    echo "✓ Staging embedding service healthy (model ready)"
    break
  fi
  echo "  staging embedding health check attempt $i/$EMBEDDING_MAX_RETRIES failed, retrying in 5s..."
  sleep 5
done
if ! curl -fsS "$EMBEDDING_HEALTH_URL" >/dev/null 2>&1; then
  echo "❌ Staging embedding service failed to become healthy"
  pm2 logs heurion-embedding-staging --lines 50 --nostream || true
  exit 1
fi

cd ~/heurion/packages/server-ts
which pnpm || npm install -g pnpm@10
pnpm install --prefer-offline
npx prisma generate
# #284: clear duplicate display_names before the unique constraint applies
# (harmless no-op when the DB is fresh).
npx tsx scripts/dedupe-display-names.ts 2>/dev/null || true
rm -f staging.db staging.db-journal 2>/dev/null || true
npx prisma db push --accept-data-loss

pm2 delete heurion-staging 2>/dev/null || true
# #565: pm2 delete 只杀 pm2 直接 spawn 的 shim,`npx tsx src/main.ts` 拉起的
# 真实 node 进程会成孤儿继续占 8002 → 新实例 EADDRINUSE 重启循环。必须
# 按端口+进程名双重清场。注意 cmdline 是 `.../tsx/dist/cli.mjs src/main.ts`,
# `pkill -f "tsx src/main.ts"` 匹配不到,要用 src/main.ts。
pkill -f "src/main.ts" 2>/dev/null || true
pkill -f "tsx" 2>/dev/null || true
kill $(lsof -ti:8002) 2>/dev/null || fuser -k 8002/tcp 2>/dev/null || true
# Orphaned node processes survive pm2 delete — kill whoever holds :8002 by PID.
for pid in $(ss -ltnp 2>/dev/null | grep ':8002' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
  kill -9 "$pid" 2>/dev/null || true
done
for i in $(seq 1 15); do
  if ! ss -ltn 2>/dev/null | grep -q ':8002'; then break; fi
  sleep 2
done
if ss -ltn 2>/dev/null | grep -q ':8002'; then
  echo "❌ port 8002 still held after cleanup:"
  lsof -i:8002 2>/dev/null || ss -ltnp 2>/dev/null | grep ':8002' || true
  exit 1
fi
sleep 2
SERVER_PORT=8002 pm2 start node --name heurion-staging -- $(pwd)/node_modules/.bin/tsx src/main.ts
pm2 save

sleep 3
npx tsx scripts/set-admin.ts 2>/dev/null || true

# Health check
HEALTH_URL="http://localhost:8002/healthz"
MAX_RETRIES=15
RETRY_DELAY=2
for i in $(seq 1 $MAX_RETRIES); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo " STAGING OK"
    exit 0
  fi
  echo "  health check attempt $i/$MAX_RETRIES failed, retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
done

echo "❌ STAGING health check failed after ${MAX_RETRIES} attempts."
pm2 logs heurion-staging --lines 100 --nostream || true
pm2 describe heurion-staging || true
exit 1
