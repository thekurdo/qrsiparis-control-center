/**
 * CoolifyClient unit tests — runs against the dev WireMock instance
 * (port 58080). Stub mappings are mounted from
 * docker/wiremock/mappings/*.json.
 *
 * Run: pnpm test tests/unit/coolify/client.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CoolifyClient } from '@/lib/coolify/client';
import { CoolifyApiError } from '@/types/coolify';

const COOLIFY_URL = process.env['COOLIFY_API_URL'] ?? 'http://localhost:58080';

async function resetWireMock(): Promise<void> {
  await fetch(`${COOLIFY_URL}/__admin/scenarios/reset`, { method: 'POST' });
}

describe('CoolifyClient (against WireMock)', () => {
  let client: CoolifyClient;

  beforeAll(async () => {
    // Sanity check that wiremock is up so tests don't fail mysteriously.
    const r = await fetch(`${COOLIFY_URL}/__admin/health`);
    expect(r.ok, 'WireMock not reachable at ' + COOLIFY_URL).toBe(true);
  });

  beforeEach(async () => {
    await resetWireMock();
    client = new CoolifyClient({ baseUrl: COOLIFY_URL, token: 'test-token' });
  });

  afterAll(async () => {
    await resetWireMock();
  });

  it('createApp returns a uuid', async () => {
    const app = await client.createApp({
      name: 'unit-test-tenant',
      domain: 'unit.test.local',
      serverUuid: 'srv-1',
      dockerImage: 'qrsiparis-app:test',
      envVars: { FOO: 'bar' },
    });
    expect(app.uuid).toMatch(/^test-/);
    expect(app.name).toBe('unit-test-tenant');
    expect(app.domain).toBe('unit.test.local');
  });

  it('deployApp returns a deployment_uuid', async () => {
    const app = await client.createApp({
      name: 'd-test',
      domain: 'd.test.local',
      serverUuid: 'srv-1',
      dockerImage: 'qrsiparis-app:test',
      envVars: {},
    });
    const r = await client.deployApp(app.uuid);
    expect(r.deployment_uuid).toMatch(/^test-/);
  });

  it('pollDeployment progresses to success in happy mode', async () => {
    const status = await client.pollDeployment('deploy-1', 10_000);
    expect(status).toBe('success');
  });

  it('deploy-fail mode causes deployApp to throw 500', async () => {
    const failClient = new CoolifyClient({
      baseUrl: COOLIFY_URL,
      token: 'test-token',
      mockMode: 'deploy-fail',
    });
    await expect(failClient.deployApp('test-app-1')).rejects.toThrow(CoolifyApiError);
  });

  it('health-fail mode keeps the deploy job in success but reports the app as failed', async () => {
    // `health-fail` models the "Coolify deployed the container, but the
    // container itself fails its HEALTHCHECK after startup" scenario.
    // Step06 (CONTAINER_START) polls the deployment job and should see
    // `success`; step07 (HEALTH_CHECK) queries the app and should see
    // `failed`, raising `HEALTH_CHECK_FAILED` from the pipeline.
    const failClient = new CoolifyClient({
      baseUrl: COOLIFY_URL,
      token: 'test-token',
      mockMode: 'health-fail',
    });

    const status = await failClient.pollDeployment('deploy-x', 10_000);
    expect(status).toBe('success');

    const app = await failClient.getApp('app-x');
    expect(app.status).toBe('failed');
  });
});
