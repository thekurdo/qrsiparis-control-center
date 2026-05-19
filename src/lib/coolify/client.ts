/**
 * Typed HTTP client for the Coolify v1 REST API.
 *
 * In dev + E2E tests the `baseUrl` points to a WireMock instance
 * (`docker/wiremock/`); in prod it points to a real Coolify server (one per
 * Hostinger VPS we have registered in `servers`).
 *
 * The `mockMode` field is an escape hatch used by tests to drive the WireMock
 * scenarios into specific failure paths (`deploy-fail`, `health-fail`, etc.).
 * It is forwarded as the `X-Mock-Mode` header and a real Coolify ignores it.
 */

import {
  CoolifyApiError,
  type CoolifyApp,
  type CoolifyCreateAppInput,
  type CoolifyDeployment,
  type CoolifyDeploymentStatus,
  type CoolifyDeployResponse,
  type CoolifyDockerComposeAppInput,
  type CoolifyDockerComposeAppResult,
  type CoolifyDockerImageAppInput,
  type CoolifyDockerImageAppResult,
  type CoolifyMockMode,
} from '@/types/coolify';

export interface CoolifyClientConfig {
  baseUrl: string;
  token: string;
  mockMode?: CoolifyMockMode;
  /** Optional fetch override for unit tests that need finer control. */
  fetchImpl?: typeof fetch;
}

