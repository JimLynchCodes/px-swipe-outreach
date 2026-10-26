# Build from the REPO ROOT so the Supabase migrations are in the context:
#   docker build -f retail-outreach-backend/Dockerfile -t outreach-api .
FROM node:20-alpine AS build
WORKDIR /app
COPY retail-outreach-backend/package.json retail-outreach-backend/package-lock.json ./
RUN npm ci
COPY retail-outreach-backend/tsconfig.json retail-outreach-backend/tsconfig.build.json ./
COPY retail-outreach-backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 SUPABASE_DIR=/app/supabase
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY retail-outreach-backend/package.json ./
COPY supabase/migrations ./supabase/migrations
COPY supabase/tests/bootstrap_plain_postgres.sql ./supabase/tests/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Worker: override with ["node", "dist/worker.js"]. Migrations: ["node", "dist/db/migrate.js"].
CMD ["node", "dist/server.js"]
