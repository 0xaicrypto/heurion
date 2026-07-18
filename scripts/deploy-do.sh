#!/usr/bin/env bash
# Deploy Heurion TS server to Digital Ocean Ubuntu VPS

set -e

echo "=== Heurion Server ==="

APP_DIR="$HOME/heurion"

# Clone if new
if [ ! -d "$APP_DIR" ]; then
    sudo apt-get update && sudo apt-get install -y curl git
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    npm install -g pnpm@10 pm2
    git clone https://github.com/0xaicrypto/heurion.git "$APP_DIR"
fi

cd "$APP_DIR"

# Update
git pull origin main

# Setup server-ts
cd packages/server-ts

[ -f .env ] || cat > .env << ENDENV
DATABASE_URL="file:./nexus_server.db"
SERVER_PORT=8001
SERVER_SECRET=$(openssl rand -hex 32)
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-sk-edc3839a3dd44babaf33dc16d0761dc3}
CORS_ALLOW_ORIGINS=*
TWIN_BASE_DIR=.nexus/twins
ENDENV

pnpm install --frozen-lockfile
npx prisma generate
npx prisma db push --accept-data-loss

pm2 delete heurion 2>/dev/null || true
pm2 start npx --name heurion -- tsx src/main.ts
pm2 save

IP=$(curl -s ifconfig.me)
echo ""
echo "=== Heurion Running ==="
echo "  http://$IP:8001/healthz"
echo "  pm2 logs heurion"
