# Deployment

## Components
| Component | Image / command | Notes |
|---|---|---|
| API | `retail-outreach-backend/Dockerfile` → `node dist/server.js` | Stateless; scale horizontally. `/health/live` (liveness), `/health/ready` (DB + Redis). |
| Worker | same image → `node dist/worker.js` | Needed when `DELIVERY_MODE=queue`. |
| Migrations | same image → `node dist/db/migrate.js` or `supabase db push` | Run once per release, before rolling the API. |
| Web | `px-swipe-outreach-frontend/Dockerfile` (nginx) | Static SPA with security headers; proxies `/api` to `API_UPSTREAM`. |
| Postgres + Auth | Supabase | See [SUPABASE_SETUP.md](SUPABASE_SETUP.md). |
| Redis | any managed Redis | Only for `DELIVERY_MODE=queue`. |

Build both images from the **repo root**:
```bash
docker build -f retail-outreach-backend/Dockerfile -t outreach-api .
docker build -f px-swipe-outreach-frontend/Dockerfile \
  --build-arg VITE_SUPABASE_URL=https://<ref>.supabase.co \
  --build-arg VITE_SUPABASE_ANON_KEY=<anon key> -t outreach-web .
```

## Production checklist
- `NODE_ENV=production`. Config validation then **refuses to boot** unless `AUTH_MODE=supabase`, `DATA_STORE=postgres`, `CORS_ORIGIN` lists explicit https origins, and the demo reset is off.
- `TRUST_PROXY=true` behind a load balancer (correct client IPs for rate limiting and logs).
- Set `DATABASE_CA_CERT` for verified TLS to Supabase.
- Tune `RATE_LIMIT_PER_MINUTE` / `SEND_RATE_LIMIT_PER_MINUTE`. Limits are in-memory per instance; use a Redis store if you run many replicas.
- On SIGTERM the server stops accepting, drains in-flight requests, closes DB/Redis, and exits within `SHUTDOWN_TIMEOUT_MS`.
- Logs are JSON (pino) with request IDs (`X-Request-Id` is accepted or generated, and echoed). Auth headers, cookies, phone numbers, emails and message bodies are redacted.

## Local production-like stack
```bash
docker compose run --rm migrate   # schema + RLS + demo seed (plain Postgres)
docker compose up --build         # web on :8080, api on :3000
```
