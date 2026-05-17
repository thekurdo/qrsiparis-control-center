# Control Center E2E Test Suite

End-to-end Playwright suite covering 19 product scenarios plus 4 smoke tests across auth, wizard onboarding, deploy pipeline, ops, and tenant lifecycle.

## Status

**27 / 27 passing** as of the latest commit. Full run takes ~50 seconds.

## Prerequisites

Before running:

1. Install dependencies: `pnpm install`
2. Copy and configure environment: `cp .env.example .env` (or use the dev defaults that ship with this repo for local testing)
3. Start backing services via Docker compose:
   ```sh
   export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"  # Windows host only
   docker compose -f docker/docker-compose.dev.yml up -d postgres redis coolify-mock
   ```
4. Apply migrations and seed the admin operator:
   ```sh
   pnpm db:migrate          # or `node scripts/migrate.mjs` for verbose errors
   pnpm db:seed
   ```
5. Start the Next.js dev server and the BullMQ deployment worker in two separate terminals (both must be running for deploy-pipeline scenarios):
   ```sh
   pnpm dev          # port 3001
   pnpm worker       # background worker
   ```

## Host port map

The dev compose file deliberately maps services to non-default host ports so they don't clash with locally-installed Postgres / Redis instances on Windows dev workstations.

| Service | In-container | Host |
|---|---|---|
| Postgres | 5432 | **55432** |
| Redis | 6379 | **16379** |
| WireMock (Coolify mock) | 8080 | **58080** |

`.env` is already aligned to these host ports.

## Running

```sh
pnpm test:e2e                                          # full suite
pnpm test:e2e tests/e2e/group-a-auth/                  # one group
pnpm test:e2e tests/e2e/group-a-auth/s01-login-happy.spec.ts   # one scenario
pnpm test:e2e --headed                                 # see the browser
pnpm test:e2e --debug                                  # step-through
```

JSON reporter writes to `test-results/results.json`; HTML to `playwright-report/`. Open the HTML report with `pnpm exec playwright show-report`.

## Mock layer

The suite never talks to a real Coolify or Hostinger VPS. Coolify is stubbed via WireMock and SSH is replaced by an in-memory mock when `TEST_MODE=mock` is set.

### Coolify (WireMock)

11 stub mappings live under `docker/wiremock/mappings/`. The `X-Mock-Mode` header drives failure scenarios:

| Mode | Behaviour |
|---|---|
| (none / `happy`) | Default — all calls succeed; deployment polls progress `queued → in_progress → success` |
| `deploy-fail` | `POST /applications/{uuid}/deploy` returns 500 |
| `health-fail` | App `GET /applications/{uuid}` returns `status='failed'`; deployment job itself still succeeds (models "container started but healthcheck failed") |
| `timeout` | Deployment poll responds with `in_progress` forever |

The default `CoolifyClient` honours the `COOLIFY_MOCK_MODE` env var so the worker can be driven into a specific failure path during a test. Per-test runtime mappings can also be added via the `addCoolifyMapping()` / `resetCoolifyMappings()` helpers in `tests/e2e/fixtures/mocks.ts`.

### SSH

`getSshClient()` in `src/lib/ssh/` returns `SshMockClient` when `TEST_MODE=mock`. The mock has a small dictionary of canned responses (`docker ps`, `docker stats`, `df -h`, `uptime`, `pg_dump`, `tar`). Failure modes are injected via `SSH_MOCK_FAIL=connect|timeout|auth` — note that this needs to be set in the dev server / worker's environment before boot for full-server-process E2E scenarios.

## Fixtures

All test fixtures live under `tests/e2e/fixtures/`:

