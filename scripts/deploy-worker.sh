#!/usr/bin/env bash
# Deploy / update the Heurion Execution Plane (Sidecar worker) on a sandbox VPS.
# This script is invoked by GitHub Actions via SSH; it can also be run manually
# on the worker host.
set -e

REPO_URL="https://github.com/0xaicrypto/heurion.git"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/heurion}"
IMAGE_TAG="${WORKER_IMAGE_TAG:-latest}"

echo "Deploy directory: $DEPLOY_DIR"
cd "$DEPLOY_DIR" 2>/dev/null || {
  git clone "$REPO_URL" "$DEPLOY_DIR"
  cd "$DEPLOY_DIR"
}

git fetch origin main 2>/dev/null || { sleep 3; git fetch origin main; }
git reset --hard origin/main
echo "Deploying worker: $(git log -1 --oneline) (image tag: $IMAGE_TAG)"

# Ensure Docker and docker compose plugin are available.
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required on the worker VPS." >&2
  exit 1
fi

# Write secrets to files so Docker Compose can mount them under /run/secrets.
# These files are created from environment variables injected by CI; they are
# NOT checked into the repo and are overwritten on every deploy.
mkdir -p secrets
cat > secrets/server_secret.txt <<EOF
${SERVER_SECRET:-$(openssl rand -hex 32)}
EOF
cat > secrets/deepseek_key.txt <<EOF
${DEEPSEEK_KEY:-}
EOF
cat > secrets/gemini_key.txt <<EOF
${GEMINI_KEY:-}
EOF
chmod 644 secrets/*.txt

# Write runtime env for docker compose. The token is considered secret, but it is
# needed by the worker API for Control Plane authentication. Keep this file on the
# worker host only (it is not committed).
cat > .env <<EOF
WORKER_API_TOKEN=${WORKER_API_TOKEN:-}
REDIS_URL=redis://redis:6379/0
S3_ENDPOINT=${S3_ENDPOINT:-}
S3_BUCKET=${S3_BUCKET:-}
S3_REGION=${S3_REGION:-}
S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID:-}
S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY:-}
EOF
chmod 600 .env

# Pull the requested image tag and restart the stack.
export WORKER_IMAGE_TAG="$IMAGE_TAG"
docker compose -f docker-compose.worker.yml pull
docker compose -f docker-compose.worker.yml up -d --remove-orphans

# Wait for healthcheck.
MAX_RETRIES=15
RETRY_DELAY=2
for i in $(seq 1 $MAX_RETRIES); do
  if docker compose -f docker-compose.worker.yml exec -T heurion-worker curl -fsS http://localhost:8001/healthz >/dev/null 2>&1; then
    echo "✓ Execution Plane healthy"
    exit 0
  fi
  echo "  health check attempt $i/$MAX_RETRIES failed, retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
done

echo "❌ Execution Plane health check failed"
docker compose -f docker-compose.worker.yml logs --tail=50 heurion-worker
exit 1
