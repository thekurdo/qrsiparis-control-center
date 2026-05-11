/**
 * TenantWizardClient — orchestrates the 7-step onboarding flow (Phase H5).
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
 * Steps 5-7 (modules / server pick / final review) ship in worker H5b; this
 * file renders Steps 1-4 and shows a placeholder for the rest. The placeholder
 * is intentionally non-blocking: H5b will swap it for the real components
 * without touching this orchestrator.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { ProgressIndicator } from './ProgressIndicator';
import { Step1BasicInfo } from './Step1BasicInfo';
import { Step2Contract } from './Step2Contract';
import { Step3Domain } from './Step3Domain';
import { Step4Template } from './Step4Template';

// ---------------------------------------------------------------------------
// State shape — exported so future H5b components can import the union.
// ---------------------------------------------------------------------------

export type Tier = 'baslangic' | 'standart' | 'profesyonel';
export type Template =
  | 'classic'
  | 'singleflow'
  | 'visual'
  | 'quickorder'
  | 'minimal';
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
  // step5-7 (modules / server / review) added by H5b
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'wizard-new-tenant';
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StorageEnvelope {
  savedAt: number;
  data: WizardState;
}

// Server-passed shape for H5b's Step 6. Kept loose here because the
// orchestrator only forwards it.
export interface ServerWithCapacity {
  id: string;
  name: string;
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
  // `servers` is consumed by Step 6 (H5b worker). We surface its length in
  // the placeholder so an operator can sanity-check that the server list
  // came through, and the import isn't reported as unused.
  const serverCount = servers.length;
  const [state, setState] = useState<WizardState>({ step: 1 });
  const [hydrated, setHydrated] = useState(false);

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
      {state.step >= 5 && (
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-12 text-center">
          <p className="text-slate-300 font-medium">Adım {state.step} / 7</p>
          <p className="text-slate-400 text-sm mt-2">
            Bu adım H5b worker tarafından implement edilecek.
          </p>
          <p className="text-slate-500 text-xs mt-1">
            Aktif sunucu sayısı: {serverCount}
          </p>
          <button
            type="button"
            onClick={back}
            className="mt-6 px-4 py-2 text-slate-300 hover:text-white border border-slate-700 rounded text-sm"
          >
            ← Geri
          </button>
        </div>
      )}
    </div>
  );
}
