#!/usr/bin/env bash
# Execution Plane entrypoint — reads Docker Secrets from /run/secrets into env,
# then starts the Python worker (Sidecar / plugin runtime).
set -e

# Docker Secrets are mounted as files under /run/secrets. Export them as
# environment variables so the existing Python config layer (which expects env)
# continues to work without modification.
if [ -d /run/secrets ]; then
  for secret in /run/secrets/*; do
    [ -f "$secret" ] || continue
    name=$(basename "$secret" | tr '[:lower:]-' '[:upper:]_')
    export "$name"=$(cat "$secret")
  done
fi

# Allow the worker to identify itself when both images share the same code tree.
export HEURION_WORKER_MODE=${HEURION_WORKER_MODE:-sidecar}

exec "$@"
