# Deploy at `outreach.pineapplexpress.com`

This guide gets the app on **exactly** `https://outreach.pineapplexpress.com` (no `www`, no `api.` subdomain required). The Docker Compose stack in this repo already serves the SPA and proxies `/api` to the API on the **same origin**, which is the preferred layout.

For the general production checklist (images, env validation, Redis, workers), see [DEPLOYMENT.md](DEPLOYMENT.md). For Supabase Auth project setup, see [SUPABASE_SETUP.md](SUPABASE_SETUP.md).

## Recommended topology (same origin)

```
Browser → https://outreach.pineapplexpress.com
            │
            ├─ /           → web (nginx SPA)
            ├─ /api/*      → api:3000   (nginx proxy_pass; see px-swipe-outreach-frontend/nginx.conf.template)
            └─ /healthz    → web health
```

The API also listens on its own port inside the Docker network (`api:3000`). You do **not** need `api.outreach.pineapplexpress.com` unless you deliberately split hosts (notes at the end).

| Piece | Role |
| --- | --- |
| DNS | `outreach` → your VPS / load balancer |
| TLS terminator | Caddy (automatic HTTPS) or your host's load balancer |
| `web` container | Static frontend; proxies `/api` to `API_UPSTREAM=http://api:3000` |
| `api` (+ optional `worker`) | Backend; `APP_URL` / `PUBLIC_API_URL` / `CORS_ORIGIN` point at the public origin |
| Supabase | Postgres + Auth (hosted) |
| Redis | Only if `DELIVERY_MODE=queue` |

## 1. DNS

Create records at whatever registrar holds `pineapplexpress.com` (Namecheap, Cloudflare, Google Domains / Squarespace, Route 53, GoDaddy, etc.). Steps are the same everywhere: open DNS for the zone → add record → wait for TTL.

| Type | Name / host | Value | TTL |
| --- | --- | --- | --- |
| **CNAME** (preferred when the host gives you a hostname) | `outreach` | The host target, e.g. `your-vps.example.net` or `xxx.ondigitalocean.app` | 300–3600 s while testing, then 3600+ |
| **A** | `outreach` | Your VPS IPv4 | same |
| **AAAA** | `outreach` | Your VPS IPv6 (if you serve IPv6) | same |

- Do **not** put a CNAME on the zone apex (`pineapplexpress.com`); only on the `outreach` label.
- If the host asks for a **verification TXT** (e.g. `_acme-challenge.outreach` or a provider-specific `outreach` TXT), add it temporarily, wait for the host to verify, then you can remove it unless they ask you to keep it.
- **CAA** (optional but good): if the zone already has CAA records, allow your ACME CA. For Let's Encrypt via Caddy:

  ```
  outreach.pineapplexpress.com.  CAA  0 issue "letsencrypt.org"
  ```

  (Or a zone-wide CAA on `pineapplexpress.com` that already includes `letsencrypt.org`.)

Propagate: `dig +short outreach.pineapplexpress.com` (or `nslookup`) from your laptop until it returns the expected target.

## 2. HTTPS

