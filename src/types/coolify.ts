/**
 * Coolify API types — shared between the production HTTP client
 * (`src/lib/coolify/client.ts`) and the WireMock stub mappings under
 * `docker/wiremock/mappings/`.
 *
 * Naming follows Coolify's REST surface (v1). Anything that may be persisted
 * to our `deployments` table or rendered in the UI is exported.
 */

export interface CoolifyCreateAppInput {
  /** Stable short slug shown to operators; used as the human-readable app name. */
  name: string;
  /** Full domain (no scheme) the container will be served at. */
  domain: string;
  /** Coolify server UUID to deploy onto. */
  serverUuid: string;
  /** Docker image reference (e.g. `qrsiparis-app:v1.5.0`). */
  dockerImage: string;
  /** Environment variables injected into the container at start. */
  envVars: Record<string, string>;
}

export interface CoolifyApp {
  uuid: string;
  name: string;
  domain: string;
  status: 'created' | 'running' | 'stopped' | 'failed';
}

export type CoolifyDeploymentStatus =
  | 'queued'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface CoolifyDeployment {
  uuid: string;
  applicationUuid: string;
  status: CoolifyDeploymentStatus;
  createdAt: string;
  finishedAt?: string;
  errorMessage?: string;
}

export interface CoolifyDeployResponse {
  deployment_uuid: string;
}

/** Mock mode hint sent via `X-Mock-Mode` header so WireMock can route. */
export type CoolifyMockMode =
  | 'happy'
  | 'deploy-fail'
  | 'health-fail'
  | 'timeout';

export class CoolifyApiError extends Error {
  constructor(
    public statusCode: number,
    public coolifyCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoolifyApiError';
  }
}
