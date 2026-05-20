/**
 * TenantWizardClient — orchestrates the 7-step onboarding flow (Phase H5/H5b).
 *
 * State model:
 *   - `step` (1..7) selects the rendered child component.
 *   - Each step keeps its data under `state.stepN` so going back never loses
 *     entered values.
 *   - The full state blob is mirrored to localStorage under
 *     `wizard-new-tenant` with a 7-day TTL — long enough that an operator
 *     can resume after a crash/refresh, short enough that abandoned drafts
 *     don't pile up forever.
 *
 * Deploy flow (Step 7 → submit):
 *   1. POST /api/internal/tenants with the full wizard state → tenantId
 *   2. POST /api/internal/deployments with that tenantId + 'initial' type
 *      + explicit appVersion (latest qrsiparis-app tag) → deploymentId
 *   3. router.push(`/deployments/{deploymentId}`) so the operator can
 *      watch the pipeline live via SSE.
 *
 * Why we pass `appVersion` explicitly: the deployments POST otherwise
 * falls back to `process.env.APP_VERSION` (which is the CC's own version,
 * not the tenant-app's). With that default the worker would try to pull a
 * tag like `dev` and step04 would error. Bake the current customer-app
 * tag in here so the wizard always ships a deployable image reference;
 * the operator can still override this from the API in V1.5 once we
 * expose an "advanced" pane in Step 7.
 *
 * On any failure the wizard stays on Step 7 with an error banner and the
 * localStorage state intact so the operator can retry without re-typing.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { buildConfigSnapshot } from '@/lib/cc/build-tenant-config';

import { ProgressIndicator } from './ProgressIndicator';
import { Step1BasicInfo } from './Step1BasicInfo';
import { Step2Contract } from './Step2Contract';
import { Step3Domain } from './Step3Domain';
import { Step4Template } from './Step4Template';
import { Step5Modules, type Step5Data } from './Step5Modules';
import { Step6Server, type Step6Data } from './Step6Server';
import { Step7Review } from './Step7Review';

// ---------------------------------------------------------------------------
// State shape — exported so future H5b components can import the union.
// ---------------------------------------------------------------------------

export type Tier = 'baslangic' | 'standart' | 'profesyonel';
export type Template =
  | 'classic'
  | 'singleflow'
  | 'visual'
  | 'quickorder'
  | 'minimal'
  | 'sushi';
export type SalesPartner = 'yok' | 'proviat';

export interface Step1Data {
  restaurantName: string;
  shortCode: string;
  contactName: string;
  phone: string;
  email: string;
  city: string;
  address: string;
}

export interface Step2Data {
  tier: Tier;
  contractStartDate: string; // ISO yyyy-mm-dd
  durationMonths: 6 | 12 | 24;
  monthlyFeeKurus: number;
  salesPartner: SalesPartner;
  commissionRatePercent: number;
}

export interface Step3Data {
  domain: string;
  useSubdomain: boolean;
}

export interface Step4Data {
  template: Template;
  primaryColor: string;
  logoUrl?: string;
  font: string;
  customFontUrl?: string;
  customFontFamily?: string;
}

export interface WizardState {
  step: number;
  step1?: Step1Data;
  step2?: Step2Data;
  step3?: Step3Data;
  step4?: Step4Data;
  step5?: Step5Data;
  step6?: Step6Data;
  step7?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'wizard-new-tenant';
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Customer-app image tag the wizard ships with every new tenant. Bumped
 * each time a new qrsiparis-app release lands on ghcr.io and is verified
 * end-to-end against an existing tenant. Format must match step03's
 * `resolveImageRef` parser (short `qrsiparis-app:vX.Y.Z` form gets
 * rewritten to `ghcr.io/thekurdo/qrsiparis-app:vX.Y.Z`).
 */
const DEFAULT_APP_VERSION = 'qrsiparis-app:v0.1.13';

interface StorageEnvelope {
  savedAt: number;
  data: WizardState;
}

// Server-passed shape for Step 6's picker.
export interface ServerWithCapacity {
  id: string;
  name: string;
  publicIp: string;
  publicHostname: string | null;
  status: string;
  maxTenantsTheoretical: number;
  currentTenantCount: number;
  // ...other server columns are passed through but not consumed here.
  [key: string]: unknown;
}