| File | Exports |
|---|---|
| `db.ts` | `truncateAll()`, `rawQuery<T>(sql, params)` — pg Pool against `DATABASE_URL`. Truncates `audit_log`, `deployments`, `tenants`, `servers` (preserves seeded admin operator). |
| `mocks.ts` | `resetAllMocks()`, `resetCoolifyScenarios()`, `flushRedis()`, `addCoolifyMapping()`, `removeCoolifyMapping()`, `resetCoolifyMappings()`, `getCoolifyRequestCount()`. |
| `data.ts` | Deterministic counter-based factories: `tenantData()`, `serverData()`, `operatorData()`, plus `TEST_PASSWORD` and pre-computed `TEST_PASSWORD_HASH`. |
| `server.fixture.ts` | `createServer()`, `createServerAtCapacity()`. |
| `tenant.fixture.ts` | `createTenant()`, `createActiveTenant()`, `createDeployableTenant()` (seeds `config_snapshot` so step02 doesn't fail). |
| `auth.fixture.ts` | Playwright `test.extend` with `loggedInAdmin`, `loggedInOperator`, `freshOperator` fixtures. Handles 2FA setup + verify flows via `otplib`. |

## Scenarios

### Group A — Authentication (4)

| ID | Test | Notes |
|---|---|---|
| S1 | `s01-login-happy.spec.ts` | Login + 2FA setup happy path → backup codes + audit row |
| S6 | `s06-login-lockout.spec.ts` | 5 failed attempts → 15 min lockout → reset on first success |
| S12 | `s12-2fa-backup.spec.ts` | Backup code consumed 4→3 + replay rejected + audit |
| S14 | `s14-role-downgrade.spec.ts` | Admin → operator demotion blocks `/musteriler/yeni` + audit |

### Group B — Wizard (3)

| ID | Test | Notes |
|---|---|---|
| S2 | `s02-wizard-happy.spec.ts` | All 7 wizard steps → tenant create → pipeline → `status='active'` |
| S7 | `s07-wizard-invalid.spec.ts` | Invalid domain format AND duplicate domain (409); no phantom rows |
| S10 | `s10-server-capacity.spec.ts` | 20/20 server disabled in Step 6 picker; empty server selectable |

### Group C — Deploy (4)

| ID | Test | Notes |
|---|---|---|
| S8 | `s08-pipeline-fail-rollback.spec.ts` | health-fail mode → step 7 fails → rollback steps 6→3 + audit |
| S9 | `s09-stuck-recovery.spec.ts` | `in_progress` >30 min → cron forces failure + BullMQ cleanup + audit |
| S17 | `s17-concurrent-deploy-lock.spec.ts` | Second POST during running deploy → 409 CONFLICT; lock releases after completion |
| S18 | `s18-sse-log-stream.spec.ts` | EventSource receives `step.start`/`step.done` live; DB log column matches |

### Group D — Ops (7)

| ID | Test | Notes |
|---|---|---|
| S3 | `s03-server-detail.spec.ts` | List badges + detail page capacity + live SSH `docker stats` |
| S4 | `s04-operator-user-create.spec.ts` | Admin creates user → bcrypt-hashed, plaintext shown once, audit row, new user can log in |
| S5 | `s05-audit-log-write.spec.ts` | 4 distinct actions captured; all filter dimensions + pagination work; UI has no edit/delete controls |
| S11 | `s11-audit-log-immutable.spec.ts` | DB trigger rejects `UPDATE`/`DELETE`; `INSERT` still works |
| S15 | `s15-contract-expiry.spec.ts` | 7-day expiry warnings; only flagged tenants; idempotent on re-run |
| S16 | `s16-schema-drift.spec.ts` | `schema_version < EXPECTED` → audit + UI banner; idempotent |
| S19 | `s19-backup-cron.spec.ts` | Mock SSH `pg_dump` per active tenant; inactive tenants skipped; S11 immutability preserved |

### Group E — Lifecycle (1)

| ID | Test | Notes |
|---|---|---|
| S13 | `s13-tenant-lifecycle.spec.ts` | Pause → Resume → Cancel → cancelled blocks redeploy; each transition hits Coolify + writes audit |

## Conventions

- **Action naming**: Resource lifecycle uses dotted form (`tenant.created`, `deployment.failed`, `operator_user.created`). Auth-specific security events use snake_case (`backup_code_used`, `operator_role_changed`, `2fa_enabled`).
- **Audit `user_id IS NULL`** is the canonical discriminator for cron-emitted / system-driven rows; operator-driven rows always have a user.
- **24h idempotency gate** lives in any cron that writes audit rows (S15 / S16 / S19 all share the same pattern).
- **Test data IDs** come from a deterministic counter so failures are reproducible across runs.

## Adding a new scenario

1. Create a spec under the appropriate group folder (or a new one).
2. Use `truncateAll()` + `resetAllMocks()` + `resetCounter()` in `beforeEach`.
3. Build the world via the fixtures rather than direct DB writes where possible — fixtures keep the surface stable as the schema evolves.
4. Wrap WireMock state changes with `resetCoolifyMappings()` in `afterEach` if you used `addCoolifyMapping()`.
5. Prefer asserting on data attributes (`data-testid`, `data-status`, etc.) over visible text so the spec survives i18n changes.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `password authentication failed for user 'qrsiparis'` | Another Postgres listening on 5432 (Windows local install) | Confirm `DATABASE_URL` in `.env` uses host port 55432 |
| Migration "hangs" then `ELIFECYCLE Command failed` with no output | drizzle-kit's spinner swallowed the error | `node scripts/migrate.mjs` surfaces the real error |
| `Cannot find module '@/lib/...'` from a spec | Playwright not honouring tsconfig paths | Add a relative import; do not rely on `await import()` dynamic resolution |
| Auth test redirects to `/2fa-setup` repeatedly | StrictMode double-init issue on the setup endpoint | Direct-seed `two_factor_enabled=true` + a real secret + 4 backup codes in `beforeEach` (see `s14-role-downgrade.spec.ts` for the helper) |
| `docker ps` returns "daemon not running" | Docker Desktop not started | Open Docker Desktop, wait for "Engine running" |

## CI

Not wired yet. To wire CI, build the Docker images via `docker build`, run the same compose stack against a clean Postgres, and execute `pnpm test:e2e --reporter=junit` once for terminal output + JUnit XML for the CI dashboard.
