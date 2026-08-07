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
EMBEDDING_MODEL=Xenova/bge-small-en-v1.5
EMBEDDING_BATCH_SIZE=32
EMBEDDING_FALLBACK_PROVIDER=none
LOCAL_EMBEDDING_URL=http://localhost:8004/embed
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
ENVEOF

# ── Staging local embedding service (Node.js / Transformers.js) ─────
cd ~/heurion/packages/embedding-server
EMBEDDING_SERVER_PORT=8004 npm install 2>/dev/null || npm install
EMBEDDING_SERVER_PORT=8004 npm run build 2>/dev/null || true
pm2 delete heurion-embedding-staging 2>/dev/null || true
EMBEDDING_SERVER_PORT=8004 pm2 start node --name heurion-embedding-staging -- dist/index.js

EMBEDDING_HEALTH_URL="http://localhost:8004/health"
EMBEDDING_MAX_RETRIES=60
for i in $(seq 1 $EMBEDDING_MAX_RETRIES); do
  if curl -fsS "$EMBEDDING_HEALTH_URL" >/dev/null 2>&1; then
    echo "✓ Staging embedding service healthy"
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
pkill -f "tsx src/main.ts" 2>/dev/null || true
kill $(lsof -ti:8002) 2>/dev/null || fuser -k 8002/tcp 2>/dev/null || true
for i in $(seq 1 10); do
  if ! curl -fsS http://localhost:8002/healthz >/dev/null 2>&1; then break; fi
  sleep 2
done
sleep 2
SERVER_PORT=8002 pm2 start npx --name heurion-staging -- tsx src/main.ts
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
