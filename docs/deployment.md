# Zoteus — Production deployment runbook

End-to-end guide for running Zoteus as an always-on, public HTTPS connector that
survives restarts and redeploys with **no re-auth** from claude.ai.

---

## 1. Overview & topology

```
claude.ai  ──HTTPS──►  Caddy (TLS terminator)  ──HTTP──►  Zoteus :3939
                         (preserves Host header)               │
                                                          /data volume
                                                    (encrypted file store +
                                                     per-user search indexes)
```

- **Single instance only.** Pending OAuth consents live in process memory and the
  encrypted file store is not safe for concurrent writers. Do **not** run more than
  one replica.
- **Caddy preserves the `Host` header.** Zoteus performs exact-match DNS-rebinding
  protection; any proxy rewriting `Host` will cause 421 errors. The supplied
  `deploy/Caddyfile` uses the default `reverse_proxy` which forwards `Host` verbatim.
- **Persistent state.** Registered OAuth clients, tokens, and per-user Zotero keys
  are stored in `/data/oauth-store.json` (AES-256-GCM encrypted). Per-user semantic
  search indexes live in `/data/search-index-<userId>.json`. Mount `/data` on a
  persistent volume; the data survives container recreates.

---

## 2. Pick a free-forever host

**Recommended: Oracle Cloud Always Free** (ARM VM)

- Sign up at <https://cloud.oracle.com/> (credit card required for identity
  verification; Always Free instances are never billed).
- Provision an **Ampere A1** (ARM) VM with Ubuntu 22.04 or 24.04.
  - Shape: `VM.Standard.A1.Flex` · 1 OCPU · 6 GB RAM (well within Always Free limits).
- **Watch out for idle-reclaim:** Oracle may reclaim "idle" Always Free instances
  after 7 days of low CPU. Mitigate by setting up a lightweight cron health-check or
  simply noting you'll need to reprovision occasionally.
- Install Docker + Docker Compose v2 and open ports 80 and 443 in the OCI Security List.

Any always-on Linux box (a Raspberry Pi on a stable IP, a cheap VPS) works equally
well. The only hard requirement is a public IPv4/IPv6 address and ports 80/443
reachable from the internet.

---

## 3. Stable hostname + TLS (free)

### Option A — DuckDNS subdomain + Caddy (recommended)

1. Create a free subdomain at <https://www.duckdns.org/> (e.g. `zoteus.duckdns.org`).
   Point it at your VM's public IP.
2. Set `ZOTEUS_DOMAIN=zoteus.duckdns.org` in your `.env`.
3. **DuckDNS requires the DNS-01 ACME challenge** for wildcard or purely DNS-managed
   domains. Build a Caddy image with the `caddy-dns/duckdns` module:

   ```dockerfile
   FROM caddy:builder AS builder
   RUN xcaddy build \
       --with github.com/caddy-dns/duckdns

   FROM caddy:latest
   COPY --from=builder /usr/bin/caddy /usr/bin/caddy
   ```

   In `docker-compose.yml` swap `image: caddy:2` for `build: ./deploy/caddy-duckdns`
   (place the Dockerfile above there) and add `DUCKDNS_TOKEN` to the environment.

   Update `deploy/Caddyfile` to use DNS-01:

   ```caddyfile
   {$ZOTEUS_DOMAIN} {
       tls {
           dns duckdns {$DUCKDNS_TOKEN}
       }
       encode zstd gzip
       reverse_proxy zoteus:3939
   }
   ```

4. Keep the DuckDNS record fresh from a cron job on the VM:

   ```bash
   # /etc/cron.d/duckdns — every 5 minutes
   */5 * * * * root curl -fsS "https://www.duckdns.org/update?domains=zoteus&token=${DUCKDNS_TOKEN}&ip=" > /dev/null
   ```

### Option B — Custom domain (any registrar)

Point an A/AAAA record at your VM. Caddy's default HTTP-01 challenge (the stock
`image: caddy:2` is sufficient; no DNS plugin needed):

```caddyfile
zoteus.yourdomain.com {
    encode zstd gzip
    reverse_proxy zoteus:3939
}
```

---

## 4. Secrets

Generate and store these before first deploy. **Never put them in the Docker image or
commit them to git** — they go in your server-side `.env` file (which is git-ignored
via `.gitignore`).

