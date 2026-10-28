#!/usr/bin/env bash
set -euo pipefail

# C-Transit payout proxy — one-command Ubuntu deploy.
#
# Run from this directory on a fresh Ubuntu 22.04/24.04 VPS:
#   sudo bash deploy.sh
#
# Optional environment variables:
#   DOMAIN=payout.ctransit.me
#   KORA_SECRET_KEY=...
#   PAYOUT_PROXY_SECRET=...
#   PAYOUT_PROXY_DRY_RUN=false
#
# If DOMAIN is omitted, the script uses payout.<public-ip>.nip.io.
# If the secrets are omitted, the script prompts for them.

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

apt-get update
apt-get install -y ca-certificates curl

if [[ -z "${DOMAIN:-}" ]]; then
  read -r -p "Proxy domain (leave blank to use nip.io): " DOMAIN
fi

if [[ -z "${KORA_SECRET_KEY:-}" ]]; then
  read -r -s -p "Kora live secret key: " KORA_SECRET_KEY
  echo
fi

if [[ -z "${PAYOUT_PROXY_SECRET:-}" ]]; then
  read -r -s -p "Payout proxy shared secret (32+ chars): " PAYOUT_PROXY_SECRET
  echo
fi

if [[ ${#PAYOUT_PROXY_SECRET} -lt 32 ]]; then
  echo "PAYOUT_PROXY_SECRET must be at least 32 characters."
  exit 1
fi

PUBLIC_IP="$(curl -4 -s https://api.ipify.org || true)"
if [[ -z "$PUBLIC_IP" ]]; then
  echo "Could not determine the public IPv4 address."
  exit 1
fi

if [[ -z "${DOMAIN:-}" ]]; then
  DOMAIN="payout.${PUBLIC_IP}.nip.io"
  echo "No domain supplied; using ${DOMAIN}"
fi

echo "Installing Docker and Caddy..."
apt-get install -y gnupg debian-keyring debian-archive-keyring apt-transport-https docker.io

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

systemctl enable --now docker

cat > .env <<EOF
PORT=8080
KORA_SECRET_KEY=${KORA_SECRET_KEY}
KORA_BASE_URL=https://api.korapay.com/merchant
PAYOUT_PROXY_SECRET=${PAYOUT_PROXY_SECRET}
PAYOUT_PROXY_DRY_RUN=${PAYOUT_PROXY_DRY_RUN:-false}
EOF
chmod 600 .env

echo "Building and starting the payout proxy..."
docker rm -f ctransit-payout-proxy >/dev/null 2>&1 || true
docker build -t ctransit-payout-proxy .
docker run -d \
  --restart unless-stopped \
  --name ctransit-payout-proxy \
  -p 127.0.0.1:8080:8080 \
  --env-file .env \
  ctransit-payout-proxy

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "Waiting for HTTPS..."
health_ok=0
for _ in $(seq 1 10); do
  if curl -fsS "https://${DOMAIN}/health" >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep 3
done

echo
if [[ "$health_ok" -eq 1 ]]; then
  echo "Payout proxy is live: https://${DOMAIN}"
else
  echo "The container started, but the HTTPS health check did not pass yet."
  echo "Check that ${DOMAIN} points to ${PUBLIC_IP}, then run:"
  echo "  systemctl status caddy"
  echo "  docker logs ctransit-payout-proxy"
fi

echo
echo "WHITELIST THIS IPv4 IN KORA: ${PUBLIC_IP}"
echo "If Kora asks for CIDR: ${PUBLIC_IP}/32"
echo
echo "Backend environment variables:"
echo "  KORA_PAYOUT_PROXY_URL=https://${DOMAIN}"
echo "  PAYOUT_PROXY_SECRET=<the same secret you entered>"
echo
echo "Do not share .env, the Kora key, or the proxy secret."
