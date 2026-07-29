#!/usr/bin/env bash
# Deploy script — run on VPS via GitHub Actions SSH
set -e

cd ~/heurion || { git clone https://github.com/0xaicrypto/heurion.git ~/heurion && cd ~/heurion; }
# Ensure VPS matches origin/main exactly; any local changes are usually
# leftover from a previous failed deploy and should not block updates.
git fetch origin main 2>/dev/null || { sleep 3; git fetch origin main; }
git reset --hard origin/main
echo "Deploying: $(git log -1 --oneline)"

which pnpm || npm install -g pnpm@10

# Build web frontend before restarting the API so Nginx never serves a
# stale or missing dist during the cut-over.
cd ~/heurion/packages/web
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
chmod -R +rx dist
chmod +rx /root /root/heurion /root/heurion/packages /root/heurion/packages/web 2>/dev/null || true

cd ~/heurion/packages/server-ts

# Use the SERVER_SECRET injected by CI if provided; otherwise preserve the
# existing secret so users don't get logged out on every deploy.
if [ -n "${SERVER_SECRET:-}" ]; then
  echo "Using SERVER_SECRET from deployment environment"
elif [ -f .env ] && grep -q '^SERVER_SECRET=' .env; then
  SERVER_SECRET=$(grep '^SERVER_SECRET=' .env | head -1 | cut -d= -f2-)
else
  SERVER_SECRET=$(openssl rand -hex 32)
fi

# Preserve optional embedding / OpenAI fallback values from the existing env
# if they are already configured, otherwise apply safe defaults.
OPENAI_API_KEY_VALUE=""
EMBEDDING_FALLBACK_PROVIDER_VALUE="none"
if [ -f .env ]; then
  OPENAI_API_KEY_VALUE=$(grep '^OPENAI_API_KEY=' .env | head -1 | cut -d= -f2-)
  EMBEDDING_FALLBACK_PROVIDER_VALUE=$(grep '^EMBEDDING_FALLBACK_PROVIDER=' .env | head -1 | cut -d= -f2-)
fi
cat > .env << ENVEOF
DATABASE_URL="file:./nexus_server.db"
SERVER_HOST=0.0.0.0
SERVER_PORT=8001
SERVER_SECRET=${SERVER_SECRET}
DEEPSEEK_API_KEY=${DEEPSEEK_KEY:-}
GEMINI_API_KEY=${GEMINI_KEY:-}
EXECUTION_PLANE_URL=${EXECUTION_PLANE_URL:-}
WORKER_API_TOKEN=${WORKER_API_TOKEN:-}
CORS_ALLOW_ORIGINS=*
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSIONS=1024
EMBEDDING_DEVICE=cpu
EMBEDDING_BATCH_SIZE=32
EMBEDDING_QUANTIZATION=none
EMBEDDING_FALLBACK_PROVIDER=${EMBEDDING_FALLBACK_PROVIDER_VALUE:-none}
LOCAL_EMBEDDING_URL=http://localhost:8003/embed
OPENAI_API_KEY=${OPENAI_API_KEY_VALUE:-}
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
ENVEOF

# ── Local embedding service (#19) ─────────────────────────────────────
# The TS server expects a local bge-m3 HTTP service on port 8003.
# We run it in its own venv because the bare-metal server-ts path does not
# otherwise need Python. The model cache is persisted under /opt.
EMBEDDING_VENV=/opt/nexus-embedding
EMBEDDING_MODEL_DIR=/opt/nexus-embedding-models
mkdir -p "$EMBEDDING_MODEL_DIR"
# Ensure the venv exists and contains a working pip. Some minimal images ship
# python3 without ensurepip, and a partially-created venv may exist without pip.
# Try creating the venv; if it fails (ensurepip missing), install the required
# packages and retry.
if ! python3 -m venv --clear "$EMBEDDING_VENV" >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq python3-venv python3-pip
  python3 -m venv --clear "$EMBEDDING_VENV"
fi
"$EMBEDDING_VENV/bin/pip" install --no-cache-dir -q \
  fastapi uvicorn pydantic sentence-transformers "optimum[onnxruntime]"

pm2 delete heurion-embedding 2>/dev/null || true
HF_HOME="$EMBEDDING_MODEL_DIR" \
SENTENCE_TRANSFORMERS_HOME="$EMBEDDING_MODEL_DIR" \
  pm2 start "$EMBEDDING_VENV/bin/python" \
  --name heurion-embedding \
  -- /root/heurion/packages/server/nexus_server/embedding_server.py

# Wait for the embedding service to load the model before starting API.
# First boot downloads bge-m3 (~2.2 GB), which can take several minutes.
EMBEDDING_HEALTH_URL="http://localhost:8003/health"
EMBEDDING_MAX_RETRIES=120
for i in $(seq 1 $EMBEDDING_MAX_RETRIES); do
  if curl -fsS "$EMBEDDING_HEALTH_URL" >/dev/null 2>&1; then
    echo "✓ Embedding service healthy"
    break
  fi
  echo "  embedding health check attempt $i/$EMBEDDING_MAX_RETRIES failed, retrying in 5s..."
  sleep 5
done
if ! curl -fsS "$EMBEDDING_HEALTH_URL" >/dev/null 2>&1; then
  echo "❌ Embedding service failed to become healthy"
  pm2 logs heurion-embedding --lines 50 --nostream || true
  exit 1
fi

# Force fresh Prisma Client install/generation; pnpm's isolated store can
# cache a stale generated client even after schema changes, causing runtime
# "Unknown argument" errors.
rm -rf node_modules/.prisma node_modules/.pnpm/@prisma+client*
# Force fresh Prisma client — pnpm store can cache stale generated code
# even after rm -rf node_modules. Full clean + npm bypasses the store.
pnpm store prune --force 2>/dev/null || true
rm -rf node_modules package-lock.json
pnpm install --prefer-offline
# Explicitly regenerate Prisma client + push schema
npx prisma generate
npx prisma db push --accept-data-loss
which pm2 || npm install -g pm2
# Kill any process holding port 8001 (stale from previous deploy)
kill $(lsof -ti:8001) 2>/dev/null || fuser -k 8001/tcp 2>/dev/null || true
sleep 2
pm2 delete heurion 2>/dev/null || true
SERVER_PORT=8001 pm2 start npx --name heurion -- tsx src/main.ts
pm2 save

# Ensure HZ admin account exists
npx tsx scripts/set-admin.ts 2>/dev/null || true

# Robust health check: retry instead of a single attempt.
HEALTH_URL="http://localhost:8001/healthz"
MAX_RETRIES=30
RETRY_DELAY=3

# Give server time to initialize before first check
sleep 5

for i in $(seq 1 $MAX_RETRIES); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "OK"
    break
  fi
  echo "  health check attempt $i/$MAX_RETRIES failed, retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
done

if ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  echo ""
  echo "❌ Production health check failed after ${MAX_RETRIES} attempts."
  echo "--- Checking port/listening ---"
  ss -tlnp 2>/dev/null | grep 8001 || netstat -tlnp 2>/dev/null | grep 8001 || echo "No listener on 8001"
  echo "--- PM2 logs for heurion ---"
  pm2 logs heurion --lines 50 --nostream || true
  echo "--- Process status ---"
  pm2 describe heurion || true
  exit 1
fi

# Configure nginx as the public-facing reverse proxy
NGINX_CONF="/etc/nginx/sites-available/heurion"
NGINX_ENABLED="/etc/nginx/sites-enabled/heurion"

which nginx || { apt-get update -qq && apt-get install -y -qq nginx; }

# Generate a self-signed cert for Cloudflare "Full" SSL mode.
# (Full accepts any cert; Full strict would need a real CA cert.)
if [ ! -f /etc/nginx/ssl/heurion.crt ] || [ ! -f /etc/nginx/ssl/heurion.key ]; then
  mkdir -p /etc/nginx/ssl
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/heurion.key \
    -out /etc/nginx/ssl/heurion.crt \
    -subj "/CN=heurion.org" 2>/dev/null
  chmod 600 /etc/nginx/ssl/heurion.key
  chmod 644 /etc/nginx/ssl/heurion.crt
  echo "✓ Generated self-signed SSL cert for heurion.org"
fi

cp ~/heurion/scripts/nginx-heurion.conf "$NGINX_CONF"

# Enable site if not already enabled
if [ ! -L "$NGINX_ENABLED" ]; then
  ln -s "$NGINX_CONF" "$NGINX_ENABLED"
fi

# Remove default site if it exists to avoid port conflicts
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx || systemctl restart nginx

echo "✓ Nginx configured and reloaded"
