# syntax=docker/dockerfile:1.7
# QrSiparis Control Center — Multi-stage Dockerfile
#
# Per IMPLEMENTATION_NOTES.md §1 (two-image approach):
#   docker build --target=app    -t qrsiparis-cc-app:${tag}    .
#   docker build --target=worker -t qrsiparis-cc-worker:${tag} .
#
# `app` runs Next.js (port 3001 inside the container).
# `worker` runs the BullMQ deployment worker (no listening port).

# ---------- Stage: deps ----------
FROM node:24-alpine AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
# Native modules: bcrypt, ssh2 may need build-essentials on alpine
RUN apk add --no-cache --virtual .build-deps python3 make g++ openssh-client \
    && pnpm install --frozen-lockfile --prod=false \
    && apk del .build-deps

# ---------- Stage: builder ----------
FROM node:24-alpine AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG APP_VERSION=dev
ARG GIT_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION
ENV GIT_COMMIT=$GIT_COMMIT
ENV NEXT_TELEMETRY_DISABLED=1

# Public base domain for tenant subdomains — inlined into the client bundle at
# build time (NEXT_PUBLIC_*). Override per-environment via the compose build
# arg; defaults to the prod domain so a missing arg still yields a correct build.
ARG NEXT_PUBLIC_BASE_DOMAIN=siparisqr.com.tr
ENV NEXT_PUBLIC_BASE_DOMAIN=$NEXT_PUBLIC_BASE_DOMAIN

# Next.js's "Collecting page data" phase evaluates route handlers, which
# can hit code that reads env (e.g. DB url, MASTER_KEY). Provide buildtime
# placeholders here so the build doesn't crash. Runtime env in the
# compose file overrides every one of these.
ENV DATABASE_URL=postgres://build-placeholder:placeholder@127.0.0.1:5432/build
ENV REDIS_URL=redis://127.0.0.1:6379
ENV AUTH_SECRET=build_placeholder_auth_secret_not_used_at_runtime
ENV MASTER_KEY=00000000000000000000000000000000000000000000000000000000deadbeef
ENV COOLIFY_API_URL=http://placeholder:8000
ENV COOLIFY_API_TOKEN=build_placeholder_token
ENV DEFAULT_OPERATOR_EMAIL=build@placeholder.local

# Ensure public/ exists even if the repo doesn't ship one yet; the app
# stage unconditionally copies /app/public and would otherwise fail with
# "public: not found".
RUN mkdir -p /app/public

# Next.js standalone build (writes .next/standalone)
RUN pnpm build

# Compile worker(s) with tsx-friendly output for the worker image stage
# (We still rely on `tsx` at runtime in the worker image since the worker is
# not bundled by Next.)

# ---------- Stage: app (runtime) ----------
FROM node:24-alpine AS app
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
# Bind on every interface so Docker HEALTHCHECK (wget 127.0.0.1:3001)
# and the Coolify Traefik upstream both reach the app. Next.js standalone
# `server.js` reads HOSTNAME — without this it defaults to the container
# hostname and only that interface accepts connections.
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Add openssh-client for any host-key auxiliary tooling; ssh2 lib uses pure-JS
RUN apk add --no-cache openssh-client tini

# Create the unprivileged user FIRST, then COPY with --chown so we never
# need a slow `chown -R /app` (which times out on Coolify's exec session
# when node_modules has 100k+ files).
RUN addgroup -S app && adduser -S app -G app

# Bring in the Next.js standalone output + static + public (already owned by app)
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public

USER app

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/internal/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

# ---------- Stage: worker (runtime) ----------
FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apk add --no-cache openssh-client tini

# Create user FIRST, then COPY --chown so we never need `chown -R /app`
# (which on a fresh build times out Coolify's exec session because the
# worker's node_modules has 100k+ files).
RUN addgroup -S worker && adduser -S worker -G worker

# Worker needs full source + node_modules; it is not standalone-bundled.
COPY --from=builder --chown=worker:worker /app/node_modules ./node_modules
COPY --from=builder --chown=worker:worker /app/package.json ./package.json
COPY --from=builder --chown=worker:worker /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=worker:worker /app/src ./src
COPY --from=builder --chown=worker:worker /app/scripts ./scripts
# Drizzle migrations must be present so `pnpm db:migrate` (run as the
# worker container's init step on first deploy) can find the SQL files.
# Without this the migrate command exits non-zero and the SQL has to be
# applied manually via psql — which is exactly what happened on the
# first production deploy.
COPY --from=builder --chown=worker:worker /app/drizzle ./drizzle

USER worker

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "run", "worker"]
