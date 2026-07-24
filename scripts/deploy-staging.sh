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
ENVEOF

rm -rf node_modules
pnpm install
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