| Variable | How to generate | Notes |
|---|---|---|
| `ZOTERO_API_KEY` | <https://www.zotero.org/settings/keys> | Required for passcode mode (single operator key). |
| `ZOTERO_OAUTH_CLIENT_KEY` | <https://www.zotero.org/oauth/apps> | Required for zotero mode (per-user login). Callback: `https://$ZOTEUS_DOMAIN/oauth/zotero/callback`. |
| `ZOTERO_OAUTH_CLIENT_SECRET` | (same registration) | Required for zotero mode. |
| `ZOTEUS_OAUTH_PASSCODE` | `openssl rand -base64 24` | Required for passcode mode; ≥ 12 characters. |
| `ZOTEUS_OAUTH_TOKEN_SECRET` | `openssl rand -base64 32` | AES-256-GCM key for the encrypted file store. **Back this up separately** — losing it means all users must re-auth. |
| `ZOTEUS_PUBLIC_URL` | `https://$ZOTEUS_DOMAIN` | Must match the exact origin claude.ai will connect to (no trailing slash). |
| `ZOTEUS_DOMAIN` | (your DuckDNS or custom subdomain) | Used by `deploy/Caddyfile`. |
| `DUCKDNS_TOKEN` | (from duckdns.org dashboard) | Only needed if using DNS-01 challenge for DuckDNS. |

Minimal `.env` for **passcode mode** (most common):

```dotenv
ZOTERO_API_KEY=your_zotero_api_key
ZOTEUS_OAUTH_PASSCODE=your_long_random_passcode
ZOTEUS_OAUTH_TOKEN_SECRET=your_aes256_key
ZOTEUS_PUBLIC_URL=https://zoteus.duckdns.org
ZOTEUS_DOMAIN=zoteus.duckdns.org
```

The `docker-compose.yml` already sets `ZOTEUS_OAUTH_ENABLED=true`,
`ZOTEUS_OAUTH_STORE=file`, `ZOTEUS_DATA_DIR=/data`, and `ZOTEUS_LOG_FORMAT=json`, so
you do not need to repeat them in `.env`.

---

## 5. Deploy

```bash
# Clone the repo (or copy docker-compose.yml + deploy/) onto the VM.
git clone https://github.com/oscardvs/zoteus.git
cd zoteus

# Create .env with the secrets from §4.
cp .env.example .env
$EDITOR .env

# Pull the image and start.
docker compose pull
docker compose up -d

# Confirm health.
curl -fsS https://$ZOTEUS_DOMAIN/healthz; echo
curl -fsS https://$ZOTEUS_DOMAIN/readyz; echo
```

Expected `healthz` response (200 OK):

```json
{"status":"ok","uptime":12}
```

Expected `readyz` response (200 OK — may show `"zotero":"degraded"` until a real
Zotero API key is configured):

```json
{"status":"ok","checks":{"store":"ok","zotero":"ok"}}
```

To redeploy after a new image is published:

```bash
docker compose pull && docker compose up -d
```

The old container drains gracefully (30 s stop grace period), flushes the OAuth store
to disk, and exits 0 before the new container takes over.

---

## 6. Add the connector in claude.ai

1. In claude.ai, go to **Settings → Connectors → Add custom connector**.
2. Enter `https://$ZOTEUS_DOMAIN/mcp` as the MCP URL.
3. Click **Connect** — claude.ai runs Dynamic Client Registration automatically.
4. The consent page appears. Enter the passcode (the value of `ZOTEUS_OAUTH_PASSCODE`).
5. After consent, the Zoteus tools appear in your conversation.

For **Claude Code CLI**:

```bash
claude mcp add --transport http zoteus https://$ZOTEUS_DOMAIN/mcp
# then: /mcp → Authenticate → enter the passcode in the browser
```

---

## 7. Acceptance test (the proof)

This test proves that persistence works — the connection survives a full redeploy with
no re-auth and a tool read returns real data.

```bash
# Step 1: Authorize once (§6 above). Verify a tool works, e.g. ask Claude to list
# your recent Zotero items.

# Step 2: Redeploy (simulate a routine update).
docker compose pull && docker compose up -d

# Step 3: Back in claude.ai, send a new message using the Zoteus connector.
# Expected: NO re-auth prompt; tools respond with your Zotero data.

# Step 4: Confirm no secrets appear in logs.
docker compose logs zoteus | grep -iE 'passcode|secret|token|api[_-]?key' || echo "no secrets in logs"
```

