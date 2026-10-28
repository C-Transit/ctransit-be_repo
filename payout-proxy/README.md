# C-Transit payout proxy

KoraPay requires the IP address that calls its payout endpoint to be whitelisted.
Vercel serverless functions do not have a stable outbound IP. This small proxy is
meant to run on a host with a **static IPv4**; that is the IP you whitelist in Kora.

The proxy only forwards two operations:

- `POST /disburse` → Kora `POST /api/v1/transactions/disburse`
- `GET /verify/:reference` → Kora `GET /api/v1/transactions/:reference`

It never exposes the Kora secret to the browser or to the main API.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No | Listen port. Default `8080`. |
| `KORA_SECRET_KEY` | Yes (unless dry run) | Kora live secret key. Use the same live key the backend uses for Kora (`PAYMENT_SECRET_KEY` / `KORA_SECRET_KEY`). |
| `KORA_BASE_URL` | No | Defaults to `https://api.korapay.com/merchant`. |
| `PAYOUT_PROXY_SECRET` | Yes | Shared secret the backend sends in `x-payout-proxy-secret`. Must be at least 32 characters. |
| `PAYOUT_PROXY_DRY_RUN` | No | Set `true` to accept requests without calling Kora. Never leave this on in production. |

Generate the shared secret with:

```bash
openssl rand -hex 32
```

## Fastest path: one-command Ubuntu deploy

On a fresh Ubuntu 22.04/24.04 VPS with a static IPv4:

```bash
sudo bash deploy.sh
```

The script prompts for the domain and secrets, installs Docker and Caddy, starts
the proxy, configures HTTPS, and prints the IPv4 to whitelist in Kora.

If you do not have a domain yet, leave the domain prompt blank and the script
will use `payout.<public-ip>.nip.io`.

## Manual deploy on a static-IP VPS

1. Create a VPS with a static IPv4 (DigitalOcean, Hetzner, Contabo, etc.).
2. Copy this folder to the server, or build the Docker image:
   ```bash
   docker build -t ctransit-payout-proxy .
   docker run -d --restart unless-stopped \
     -p 127.0.0.1:8080:8080 \
     --env-file .env \
     --name ctransit-payout-proxy \
     ctransit-payout-proxy
   ```
3. Put HTTPS in front of it. Example Caddy config:
   ```caddyfile
   payout.example.com {
     reverse_proxy 127.0.0.1:8080
   }
   ```
4. Confirm the server's outbound IPv4:
   ```bash
   curl -4 https://api.ipify.org
   ```
5. In the Kora dashboard, whitelist **that IPv4** for payouts.
6. Verify the proxy is alive:
   ```bash
   curl https://payout.example.com/health
   ```

The proxy forces IPv4 egress (`family: 4`) so the address Kora sees is the one
you whitelisted.

## Configure the backend

Set these in the backend/Vercel environment:

```text
KORA_PAYOUT_PROXY_URL=https://payout.example.com
PAYOUT_PROXY_SECRET=<same 32+ character secret>
```

If those two variables are absent, the backend keeps its current direct-to-Kora
behavior. If one is present without the other, the backend refuses to start.

## Test safely first

Start the proxy with `PAYOUT_PROXY_DRY_RUN=true` and confirm the backend can reach
it. Then set it to `false` and run the real ₦1,000 test.

Do not put the Kora secret, the proxy secret, or `.env` in Git.

## Notes

- The backend's payout amount is the **net** amount after the 4% fee. A ₦1,000
  withdrawal sends ₦960 to the driver.
- The Kora webhook can stay pointed at the main backend; only outbound payout
  calls need the static IP.
- This is a temporary/transitional service. The longer-term design is a durable
  payout worker with the same static egress and an outbox/queue.
