/**
 * Pipeline step barrel (Phase H6).
 *
 * `initialDeploySteps` is the canonical 10-step ordered array consumed by
 * `executeDeployment()` for `deployment_type = 'initial'`. Other deploy
 * types (config_update / app_update / redeploy / rollback) build their
 * own ordered subsets in V1.5 — see runner.ts for the dispatch switch.
 *
 * Order matches Doc 18 §4. DO NOT reorder without updating the doc.
 */

export { step01Precheck } from './step01-precheck';
export { step02ConfigGenerate } from './step02-config-generate';
export { step03CoolifyAppCreate } from './step03-coolify-app-create';
export { step04DockerImagePull } from './step04-docker-image-pull';
export { step05ConfigInject } from './step05-config-inject';
export { step06ContainerStart } from './step06-container-start';
export { step07HealthCheck } from './step07-health-check';
export { step08SslCertificate } from './step08-ssl-certificate';
export { step09DomainVerification } from './step09-domain-verification';
export { step10PostDeploy } from './step10-post-deploy';

import type { PipelineStep } from '../pipeline';
import { step01Precheck } from './step01-precheck';
import { step02ConfigGenerate } from './step02-config-generate';
import { step03CoolifyAppCreate } from './step03-coolify-app-create';
import { step04DockerImagePull } from './step04-docker-image-pull';
import { step05ConfigInject } from './step05-config-inject';
import { step06ContainerStart } from './step06-container-start';
import { step07HealthCheck } from './step07-health-check';
import { step08SslCertificate } from './step08-ssl-certificate';
import { step09DomainVerification } from './step09-domain-verification';
import { step10PostDeploy } from './step10-post-deploy';

export const initialDeploySteps: PipelineStep[] = [
  step01Precheck,
  step02ConfigGenerate,
  step03CoolifyAppCreate,
  step04DockerImagePull,
  step05ConfigInject,
  step06ContainerStart,
  step07HealthCheck,
  step08SslCertificate,
  step09DomainVerification,
  step10PostDeploy,
];
