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

/**
 * Input for the real Coolify v4 `POST /api/v1/applications/dockercompose`
 * endpoint. Body fields match what live Coolify expects.
 *
 * Discovered empirically against panel.gewdai.com (May 2026):
 *   - `docker_compose_raw` MUST be base64-encoded YAML
 *   - `project_uuid` + `server_uuid` come from `GET /api/v1/projects`
 *     and `GET /api/v1/servers` respectively
 *   - `environment_name` defaults to "production"
 *   - `instant_deploy: true` kicks off the build immediately
 */
export interface CoolifyDockerComposeAppInput {
  name: string;
  projectUuid: string;
  serverUuid: string;
  environmentName?: string;
  /** Raw YAML (will be base64-encoded inside the client). */
  composeYaml: string;
  /** Optional FQDN like "https://demo.gewdai.com". */
  domains?: string;
  description?: string;
  instantDeploy?: boolean;
}

export interface CoolifyDockerComposeAppResult {
  uuid: string;
  domains: string | string[] | null;
}

/**
 * Input for the real Coolify v4 `POST /api/v1/applications/dockerimage`
 * endpoint — used for V1 tenant deploys. We picked this over
 * `/applications/dockercompose` because the compose endpoint in Coolify
 * 4.0.0 returns a UUID but never persists the app; dockerimage persists
 * correctly and reaches `running:*` on instant_deploy.
 */
export interface CoolifyDockerImageAppInput {
  name: string;
  projectUuid: string;
  serverUuid: string;
  environmentName?: string;
  /** Docker registry image (e.g. `nginx`). */
  imageName: string;
  /** Image tag (e.g. `alpine`, `v1.5.0`). */
  imageTag: string;
  /** Container ports to expose (e.g. `"80"`). */
  portsExposes: string;
  /** FQDN like `https://demo.gewdai.com`. */
  domains?: string;
  description?: string;
  instantDeploy?: boolean;
}

export interface CoolifyDockerImageAppResult {
  uuid: string;
  domains: string | string[] | null;
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
