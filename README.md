# QrSiparis Control Center

Cyxares-internal panel for QrSiparis tenant onboarding, deployment orchestration, and infrastructure management.

This is a **separate codebase** from `qrsiparis-app` (the customer product). It runs against PostgreSQL (not SQLite), uses BullMQ for the deployment pipeline, and is the home of the 7-step onboarding wizard, server / VPS registry, deployment log streaming, and operator audit log.

## Tech stack

- **Runtime:** Node.js 24+, pnpm 9+
- **App framework:** Next.js 16 (App Router, standalone output, port 3001)
- **DB:** PostgreSQL 16+ via Drizzle ORM + `pg`
- **Queue:** BullMQ + ioredis
- **Auth:** Auth.js v5 with TOTP 2FA (otplib) + 4 backup codes
- **Orchestration glue:** Coolify API client + `ssh2` for VPS management
- **Encryption:** AES-256-GCM for `coolifyApiToken`, `sshPrivateKey`, `twoFactorSecret` (master key in `MASTER_KEY` env)
- **UI:** Tailwind v4 dark theme (V1 dark-only), `lucide-react`, `@monaco-editor/react`, `react-markdown`
- **Tests:** Vitest + Playwright

## Project layout (high-level)

```
src/
  app/
    (auth)/         login, 2fa-setup, 2fa-verify
    (panel)/        dashboard + musteriler + sunucular + deployments + sistem + faturalama
    api/internal/   tenants, servers, deployments, operator-users, health, auth/[...nextauth]
  components/
  db/               schema, client, seed
  lib/
    auth/           operator, totp, backup-codes
    deploy/         pipeline, steps, errors, runner
    coolify/        client, types
    ssh/            client
    crypto/         aes-gcm
    crons/          health-check, resource-monitor, contract-expiry, daily-backup,
                    deployment-stuck-recovery, tenant-schema-drift-detector
    sse/            log-stream
    api/            response, errors
  workers/          deployment-worker.ts (BullMQ entry)
  types/            deploy, coolify
docker/
  Dockerfile        two-stage targets: app + worker
  docker-compose.dev.yml
scripts/
  start-server.sh
  start-worker.sh
tests/
  unit/  integration/  e2e/  setup.ts
```

## Local development

1. Copy environment template and fill in secrets:
   ```sh
   cp .env.example .env
   # generate AUTH_SECRET and MASTER_KEY:
   openssl rand -hex 32   # → AUTH_SECRET
   openssl rand -hex 32   # → MASTER_KEY
   ```

2. Start Postgres + Redis (compose):
   ```sh
   docker compose -f docker/docker-compose.dev.yml up -d postgres redis
   ```

3. Install deps and run migrations / seed:
   ```sh
   pnpm install
   pnpm db:migrate
   pnpm db:seed
   ```

4. Start the app and worker (two terminals):
   ```sh
   pnpm dev          # Next.js on :3001
   pnpm worker       # BullMQ deployment worker
   ```

## Build images

The Docker build is multi-stage with two runtime targets (per IMPL_NOTES §1 two-image approach):

```sh
docker build --target=app    -t qrsiparis-cc-app:dev    -f docker/Dockerfile .
docker build --target=worker -t qrsiparis-cc-worker:dev -f docker/Dockerfile .
```

CI publishes both as `ghcr.io/cyxares/qrsiparis-cc-app:${tag}` and `ghcr.io/cyxares/qrsiparis-cc-worker:${tag}` on git tag `v*.*.*`.

## Documentation

Authoritative implementation references live in the parent repo's `plan/`:

- `plan/MASTER_PLAN.md` — Section 2 / Section 3 Phase H
- `plan/IMPLEMENTATION_NOTES.md` — supersedes the master plan on conflict (esp. §1 PB1-PB4, §3 helpers, §4 R13-R18)
- `summaries/03b_admin_internal_deploy.md` — Doc 17/18 summary
