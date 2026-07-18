#!/usr/bin/env bash
# Deploy to staging (port 8002)
set -e
cd ~/heurion
git pull origin main
cd packages/server-ts

cp -f .env.staging .env 2>/dev/null || cat > .env << ENVEOF
DATABASE_URL="file:./staging.db"
SERVER_PORT=8002
SERVER_SECRET=staging-secret
DEEPSEEK_API_KEY=${DEEPSEEK_KEY}
GEMINI_API_KEY=${GEMINI_KEY}
CORS_ALLOW_ORIGINS=*
TWIN_BASE_DIR=.nexus/staging-twins
ENVEOF

pnpm install --frozen-lockfile
npx prisma generate
npx prisma db push --accept-data-loss

pm2 delete heurion-staging 2>/dev/null || true
pm2 start npx --name heurion-staging -- tsx src/main.ts
pm2 save

sleep 3
curl -fsS http://localhost:8002/healthz && echo " STAGING OK"
