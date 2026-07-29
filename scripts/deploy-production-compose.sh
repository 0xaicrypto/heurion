#!/usr/bin/env bash
# Production deploy via Docker Compose.
#
# Run on the VPS (usually invoked by GitHub Actions over SSH). Assumes:
#   - docker + docker compose plugin are installed
#   - /opt/heurion is the deploy directory (matches DEPLOY.md)
#   - .env.production has been copied into /opt/heurion by CI
#
# The script pulls the pre-built nexus-server image and starts the full stack
# (Caddy reverse proxy + nexus-server + nexus-embedding-server).

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/heurion}"
REPO_URL="https://github.com/0xaicrypto/heurion.git"

mkdir -p "$DEPLOY_DIR"
cd "$DEPLOY_DIR"

# CI already scp's the compose files, env, and web dist into /opt/heurion.
# Only sync from git if this directory happens to be a clone (legacy path).
if [ -d .git ]; then
  git fetch origin main
  git reset --hard origin/main
  echo "Deploying: $(git log -1 --oneline)"
else
  echo "Deploying from CI-provided files in $DEPLOY_DIR"
fi

if [ ! -f .env.production ]; then
  echo "Missing .env.production — copy it to $DEPLOY_DIR before deploying." >&2
  exit 1
fi

# Legacy bare-metal deployments run nginx on 80/443 and the API via pm2.
# Caddy needs those ports, so stop/disable nginx and the old pm2 processes.
if systemctl is-active --quiet nginx 2>/dev/null; then
  echo "Stopping legacy nginx so Caddy can bind 80/443..."
  systemctl stop nginx || true
  systemctl disable nginx 2>/dev/null || true
fi
if command -v pm2 >/dev/null 2>&1; then
  pm2 delete heurion 2>/dev/null || true
  pm2 delete heurion-embedding 2>/dev/null || true
  pm2 save 2>/dev/null || true
fi

# Ensure Docker is installed (fresh VPS may only have bare-metal tooling).
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found; installing via official convenience script..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker >/dev/null 2>&1 || true
  systemctl start docker >/dev/null 2>&1 || true
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin missing" >&2
  exit 1
fi

# Ensure the Docker model cache directory exists on the host. The compose file
# mounts the nexus-data volume at /data, so this is mainly a safety net.
mkdir -p /opt/nexus-embedding-models

# Pull the image tagged by CI and recreate containers.
export NEXUS_IMAGE="${NEXUS_IMAGE:-ghcr.io/0xaicrypto/nexus-server:latest}"
docker compose --env-file .env.production pull
docker compose --env-file .env.production up -d --remove-orphans

# Health check against the public HTTPS endpoint.
HOSTNAME=$(grep '^HOSTNAME=' .env.production | head -1 | cut -d= -f2-)
if [ -z "$HOSTNAME" ]; then
  echo "HOSTNAME not set in .env.production" >&2
  exit 1
fi

HEALTH_URL="https://${HOSTNAME}/healthz"
MAX_RETRIES=30
RETRY_DELAY=5

echo "Waiting for $HEALTH_URL ..."
for i in $(seq 1 $MAX_RETRIES); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "✓ Production healthy: $HEALTH_URL"
    exit 0
  fi
  echo "  health check attempt $i/$MAX_RETRIES failed, retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
done

echo "❌ Production health check failed after ${MAX_RETRIES} attempts"
docker compose --env-file .env.production logs --tail=50 nexus-server
docker compose --env-file .env.production logs --tail=50 nexus-embedding-server
exit 1
