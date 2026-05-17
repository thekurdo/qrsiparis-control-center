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
    method: 'GET' | 'POST' | 'DELETE',
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