export function TenantWizardClient({
  servers,
}: {
  servers: ServerWithCapacity[];
}) {
  const router = useRouter();
  const [state, setState] = useState<WizardState>({ step: 1 });
  const [hydrated, setHydrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // --- Hydrate from localStorage on first client render ---
  // We deliberately gate `hydrated` so the second effect (which writes back
  // to localStorage on every state change) doesn't clobber the saved blob
  // with the default `{ step: 1 }` before we've had a chance to read it.
  useEffect(() => {
    if (typeof window === 'undefined') {
      setHydrated(true);
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StorageEnvelope;
        if (
          parsed &&
          typeof parsed.savedAt === 'number' &&
          Date.now() - parsed.savedAt < STORAGE_TTL_MS &&
          parsed.data
        ) {
          setState(parsed.data);
        } else {
          // Expired draft — purge so a stale entry can't haunt us later.
          window.localStorage.removeItem(STORAGE_KEY);
        }
      }
    } catch {
      // Corrupted JSON: ignore and start fresh.
    }
    setHydrated(true);
  }, []);

  // --- Persist on every change (post-hydration) ---
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return;
    try {
      const envelope: StorageEnvelope = { savedAt: Date.now(), data: state };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // Quota exceeded or storage disabled — silently degrade. The wizard
      // still works, the operator just won't be able to resume after refresh.
    }
  }, [state, hydrated]);

  const next = useCallback(
    <K extends keyof WizardState>(stepKey: K, stepData: WizardState[K]) => {
      setState((prev) => ({
        ...prev,
        [stepKey]: stepData,
        step: prev.step + 1,
      }));
    },
    [],
  );

  const back = useCallback(() => {
    setState((prev) => ({ ...prev, step: Math.max(1, prev.step - 1) }));
  }, []);

  /**
   * Chain `POST /api/internal/tenants` → `POST /api/internal/deployments`
   * and navigate to the deploy-detail page.
   *
   * Both endpoints return the standard `{ success, data | error }` envelope.
   * On any error we surface the message and stay on Step 7.
   */
  const deploy = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      // Transform the step-bucketed wizard form-state into the canonical
      // `RestaurantConfig` shape the customer-app validates at boot. We ship
      // BOTH the raw wizard state (so the server can run its existing
      // per-field validation) AND the precomputed `configSnapshot` (which
      // the server persists verbatim to `tenants.config_snapshot`). Without
      // this transform the snapshot's top-level keys are `step1..step6` and
      // the customer container restart-loops on boot.
      let configSnapshot;
      try {
        configSnapshot = buildConfigSnapshot(state);
      } catch (err) {
        throw new Error(
          err instanceof Error
            ? `Konfigürasyon oluşturulamadı: ${err.message}`
            : 'Konfigürasyon oluşturulamadı',
        );
      }

      // Step 1: create the tenant row
      const tenantRes = await fetch('/api/internal/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state, configSnapshot }),
      });
      const tenantJson = (await tenantRes.json()) as
        | { success: true; data: { tenantId: string } }
        | { success: false; error: { message: string } };
      if (!tenantJson.success) {
        throw new Error(tenantJson.error.message);
      }
      const tenantId = tenantJson.data.tenantId;

      // Step 2: enqueue the initial deployment
      const deployRes = await fetch('/api/internal/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          deploymentType: 'initial',
          appVersion: DEFAULT_APP_VERSION,
          triggerReason: 'Wizard ilk kurulum',
        }),
      });
      const deployJson = (await deployRes.json()) as
        | { success: true; data: { deploymentId: string } }
        | { success: false; error: { message: string } };
      if (!deployJson.success) {
        throw new Error(deployJson.error.message);
      }
      const deploymentId = deployJson.data.deploymentId;

      // Clear the wizard draft now that we've handed off to the runner.
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }

      router.push(`/deployments/${deploymentId}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Bilinmeyen hata');
      setSubmitting(false);
    }
  }, [router, state, submitting]);

  const tier = state.step2?.tier ?? 'baslangic';

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-100">
          Yeni Müşteri Onboarding
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          7 adımda yeni restoran kurulumu
        </p>
        <div className="mt-4">
          <ProgressIndicator currentStep={state.step} totalSteps={7} />
        </div>
      </header>

      {state.step === 1 && (
        <Step1BasicInfo
          data={state.step1}
          onNext={(d) => next('step1', d)}
        />
      )}
      {state.step === 2 && (
        <Step2Contract
          data={state.step2}
          onNext={(d) => next('step2', d)}
          onBack={back}
        />
      )}
      {state.step === 3 && (
        <Step3Domain
          data={state.step3}
          shortCode={state.step1?.shortCode}
          locale={state.step5?.locale?.default}
          onNext={(d) => next('step3', d)}
          onBack={back}
        />
      )}
      {state.step === 4 && (
        <Step4Template
          data={state.step4}
          onNext={(d) => next('step4', d)}
          onBack={back}
        />
      )}
      {state.step === 5 && (
        <Step5Modules
          data={state.step5}
          tier={tier}
          onNext={(d) => next('step5', d)}
          onBack={back}
        />
      )}
      {state.step === 6 && (
        <Step6Server
          data={state.step6}
          servers={servers}
          onNext={(d) => next('step6', d)}
          onBack={back}
        />
      )}
      {state.step === 7 && (
        <Step7Review
          state={state}
          onBack={back}
          onDeploy={deploy}
          submitting={submitting}
          error={submitError}
        />
      )}
    </div>
  );
}
