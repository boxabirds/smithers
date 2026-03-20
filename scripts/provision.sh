#!/usr/bin/env bash
# Provisions a Hetzner VPS and deploys Smithers.
#
# Prerequisites (install once):
#   brew install hcloud
#   hcloud context create smithers  (paste your Hetzner API token)
#
# Usage:
#   cp .env.production.example .env.production  # fill in secrets
#   ./scripts/provision.sh
#
# Idempotent: safe to re-run. Skips resources that already exist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --- Constants ---
SERVER_NAME="smithers"
SSH_KEY_NAME="smithers-deploy"
FIREWALL_NAME="smithers-fw"
REMOTE_DIR="/opt/smithers"

# --- Load secrets ---
ENV_FILE="${PROJECT_DIR}/.env.production"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env.production not found."
  echo "  cp .env.production.example .env.production"
  echo "  # Fill in your secrets, then re-run."
  exit 1
fi

source "$ENV_FILE"

for var in DISCORD_TOKEN GEMINI_API_KEY MCP_AUTH_TOKEN PG_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is empty in .env.production"
    exit 1
  fi
done

SERVER_TYPE="${HCLOUD_SERVER_TYPE:-cx22}"
LOCATION="${HCLOUD_LOCATION:-fsn1}"

# --- Check tools ---
for cmd in hcloud ssh-keygen rsync; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found."
    exit 1
  fi
done

if ! hcloud server list &>/dev/null; then
  echo "ERROR: hcloud not authenticated. Run: hcloud context create smithers"
  exit 1
fi

# --- SSH key ---
SSH_KEY_PATH="$HOME/.ssh/${SSH_KEY_NAME}"

if [[ ! -f "$SSH_KEY_PATH" ]]; then
  echo "==> Creating SSH key: $SSH_KEY_PATH"
  ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "$SSH_KEY_NAME"
fi

if ! hcloud ssh-key describe "$SSH_KEY_NAME" &>/dev/null 2>&1; then
  echo "==> Uploading SSH key to Hetzner"
  hcloud ssh-key create --name "$SSH_KEY_NAME" --public-key-from-file "${SSH_KEY_PATH}.pub"
fi

# --- Firewall (SSH only — bot connects outbound, tunnel handles MCP) ---
if ! hcloud firewall describe "$FIREWALL_NAME" &>/dev/null 2>&1; then
  echo "==> Creating firewall"
  hcloud firewall create --name "$FIREWALL_NAME"
  hcloud firewall add-rule "$FIREWALL_NAME" \
    --direction in --protocol tcp --port 22 \
    --source-ips 0.0.0.0/0 --source-ips ::/0 \
    --description "SSH"
  hcloud firewall add-rule "$FIREWALL_NAME" \
    --direction in --protocol icmp \
    --source-ips 0.0.0.0/0 --source-ips ::/0 \
    --description "Ping"
fi

# --- Cloud-init (just Docker — code comes via rsync) ---
CLOUD_INIT_FILE=$(mktemp)
trap "rm -f $CLOUD_INIT_FILE" EXIT
cat > "$CLOUD_INIT_FILE" <<'EOF'
#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
runcmd:
  - systemctl enable docker
  - systemctl start docker
  - mkdir -p /opt/smithers
EOF

# --- Create server ---
if hcloud server describe "$SERVER_NAME" &>/dev/null 2>&1; then
  echo "==> Server '$SERVER_NAME' already exists"
else
  echo "==> Creating server ($SERVER_TYPE in $LOCATION)"
  hcloud server create \
    --name "$SERVER_NAME" \
    --type "$SERVER_TYPE" \
    --location "$LOCATION" \
    --image ubuntu-24.04 \
    --ssh-key "$SSH_KEY_NAME" \
    --firewall "$FIREWALL_NAME" \
    --user-data-from-file "$CLOUD_INIT_FILE"
fi

SERVER_IP=$(hcloud server ip "$SERVER_NAME")
echo "==> Server IP: $SERVER_IP"

SSH_OPTS="-i $SSH_KEY_PATH -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5"

echo "==> Waiting for cloud-init..."
MAX_ATTEMPTS=30
for i in $(seq 1 "$MAX_ATTEMPTS"); do
  if ssh $SSH_OPTS "root@${SERVER_IP}" "cloud-init status --wait" &>/dev/null; then
    break
  fi
  if [[ "$i" -eq "$MAX_ATTEMPTS" ]]; then
    echo "ERROR: Server didn't become ready in time."
    exit 1
  fi
  echo "  Attempt $i/$MAX_ATTEMPTS..."
  sleep 10
done

# --- Deploy ---
"$SCRIPT_DIR/deploy.sh"

echo ""
echo "=== Provisioning complete ==="
echo "Server:  $SERVER_IP"
echo "SSH:     ssh $SSH_OPTS root@$SERVER_IP"
echo "Logs:    ssh $SSH_OPTS root@$SERVER_IP 'cd $REMOTE_DIR && docker compose logs -f'"
echo ""
if [[ -n "${CF_TUNNEL_TOKEN:-}" ]]; then
  echo "Cloudflare Tunnel is active."
  echo "Add a public hostname in Cloudflare Dashboard when ready."
else
  echo "No CF_TUNNEL_TOKEN set — bot-only mode (no external MCP access)."
  echo "Add CF_TUNNEL_TOKEN to .env.production and re-run deploy.sh to enable."
fi