export class CoolifyClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: CoolifyClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.token}`,
      'Content-Type': 'application/json',
    };
    if (this.cfg.mockMode) {
      headers['X-Mock-Mode'] = this.cfg.mockMode;
    }

    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore body-read errors */
      }
      throw new CoolifyApiError(
        res.status,
        `COOLIFY_HTTP_${res.status}`,
        `${method} ${path} → ${res.status}: ${detail.slice(0, 200)}`,
      );
    }

    // 204 No Content — Coolify uses this for stop/restart/delete success.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  createApp(input: CoolifyCreateAppInput): Promise<CoolifyApp> {
    return this.request<CoolifyApp>('POST', '/api/v1/applications', input);
  }

  /**
   * Real Coolify v4 docker-compose application creation. This is the path
   * production tenant deployments take (each tenant = a Docker Compose stack
   * on the shared VPS).
   *
   * Unlike the legacy `createApp` which targets WireMock E2E mocks at
   * `/applications`, this hits `/applications/dockercompose` which is the
   * actual typed endpoint exposed by Coolify v4.
   *
   * Returns the new application's UUID; subsequent deploy + status lookup
   * use that UUID via `deploy(uuid)` and `getApp(uuid)`.
   */
  async createDockerComposeApp(
    input: CoolifyDockerComposeAppInput,
  ): Promise<CoolifyDockerComposeAppResult> {
    // Coolify validates and rejects raw YAML — it must be base64-encoded.
    const composeB64 = Buffer.from(input.composeYaml, 'utf-8').toString('base64');

    const body: Record<string, unknown> = {
      name: input.name,
      project_uuid: input.projectUuid,
      server_uuid: input.serverUuid,
      environment_name: input.environmentName ?? 'production',
      docker_compose_raw: composeB64,
      instant_deploy: input.instantDeploy ?? false,
    };
    if (input.domains) body['domains'] = input.domains;
    if (input.description) body['description'] = input.description;

    return this.request<CoolifyDockerComposeAppResult>(
      'POST',
      '/api/v1/applications/dockercompose',
      body,
    );
  }

  /**
   * Create a Docker image application — Coolify v4 typed endpoint.
   *
   * We use this instead of `dockercompose` because the dockercompose
   * endpoint in Coolify 4.0.0 returns a UUID but does NOT persist the
   * application (GET/DELETE both 404). The dockerimage endpoint persists
   * the app correctly and starts the container reachable via Traefik.
   */
  async createDockerImageApp(
    input: CoolifyDockerImageAppInput,
  ): Promise<CoolifyDockerImageAppResult> {
    const body: Record<string, unknown> = {
      name: input.name,
      project_uuid: input.projectUuid,
      server_uuid: input.serverUuid,
      environment_name: input.environmentName ?? 'production',
      docker_registry_image_name: input.imageName,
      docker_registry_image_tag: input.imageTag,
      ports_exposes: input.portsExposes,
      instant_deploy: input.instantDeploy ?? true,
    };
    if (input.domains) body['domains'] = input.domains;
    if (input.description) body['description'] = input.description;

    return this.request<CoolifyDockerImageAppResult>(
      'POST',
      '/api/v1/applications/dockerimage',
      body,
    );
  }

  /**
   * Trigger a deployment for an existing Coolify application.
   * Hits the v4 `/api/v1/deploy?uuid=...` endpoint.
   */
  triggerDeploy(applicationUuid: string, force = false): Promise<CoolifyDeployResponse> {
    const params = new URLSearchParams({ uuid: applicationUuid });
    if (force) params.set('force', 'true');
    return this.request<CoolifyDeployResponse>(
      'POST',
      `/api/v1/deploy?${params.toString()}`,
    );
  }

  deployApp(uuid: string): Promise<CoolifyDeployResponse> {
    return this.request<CoolifyDeployResponse>(
      'POST',
      `/api/v1/applications/${encodeURIComponent(uuid)}/deploy`,
    );
  }

  getDeployment(uuid: string): Promise<CoolifyDeployment> {
    return this.request<CoolifyDeployment>(
      'GET',
      `/api/v1/deployments/${encodeURIComponent(uuid)}`,
    );
  }

  getApp(uuid: string): Promise<CoolifyApp> {
    return this.request<CoolifyApp>(
      'GET',
      `/api/v1/applications/${encodeURIComponent(uuid)}`,
    );
  }

  /**
   * List all applications. Used by the redeploy/app_update pipelines to
   * recover a tenant's Coolify UUID from the app name (`rest-{shortCode}`)
   * when the in-memory ctx doesn't have it yet.
   */
  listApps(): Promise<CoolifyApp[]> {
    return this.request<CoolifyApp[]>('GET', '/api/v1/applications');
  }

  stopApp(uuid: string): Promise<void> {
    return this.request<void>(
      'POST',
      `/api/v1/applications/${encodeURIComponent(uuid)}/stop`,
    );
  }

  restartApp(uuid: string): Promise<void> {
    return this.request<void>(
      'POST',
      `/api/v1/applications/${encodeURIComponent(uuid)}/restart`,
    );
  }

  deleteApp(uuid: string): Promise<void> {
    return this.request<void>(
      'DELETE',
      `/api/v1/applications/${encodeURIComponent(uuid)}`,
    );
  }

  /**
   * Attach a persistent storage volume to a Coolify application — Coolify v4
   * `POST /api/v1/applications/{uuid}/storages`. Used by the deploy pipeline
   * to bake a `/data` volume into every tenant app right after create, so
   * the customer-product's `restaurant.config.json` survives container restarts.
   *
   * Coolify 4.0.0 only accepts `type=persistent` or `type=file` for directory
   * mounts — other values are rejected at validation time (verified empirically
   * against panel.gewdai.com).
   */
  addPersistentStorage(
    applicationUuid: string,
    body: { name: string; mount_path: string },
  ): Promise<{ uuid: string; name: string }> {
    return this.request<{ uuid: string; name: string }>(
      'POST',
      `/api/v1/applications/${encodeURIComponent(applicationUuid)}/storages`,
      { name: body.name, type: 'persistent', mount_path: body.mount_path },
    );
  }

  /**
   * Patch an application's configuration in place — Coolify v4
   * `PATCH /api/v1/applications/{uuid}`. The pipeline uses this immediately
   * after `createDockerImageApp` to override the healthcheck Coolify infers
   * from the baked image HEALTHCHECK (the image declares port 3000 but
   * Coolify rebinds the container to PORT=80, so the inferred check fails).
   *
   * Body is forwarded verbatim — Coolify accepts a partial app body and only
   * merges the fields supplied. Callers typically pass `health_check_*`
   * keys; full schema lives in the Coolify v4 OpenAPI doc.
   */
  updateAppConfig(uuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(
      'PATCH',
      `/api/v1/applications/${encodeURIComponent(uuid)}`,
      body,
    );
  }

  /**
   * Poll the deployment status until it reaches a terminal state or the
   * caller-provided timeout expires. Polls every 500ms in tests (poll happens
   * fast against WireMock); production callers typically pass 90_000ms.
   */
  async pollDeployment(
    uuid: string,
    timeoutMs: number,
    pollIntervalMs = 500,
  ): Promise<CoolifyDeploymentStatus> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const d = await this.getDeployment(uuid);
      if (
        d.status === 'success' ||
        d.status === 'failed' ||
        d.status === 'cancelled'
      ) {
        return d.status;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new CoolifyApiError(
      408,
      'COOLIFY_POLL_TIMEOUT',
      `Deployment ${uuid} did not reach a terminal state in ${timeoutMs}ms`,
    );
  }
}