Expected: the grep finds nothing (prints `no secrets in logs`). The redacted
structured logger strips all secret-named fields before writing.

---

## 8. Observability

**Structured logs (`ZOTEUS_LOG_FORMAT=json`):**

```bash
docker compose logs --follow zoteus | jq .
```

Each request line includes `method`, `path`, `status`, `latencyMs`, and (where
available) `clientId` / `sessionId`. Health and metrics paths are excluded from
request logs to keep them quiet.

**Metrics counter endpoint:**

`ZOTEUS_METRICS_ENABLED=true` (set in `docker-compose.yml`) exposes `/metrics` in
Prometheus text format — no auth required, so keep it behind your proxy/WAF in
production or restrict with a Caddy `@internal` matcher:

```caddyfile
@metrics path /metrics
handle @metrics {
    @allowed remote_ip 127.0.0.1 10.0.0.0/8
    handle @allowed {
        reverse_proxy zoteus:3939
    }
    respond 403
}
```

**Caddy / host metrics:** Caddy exposes its own Prometheus metrics on `:2019` (admin
API, loopback only). For production monitoring wire both into Grafana/Loki or a
managed observability service of your choice.

---

## 9. Rate limiting / abuse

Default limits (overridable in `.env`):

| Variable | Default | Effect |
|---|---|---|
| `ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC` | `60` | Sliding window length (seconds) |
| `ZOTEUS_MCP_RATE_LIMIT_MAX` | `120` | Max requests per IP per window on `/mcp` |

`trust proxy` is set so limits key on the real client IP from `X-Forwarded-For` (as
set by Caddy), not the container's internal IP.

The OAuth sub-paths (`/authorize`, `/token`, `/register`, `/consent`) have their own
tighter limiters defined in the auth router. To disable the `/mcp` limiter entirely,
set `ZOTEUS_MCP_RATE_LIMIT_MAX=0`.

For additional protection (bot mitigation, geo-blocking, DDoS):

- **Cloudflare** — put your domain behind Cloudflare's free proxy tier. Add a WAF
  rule blocking non-MCP traffic patterns. Ensure "Full (Strict)" TLS mode.
- **Fail2ban** — monitor Caddy access logs for 429 bursts and ban offending IPs at
  the firewall level.

---

## 10. Backups & restore

**Automated backup (cron):**

```bash
# Run on the VM (not inside the container). Adjust DATA_DIR if using a bind mount.
echo "0 3 * * * root ZOTEUS_DATA_DIR=/var/lib/docker/volumes/zoteus_zoteus-data/_data \
  /path/to/zoteus/scripts/backup-store.sh /var/backups/zoteus" \
  | sudo tee /etc/cron.d/zoteus-backup
```

`scripts/backup-store.sh` archives `oauth-store.json` and all `search-index-*.json`
files, retaining the 14 most recent snapshots.

**Critical:** store `ZOTEUS_OAUTH_TOKEN_SECRET` in a separate location (e.g. a
password manager or a secrets manager). The backup archive is **useless without the
matching token secret** because the store is AES-256-GCM encrypted.

**Restore:**

```bash
docker compose stop zoteus
# Copy your backup archive into the data volume:
tar -xzf /var/backups/zoteus/zoteus-<STAMP>.tar.gz \
    -C /var/lib/docker/volumes/zoteus_zoteus-data/_data
# Ensure ZOTEUS_OAUTH_TOKEN_SECRET in .env matches the one used at backup time.
docker compose up -d zoteus
```

---

## 11. Rotation

### Rotating `ZOTEUS_OAUTH_PASSCODE`

Changing the passcode **forces a reconnect** for all users — they will see an auth
prompt on the next message. This is the expected behavior (the passcode is a gate on
the consent step, not on the token). Steps:

1. Generate a new passcode: `openssl rand -base64 24`.
2. Update `.env` (`ZOTEUS_OAUTH_PASSCODE=<new>`).
3. `docker compose up -d` — Zoteus reloads the passcode on start.

