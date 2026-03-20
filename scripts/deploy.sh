#!/usr/bin/env bash
# Deploys current code to an existing Smithers server.
# Run after provision.sh, or standalone for code updates.
#
# Usage:
#   ./scripts/deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

SERVER_NAME="smithers"
SSH_KEY_NAME="smithers-deploy"
SSH_KEY_PATH="$HOME/.ssh/${SSH_KEY_NAME}"
REMOTE_DIR="/opt/smithers"

# --- Load secrets ---
ENV_FILE="${PROJECT_DIR}/.env.production"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env.production not found."
  exit 1
fi

source "$ENV_FILE"

for var in DISCORD_TOKEN GEMINI_API_KEY MCP_AUTH_TOKEN PG_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is empty in .env.production"
    exit 1
  fi
done

# --- Resolve server ---
if ! command -v hcloud &>/dev/null; then
  echo "ERROR: hcloud not found."
  exit 1
fi

SERVER_IP=$(hcloud server ip "$SERVER_NAME")
SSH_OPTS="-i $SSH_KEY_PATH -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

echo "==> Deploying to $SERVER_IP"

# --- Sync code ---
echo "==> Syncing project files"
rsync -az --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude .env.production \
  --exclude .git \
  --exclude backups \
  -e "ssh $SSH_OPTS" \
  "$PROJECT_DIR/" \
  "root@${SERVER_IP}:${REMOTE_DIR}/"

# --- Write .env on server ---
echo "==> Writing .env"

# Build env file content locally, send as a file
ENV_CONTENT="DISCORD_TOKEN=${DISCORD_TOKEN}
GEMINI_API_KEY=${GEMINI_API_KEY}
MCP_AUTH_TOKEN=${MCP_AUTH_TOKEN}
PG_PASSWORD=${PG_PASSWORD}
EXTRACTION_INTERVAL_MINS=${EXTRACTION_INTERVAL_MINS:-60}
LOG_LEVEL=${LOG_LEVEL:-info}"

if [[ -n "${CF_TUNNEL_TOKEN:-}" ]]; then
  ENV_CONTENT="${ENV_CONTENT}
CF_TUNNEL_TOKEN=${CF_TUNNEL_TOKEN}"
fi

echo "$ENV_CONTENT" | ssh $SSH_OPTS "root@${SERVER_IP}" "cat > ${REMOTE_DIR}/.env"

# --- Build and start ---
COMPOSE_PROFILE=""
if [[ -n "${CF_TUNNEL_TOKEN:-}" ]]; then
  COMPOSE_PROFILE="--profile production"
fi

echo "==> Building and starting services"
ssh $SSH_OPTS "root@${SERVER_IP}" "cd ${REMOTE_DIR} && docker compose ${COMPOSE_PROFILE} up -d --build"

echo "==> Checking health"
ssh $SSH_OPTS "root@${SERVER_IP}" "cd ${REMOTE_DIR} && docker compose ps"

echo ""
echo "=== Deploy complete ==="
