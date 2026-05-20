/**
 * Pipeline step barrel (Phase H6).
 *
 * `initialDeploySteps` is the canonical 10-step ordered array consumed by
 * `executeDeployment()` for `deployment_type = 'initial'`. Other deploy
 * types (config_update / app_update / redeploy / rollback / delete) build
 * their own ordered subsets — see runner.ts for the dispatch switch.
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
export { stepRedeployTrigger } from './step-redeploy-trigger';
export { stepRollbackResolve } from './step-rollback-resolve';
export { stepRollbackCoolifyPatch } from './step-rollback-coolify-patch';
export { stepHistorySnapshot } from './step-history-snapshot';
export { stepDeleteFinalBackup } from './step-delete-final-backup';
export { stepDeleteCoolifyApp } from './step-delete-coolify-app';
export { stepDeleteTenantMark } from './step-delete-tenant-mark';

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
import { stepRedeployTrigger } from './step-redeploy-trigger';
import { stepRollbackResolve } from './step-rollback-resolve';
import { stepRollbackCoolifyPatch } from './step-rollback-coolify-patch';
import { stepHistorySnapshot } from './step-history-snapshot';
import { stepDeleteFinalBackup } from './step-delete-final-backup';
import { stepDeleteCoolifyApp } from './step-delete-coolify-app';
import { stepDeleteTenantMark } from './step-delete-tenant-mark';

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
  stepHistorySnapshot,
];

/** redeploy = same image + same config, just restart container. */
export const redeploySteps: PipelineStep[] = [
  step01Precheck,
  stepRedeployTrigger,
  step06ContainerStart,
  step07HealthCheck,
  stepHistorySnapshot,
];

/** app_update = new image version. Pull, redeploy, healthcheck. */
export const appUpdateSteps: PipelineStep[] = [
  step01Precheck,
  step04DockerImagePull,
  stepRedeployTrigger,
  step06ContainerStart,
  step07HealthCheck,
  stepHistorySnapshot,
];

/** config_update = regenerate + inject config, then restart. */
export const configUpdateSteps: PipelineStep[] = [
  step01Precheck,
  step02ConfigGenerate,
  step05ConfigInject,
  stepRedeployTrigger,
  step06ContainerStart,
  step07HealthCheck,
  stepHistorySnapshot,
];

/**
 * rollback = restore the previous successful deployment's image + config
 * from `deployment_history`. Falls back to image-only restore when no
 * history row exists for the tenant (legacy tenants pre-history table).
 */
export const rollbackSteps: PipelineStep[] = [
  step01Precheck,
  stepRollbackResolve,
  stepRollbackCoolifyPatch,
  step05ConfigInject,
  stepRedeployTrigger,
  step06ContainerStart,
  step07HealthCheck,
  stepHistorySnapshot,
];

/**
 * delete = tear down tenant entirely. Last-minute backup → Coolify app
 * DELETE (drops container + volume + Traefik routes) → mark tenant
 * status='cancelled' (row preserved for audit + history).
 */
export const deleteSteps: PipelineStep[] = [
  step01Precheck,
  stepDeleteFinalBackup,
  stepDeleteCoolifyApp,
  stepDeleteTenantMark,
];
