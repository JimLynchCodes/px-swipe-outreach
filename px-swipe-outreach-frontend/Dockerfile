# docker build -f px-swipe-outreach-frontend/Dockerfile \
#   --build-arg VITE_SUPABASE_URL=... --build-arg VITE_SUPABASE_ANON_KEY=... -t outreach-web .
# VITE_* values are PUBLIC (baked into the bundle). Never pass the service_role key.
FROM node:20-alpine AS build
WORKDIR /app
COPY px-swipe-outreach-frontend/package.json px-swipe-outreach-frontend/package-lock.json ./
RUN npm ci
COPY px-swipe-outreach-frontend/ ./
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_ANON_KEY=
ARG VITE_API_BASE_URL=
ARG VITE_DEMO_MODE=
RUN npm run build

FROM nginx:1.27-alpine
# API_UPSTREAM: where /api is proxied (same-origin deploys). e.g. http://api:3000
ENV API_UPSTREAM=http://api:3000
COPY px-swipe-outreach-frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