### Rotating `ZOTEUS_OAUTH_TOKEN_SECRET`

Changing the token secret **invalidates the entire encrypted store** — all registered
clients, tokens, and per-user Zotero keys are lost. Every user will need to
re-authorize. Steps:

1. Generate a new key: `openssl rand -base64 32`.
2. Update `.env` and also update your off-site backup copy of the secret.
3. Remove or rename the old store so Zoteus starts fresh: `docker compose exec zoteus
   mv /data/oauth-store.json /data/oauth-store.json.bak`.
4. `docker compose up -d`.

**Trade-off:** Rotating the token secret is a nuclear option. Only do it if you
suspect the old key has been compromised.

---

## 12. Incident checklist

### Revoke a specific user's tokens

```bash
# Inspect the store (file is encrypted; use jq after decrypt, or restart with a
# fresh store — the per-user entry re-creates on next login).
docker compose restart zoteus   # quick: clears in-memory pending consents
# For a full revoke, remove the user's entry from /data/oauth-store.json and restart.
```

### Rotate the operator Zotero key

1. Revoke the old key at <https://www.zotero.org/settings/keys>.
2. Create a new key.
3. Update `ZOTERO_API_KEY` in `.env`.
4. `docker compose up -d`.

### Take the service down

```bash
docker compose stop        # drains gracefully (30 s), flushes store, exits 0
# To bring back: docker compose start
```

### Read logs

```bash
docker compose logs --tail 200 --follow zoteus | jq .
# Filter errors only:
docker compose logs zoteus | jq 'select(.level=="error")'
```

---

## 13. Alternatives

### Fly.io (paid)

A `fly.toml` is included at the repo root. Fly provides auto-TLS, a persistent volume
mount, and always-on machines (`auto_stop_machines = false`):

```bash
fly launch --no-deploy        # import fly.toml
fly secrets set ZOTERO_API_KEY=xxx ZOTEUS_OAUTH_PASSCODE=xxx \
    ZOTEUS_OAUTH_TOKEN_SECRET=$(openssl rand -base64 32) \
    ZOTEUS_PUBLIC_URL=https://zoteus.fly.dev
fly deploy
```

Note: Fly is paid (the free allowance was retired). Always-on requires at least the
"pay as you go" plan.

### Render / Railway

Both provide free-tier Node.js deployments. **Caveats:**

- **Free tiers sleep after inactivity** — claude.ai connections time out during spin-up.
- **No persistent disk on free tier** — the encrypted file store is lost on each
  restart, forcing all users to re-auth. Use only if you accept the re-auth on each
  cold start or if you pay for a persistent disk add-on.
- Set `ZOTEUS_OAUTH_STORE=memory` to avoid spurious decryption errors on a non-persistent filesystem.

### Cloudflare named tunnel (to an always-on box)

If your VM has no public IP (or is behind CGNAT), use a Cloudflare named tunnel:

```bash
cloudflared tunnel create zoteus
cloudflared tunnel route dns zoteus zoteus.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:3939 zoteus
```

The tunnel forwards the original `Host` header by default — compatible with Zoteus's
DNS-rebinding guard. Set `ZOTEUS_PUBLIC_URL=https://zoteus.yourdomain.com`.

**All alternatives must forward the public `Host` header verbatim.** Zoteus performs
exact-match DNS-rebinding protection on every request; a proxy that rewrites `Host`
(e.g. some ELB configurations) will cause 421 errors.

---

## 14. CI/CD

Tagging a release (`vX.Y.Z`) triggers the GitHub Actions workflow
(`.github/workflows/deploy.yml`) which builds a multi-arch Docker image and pushes it
to GHCR as `ghcr.io/oscardvs/zoteus:latest` and `ghcr.io/oscardvs/zoteus:vX.Y.Z`.

**VM pull-based update:**

```bash
# Manual (run on the VM):
docker compose pull && docker compose up -d

# Automated (watchtower — polls GHCR for new :latest every 5 minutes):
docker run -d --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower --interval 300 zoteus-zoteus-1
```

**Deployment is zero-downtime within a single instance** — the old container drains
(Zoteus's `SIGTERM` handler waits for in-flight MCP sessions, flushes the OAuth store
and search indexes to disk, then exits 0) before Docker starts the replacement.
