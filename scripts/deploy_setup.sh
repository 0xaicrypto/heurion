#!/usr/bin/env bash
# deploy_setup.sh — first-time bootstrap for a fresh VPS.
#
# Run this ONCE on the VPS after cloning the repo. It:
#   1. Verifies docker + docker compose are installed
#   2. Detects the public IP and writes HOSTNAME to .env.production
#   3. Generates a SERVER_SECRET if you don't have one
#   4. Prompts for the LLM API key
#   5. Builds + starts the stack
#
# Usage:  ./scripts/deploy_setup.sh
#
# Re-running is idempotent — values you've already set are kept.

set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

ENV_FILE=".env.production"
EXAMPLE_FILE=".env.production.example"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Heurion server deploy bootstrap"
echo "════════════════════════════════════════════════════════════════"
echo ""

# ── Step 1: docker available? ────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
    echo "✗ docker not installed. Install with:"
    echo "    curl -fsSL https://get.docker.com | sh"
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "✗ 'docker compose' plugin missing. Install via:"
    echo "    sudo apt-get install -y docker-compose-plugin"
    exit 1
fi
echo "✓ docker + compose found"

# ── Step 2: detect public IP, build nip.io hostname ──────────────────
PUBLIC_IP="${PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ]; then
    PUBLIC_IP=$(curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
        || curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null \
        || echo "")
fi
if [ -z "$PUBLIC_IP" ]; then
    read -rp "Could not auto-detect public IP. Enter it manually: " PUBLIC_IP
fi
NIP_HOSTNAME="${PUBLIC_IP//./-}.nip.io"
echo "✓ public IP: $PUBLIC_IP"
echo "✓ nip.io hostname: $NIP_HOSTNAME"

# ── Step 3: create .env.production from example if missing ───────────
if [ ! -f "$ENV_FILE" ]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    echo "✓ created $ENV_FILE from template"
fi

# Helper to set a key=value in the env file (idempotent).
set_env() {
    local key="$1" val="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        # Use a marker char that's unlikely in values; pipe-delimited sed.
        sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
        echo "${key}=${val}" >> "$ENV_FILE"
    fi
}

set_env "HOSTNAME"          "$NIP_HOSTNAME"
set_env "CORS_ALLOW_ORIGINS" "https://$NIP_HOSTNAME"

# ── Step 4: SERVER_SECRET ────────────────────────────────────────────
CURRENT_SECRET=$(grep -E '^SERVER_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
if [ -z "$CURRENT_SECRET" ] || [[ "$CURRENT_SECRET" == CHANGE-ME* ]]; then
    NEW_SECRET=$(openssl rand -hex 32)
    set_env "SERVER_SECRET" "$NEW_SECRET"
    echo "✓ generated SERVER_SECRET"
else
    echo "✓ SERVER_SECRET already set (kept)"
fi

# ── Step 5: LLM provider + API key ───────────────────────────────────
# Default to Gemini for backward compat, but allow the operator to pick
# any supported provider at first-deploy time.
CURRENT_PROVIDER=$(grep -E '^DEFAULT_LLM_PROVIDER=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
CURRENT_PROVIDER=${CURRENT_PROVIDER:-gemini}

read -rp "Default LLM provider [$CURRENT_PROVIDER] (gemini|openai|anthropic|kimi|deepseek): " PROVIDER
PROVIDER=${PROVIDER:-$CURRENT_PROVIDER}
if [ -n "$PROVIDER" ]; then
    set_env "DEFAULT_LLM_PROVIDER" "$PROVIDER"
    echo "✓ DEFAULT_LLM_PROVIDER=$PROVIDER"
fi

case "$PROVIDER" in
    gemini)
        KEY_VAR="GEMINI_API_KEY"; PROMPT_URL="https://aistudio.google.com/apikey" ;;
    openai)
        KEY_VAR="OPENAI_API_KEY"; PROMPT_URL="https://platform.openai.com/api-keys" ;;
    anthropic)
        KEY_VAR="ANTHROPIC_API_KEY"; PROMPT_URL="https://console.anthropic.com/settings/keys" ;;
    kimi)
        KEY_VAR="KIMI_API_KEY"; PROMPT_URL="https://platform.moonshot.ai" ;;
    deepseek)
        KEY_VAR="DEEPSEEK_API_KEY"; PROMPT_URL="https://platform.deepseek.com/api_keys" ;;
    *)
        echo "⚠ unknown provider '$PROVIDER' — skipping key prompt"
        KEY_VAR=""
        ;;
esac

if [ -n "$KEY_VAR" ]; then
    CURRENT_KEY=$(grep -E "^${KEY_VAR}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)
    if [ -z "$CURRENT_KEY" ]; then
        read -rp "$KEY_VAR (get one from $PROMPT_URL): " API_KEY
        if [ -n "$API_KEY" ]; then
            set_env "$KEY_VAR" "$API_KEY"
            echo "✓ $KEY_VAR saved"
        else
            echo "⚠ skipped — set $KEY_VAR in $ENV_FILE before first chat"
        fi
    else
        echo "✓ $KEY_VAR already set (kept)"
    fi
fi

# DeepSeek also needs its base_url configurable; seed the default if absent.
if [ "$PROVIDER" = "deepseek" ]; then
    CURRENT_DS_BASE=$(grep -E '^DEEPSEEK_BASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
    if [ -z "$CURRENT_DS_BASE" ]; then
        set_env "DEEPSEEK_BASE_URL" "https://api.deepseek.com/v1"
        echo "✓ DEEPSEEK_BASE_URL set to default"
    fi
fi

# ── Step 6: build + start ────────────────────────────────────────────
echo ""
echo "Building Docker images (first run takes ~3–5 min)…"
docker compose --env-file .env.production build

echo ""
echo "Starting services…"
docker compose --env-file .env.production up -d

echo ""
echo "Waiting 15 s for Caddy to negotiate the HTTPS cert…"
sleep 15

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Deploy complete"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Server URL (use this in the desktop's settings.json):"
echo ""
echo "    https://$NIP_HOSTNAME"
echo ""
echo "Quick health check:"
echo "    curl -fsSL https://$NIP_HOSTNAME/healthz   (or /docs)"
echo ""
echo "Logs:"
echo "    docker compose logs -f nexus-server"
echo "    docker compose logs -f caddy"
echo ""
echo "Stop:"
echo "    docker compose down"
echo ""
echo "Backup the persistent volume:"
echo "    docker run --rm -v nexus-data:/d -v \$PWD:/b alpine tar czf /b/nexus-backup.tgz -C /d ."
echo ""
