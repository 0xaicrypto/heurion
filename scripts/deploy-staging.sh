#!/usr/bin/env bash
# Deploy to staging (port 8002)
set -e
cd ~/heurion
git fetch origin main 2>/dev/null || { sleep 3; git fetch origin main; }
git reset --hard origin/main
echo "Deploying: $(git log -1 --oneline)"
cd packages/server-ts

cp -f .env.staging .env 2>/dev/null || cat > .env << ENVEOF
DATABASE_URL="file:./staging.db"
SERVER_HOST=0.0.0.0
SERVER_PORT=8002
SERVER_SECRET=staging-secret
DEEPSEEK_API_KEY=${DEEPSEEK_KEY}
GEMINI_API_KEY=${GEMINI_KEY}
CORS_ALLOW_ORIGINS=*
TWIN_BASE_DIR=.nexus/staging-twins
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSIONS=1024
EMBEDDING_DEVICE=cpu
EMBEDDING_BATCH_SIZE=32
EMBEDDING_QUANTIZATION=none
EMBEDDING_FALLBACK_PROVIDER=none
LOCAL_EMBEDDING_URL=http://localhost:8004/embed
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
ENVEOF

# ── Staging local embedding service (#19) ─────────────────────────────
EMBEDDING_VENV=/opt/nexus-embedding
EMBEDDING_MODEL_DIR=/opt/nexus-embedding-models
mkdir -p "$EMBEDDING_MODEL_DIR"
# Ensure the venv exists and contains a working pip. Some minimal images ship
# python3 without ensurepip, and a partially-created venv may exist without pip.
if ! python3 -m venv --help >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq python3-venv python3-pip
fi
if [ ! -f "$EMBEDDING_VENV/bin/pip" ]; then
  python3 -m venv --clear "$EMBEDDING_VENV"
fi
"$EMBEDDING_VENV/bin/pip" install --no-cache-dir -q \
  fastapi uvicorn pydantic sentence-transformers "optimum[onnxruntime]"

pm2 delete heurion-embedding-staging 2>/dev/null || true
EMBEDDING_SERVER_PORT=8004 HF_HOME="$EMBEDDING_MODEL_DIR" \
SENTENCE_TRANSFORMERS_HOME="$EMBEDDING_MODEL_DIR" \
  pm2 start "$EMBEDDING_VENV/bin/python" \
  --name heurion-embedding-staging \
  -- /root/heurion/packages/server/nexus_server/embedding_server.py

EMBEDDING_HEALTH_URL="http://localhost:8004/health"
EMBEDDING_MAX_RETRIES=120
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

which pnpm || npm install -g pnpm@10
rm -rf node_modules
pnpm install --prefer-offline
npx prisma generate
rm -f staging.db staging.db-journal 2>/dev/null || true
npx prisma db push --accept-data-loss

pm2 delete heurion-staging 2>/dev/null || true
kill $(lsof -ti:8002) 2>/dev/null || fuser -k 8002/tcp 2>/dev/null || true
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