Terminate TLS in front of Docker. With **Caddy** on the VPS (automatic Let's Encrypt):

```caddy
# /etc/caddy/Caddyfile
outreach.pineapplexpress.com {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
```

Point Docker Compose `web` at host port `8080` (as in the repo's `docker-compose.yml`). Caddy obtains and renews the cert as long as DNS points here and ports 80/443 are open.

Alternatives: Traefik, nginx + certbot, Cloudflare Full (strict) proxy, or your platform's managed TLS (Render / Fly / Railway).

## 3. Env values for this hostname

Set these on the **API** (and matching build args on **web**). Replace nothing else with a different host — keep the exact domain.

| Variable | Value |
| --- | --- |
| `APP_URL` | `https://outreach.pineapplexpress.com` |
| `PUBLIC_API_URL` | `https://outreach.pineapplexpress.com` (same origin; unsubscribe links, Twilio callbacks, and invite links are built from this) |
| `CORS_ORIGIN` | `https://outreach.pineapplexpress.com` (exact; no trailing slash) |
| `TRUST_PROXY` | `true` (Caddy / any reverse proxy) |
| `NODE_ENV` | `production` |
| `AUTH_MODE` | `supabase` |
| `DATA_STORE` | `postgres` |
| `UNSUBSCRIBE_SIGNING_SECRET` | ≥ 32 random chars |

**Frontend build args** (baked into the SPA at image build time):

| Build arg | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_…` key |
| `VITE_API_BASE_URL` | leave **empty** for same-origin `/api` (recommended) |
| `VITE_DEMO_MODE` | `false` |

Example build:

```bash
docker build -f retail-outreach-backend/Dockerfile -t outreach-api .
docker build -f px-swipe-outreach-frontend/Dockerfile \
  --build-arg VITE_SUPABASE_URL=https://<ref>.supabase.co \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_… \
  --build-arg VITE_DEMO_MODE=false \
  -t outreach-web .
```

Compose snippet (same origin): keep `web.environment.API_UPSTREAM=http://api:3000` and publish only `8080` (or let Caddy bind 80/443 and proxy to 8080).

### Supabase Auth URLs

In the Supabase dashboard → Authentication → URL configuration:

| Setting | Value |
| --- | --- |
| Site URL | `https://outreach.pineapplexpress.com` |
| Redirect URLs | `https://outreach.pineapplexpress.com/**` (and any local `http://localhost:5173/**` you still use) |

### Twilio

| Webhook | URL |
| --- | --- |
| Inbound SMS | `https://outreach.pineapplexpress.com/webhooks/twilio/sms/<orgId>` |
| Status callback | `https://outreach.pineapplexpress.com` + the status path your `PUBLIC_API_URL` already embeds when sending (see [OUTREACH_FEATURES.md](OUTREACH_FEATURES.md)); with same-origin this is under `/webhooks/…` on this host |

Set `TWILIO_AUTH_TOKEN` so signature verification works behind the proxy.

### Unsubscribe / email links

One-click unsubscribe and re-opt-in links are minted with `PUBLIC_API_URL`, so they will look like:

`https://outreach.pineapplexpress.com/…`

No extra DNS is required for those paths.

### SMTP from `pineapplexpress.com` (optional)

If `EMAIL_PROVIDER=smtp` and `SMTP_FROM` uses `@pineapplexpress.com` (or a subdomain), publish these on the **sending** domain (often the apex, or a dedicated `mail.` / `outreach.` name your ESP gives you):

| Record | Purpose |
| --- | --- |
| **SPF** TXT on the From domain | `v=spf1 include:… ~all` (include your ESP / VPS as they document) |
| **DKIM** TXT | Hostname/value from your ESP (or OpenDKIM on the VPS) |
| **DMARC** TXT on `_dmarc` | e.g. `v=DMARC1; p=none; rua=mailto:dmarc@pineapplexpress.com` while warming up |

Match `SMTP_FROM` to a domain that has those records. Gmail/app-password tests can skip this; production deliverability cannot.

## 4. Typical VPS + Docker Compose + Caddy

1. Point DNS `outreach` A/AAAA (or CNAME) at the VPS; open 80/443.
2. Install Docker, Docker Compose, and Caddy.
3. Clone this repo; copy `.env` from `.env.example` files and fill the values in §3.
4. `docker compose run --rm migrate` then `docker compose up -d` (api, worker if queue mode, web on `:8080`).
5. Drop in the Caddyfile above; `systemctl reload caddy`.
6. Confirm `https://outreach.pineapplexpress.com/healthz` and `https://outreach.pineapplexpress.com/api/health` (or `/health/live`).

## 5. Brief notes for hosted platforms

| Platform | Notes |
| --- | --- |
| **Render** | Web service for `web` (or static + reverse proxy), separate service for `api`. Attach custom domain `outreach.pineapplexpress.com` on the public service. If web and api are separate services, either put a rewrite so `/api` hits the API service, or set `VITE_API_BASE_URL` / `PUBLIC_API_URL` to the API's URL and add that origin to `CORS_ORIGIN`. |
| **Fly.io** | One app for api, one for web (or a process group). Use a Fly subdomain first, then add the custom cert for `outreach.pineapplexpress.com`. Prefer a single public app that proxies `/api` like nginx does here. |
| **Vercel (frontend) + API host** | Build the frontend with `VITE_API_BASE_URL=https://outreach.pineapplexpress.com` only if the API is on that same host; otherwise use something like `https://api.outreach.pineapplexpress.com` and list **both** origins carefully. You will need a second DNS name and CORS. Same-origin Compose remains simpler. |

## 6. Post-deploy checklist

- [ ] `dig +short outreach.pineapplexpress.com` matches the host
- [ ] `https://outreach.pineapplexpress.com` loads with a valid cert (no mixed content)
- [ ] `https://outreach.pineapplexpress.com/api/health/live` (or `/health`) returns ok
- [ ] Supabase Site URL + Redirect URLs include this origin
- [ ] Sign-in / sign-up round-trip works
- [ ] Twilio inbound + status webhooks return 2xx (update the console URLs)
- [ ] Unsubscribe link in a test email/SMS hits this host and opts out
- [ ] `CORS_ORIGIN` is exactly `https://outreach.pineapplexpress.com` (production refuses `*`)
- [ ] `APP_URL` and `PUBLIC_API_URL` use `https://`, no trailing slash
- [ ] Demo auth / demo reset are off (`AUTH_MODE=supabase`, no demo reset in prod)

## Optional: split API subdomain

Only if you cannot proxy `/api` on the same host:

1. DNS: `api.outreach` → API host (A/CNAME).
2. `PUBLIC_API_URL=https://api.outreach.pineapplexpress.com`
3. Frontend `VITE_API_BASE_URL=https://api.outreach.pineapplexpress.com`
4. `CORS_ORIGIN=https://outreach.pineapplexpress.com`
5. Separate cert for `api.outreach.pineapplexpress.com`
6. Twilio / unsubscribe URLs follow `PUBLIC_API_URL`

Prefer same-origin unless you have a reason to split.
