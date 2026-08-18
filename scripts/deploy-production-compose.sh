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

# #280: migrate the SQLite database onto its own volume (idempotent).
# Old layout: DATABASE_URL=file:/data/nexus_server.db (inside nexus-data).
# New layout: DATABASE_URL=file:/data/db/nexus_server.db (nexus-db-data volume).
NEXUS_DATA_VOL=$(docker volume ls -q | grep '^heurion_nexus-data$' || true)
# Create the DB volume UP FRONT — on the first deploy after the #280 change
# the volume does not exist yet, and if compose creates it afterwards the
# server boots with a fresh empty DB (data appears lost).
docker volume create heurion_nexus-db-data 2>/dev/null || true
NEXUS_DB_VOL=$(docker volume ls -q | grep '^heurion_nexus-db-data$' || true)
if [ -n "$NEXUS_DATA_VOL" ] && [ -n "$NEXUS_DB_VOL" ]; then
  LEGACY_SIZE=$(docker run --rm -v "$NEXUS_DATA_VOL":/data alpine sh -c 'stat -c%s /data/nexus_server.db 2>/dev/null || echo 0' 2>/dev/null || echo 0)
  DB_SIZE=$(docker run --rm -v "$NEXUS_DB_VOL":/db alpine sh -c 'stat -c%s /db/nexus_server.db 2>/dev/null || echo 0' 2>/dev/null || echo 0)
  # The legacy copy is the authoritative one while it is larger — this also
  # repairs the case where the first #280 deploy created an EMPTY db volume
  # (server booted before the migration ran).
  if [ "$LEGACY_SIZE" -gt 0 ] && [ "$DB_SIZE" -lt "$LEGACY_SIZE" ]; then
    echo "Migrating SQLite → nexus-db-data volume (legacy=${LEGACY_SIZE}B, current=${DB_SIZE}B)..."
    docker run --rm -v "$NEXUS_DATA_VOL":/data -v "$NEXUS_DB_VOL":/db alpine sh -c 'cp /data/nexus_server.db /db/nexus_server.db && chown 1000:1000 /db/nexus_server.db'
    echo "✓ DB migrated (legacy copy retained in nexus-data)"
  else
    echo "DB volume already current (legacy=${LEGACY_SIZE}B, current=${DB_SIZE}B) — skipping migration"
  fi
fi

# #281: migrate per-user memory files onto their own volume (idempotent).
# Old layout: user memory at /data/{userId} (TWIN_BASE_DIR=/data).
# New layout: /data/twins/{userId} (TWIN_BASE_DIR=/data/twins, nexus-files-data volume).
NEXUS_FILES_VOL=$(docker volume ls -q | grep '^heurion_nexus-files-data$' || true)
docker volume create heurion_nexus-files-data 2>/dev/null || true
NEXUS_FILES_VOL=$(docker volume ls -q | grep '^heurion_nexus-files-data$' || true)
if [ -n "$NEXUS_DATA_VOL" ] && [ -n "$NEXUS_FILES_VOL" ]; then
  echo "Migrating per-user memory files → nexus-files-data volume..."
  docker run --rm -v "$NEXUS_DATA_VOL":/data -v "$NEXUS_FILES_VOL":/twins alpine sh -c '
    mkdir -p /twins
    moved=0
    for d in /data/user_*; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      if [ ! -e "/twins/$name" ]; then
        cp -r "$d" "/twins/$name" && echo "  migrated $name" && moved=$((moved+1))
      fi
    done
    if [ "$moved" -eq 0 ]; then echo "  nothing to migrate (all present or none)"; fi'
fi

# #290: install backup tooling + schedule cron jobs when S3 is configured.
if grep -q '^S3_ACCESS_KEY=' .env.production 2>/dev/null; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "Installing rclone..."
    curl -fsSL https://rclone.org/install.sh | sudo bash 2>/dev/null || curl -fsSL https://rclone.org/install.sh | bash
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    sudo apt-get install -y sqlite3 >/dev/null 2>&1 || true
  fi
  chmod +x "$DEPLOY_DIR/scripts/backup-to-s3.sh" 2>/dev/null || true
  # Daily 02:10 DB+memory backup; weekly Sun 03:10 files backup.
  ( crontab -l 2>/dev/null | grep -v 'backup-to-s3.sh' || true
    echo "10 2 * * * cd $DEPLOY_DIR && set -a && . ./.env.production && set +a && bash scripts/backup-to-s3.sh daily >> /var/log/heurion-backup.log 2>&1"
    echo "10 3 * * 0 cd $DEPLOY_DIR && set -a && . ./.env.production && set +a && bash scripts/backup-to-s3.sh weekly >> /var/log/heurion-backup.log 2>&1"
  ) | crontab -
  echo "✓ S3 backup scheduled (daily 02:10, weekly Sun 03:10)"
else
  echo "S3 backup not configured — skipping backup setup"
fi

# #284: display_name dedupe now runs INSIDE the server container at startup
# (main.ts → dedupeDisplayNames, before prisma db push). The old host-side
# call here connected to a stale DB path (no DATABASE_URL → default file)
# and silently no-op'd via `|| true` — removed to avoid the illusion of
# coverage.

# Pull the images tagged by CI and recreate containers.
export NEXUS_IMAGE="${NEXUS_IMAGE:-ghcr.io/0xaicrypto/nexus-server:latest}"
export EMBEDDING_IMAGE="${EMBEDDING_IMAGE:-ghcr.io/0xaicrypto/nexus-embedding-server:latest}"
# Free disk before pulling: stale images/build caches accumulate across
# deployments and have blocked production pulls (no space left on device).
docker image prune -f 2>/dev/null || true
docker builder prune -f 2>/dev/null || true

docker compose --env-file .env.production pull
docker compose --env-file .env.production up -d --remove-orphans

# Remove unused images (old versions) to keep disk from filling up.
docker image prune -f

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
