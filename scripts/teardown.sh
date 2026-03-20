#!/usr/bin/env bash
# Destroys the Smithers server and associated Hetzner resources.
# Does NOT delete your .env.production or SSH keys.
#
# Usage:
#   ./scripts/teardown.sh

set -euo pipefail

SERVER_NAME="smithers"
FIREWALL_NAME="smithers-fw"
SSH_KEY_NAME="smithers-deploy"

echo "This will DESTROY the following Hetzner resources:"
echo "  - Server: $SERVER_NAME"
echo "  - Firewall: $FIREWALL_NAME"
echo ""
read -p "Type 'yes' to confirm: " CONFIRM

if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

if hcloud server describe "$SERVER_NAME" &>/dev/null 2>&1; then
  echo "==> Deleting server"
  hcloud server delete "$SERVER_NAME"
else
  echo "==> Server '$SERVER_NAME' not found (already deleted?)"
fi

if hcloud firewall describe "$FIREWALL_NAME" &>/dev/null 2>&1; then
  echo "==> Deleting firewall"
  hcloud firewall delete "$FIREWALL_NAME"
else
  echo "==> Firewall '$FIREWALL_NAME' not found"
fi

# Intentionally keep SSH key in Hetzner — reusable across servers
echo ""
echo "=== Teardown complete ==="
echo "SSH key '$SSH_KEY_NAME' kept in Hetzner (reusable)."
echo "Local key at ~/.ssh/$SSH_KEY_NAME kept (delete manually if unwanted)."
