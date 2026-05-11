/**
 * Step2Contract — tier selection, contract dates, and sales-partner config
 * (Phase H5).
 *
 * Tier picker auto-fills the monthly amount from the canonical price list
 * (kept in sync with the commercial pricing sheet). Operators may still
 * override the amount per-deal — useful for promo discounts.
 *
 * Sales-partner branch:
 *   - 'yok'      → direct sale; commission rate locked at 0
 *   - 'proviat'  → V1's only partner; default rate = 30 (R&D split)
 *
 * The wizard's own `salesPartner: 'yok'` will be translated to NULL by the
 * H6 API handler before it reaches the DB (where the column is nullable).
 *
 * Validation guarantees:
 *   - tier ∈ {baslangic, standart, profesyonel}
 *   - duration ∈ {6, 12, 24} months
 *   - monthlyAmount > 0 (TL, kept in *kuruş* in state to avoid float drift)
 *   - commission rate in [0, 100]
 *   - contractStartDate is a valid yyyy-mm-dd
 */
'use client';

import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { z } from 'zod';

import type { SalesPartner, Step2Data, Tier } from './TenantWizardClient';

// Canonical pricing — figures are in *kuruş* to keep arithmetic integral.
// Contract: keep in sync with the commercial price sheet (see docs/H5).
const TIERS: Record<
  Tier,
  {
    label: string;
    desc: string;
    setupKurus: number;
    monthlyKurus: number;
  }
> = {
  baslangic: {
    label: 'Başlangıç',
    desc: '1-15 masa, 1 mutfak istasyonu, 2 dil',
    setupKurus: 1_500_000,
    monthlyKurus: 80_000,
  },
  standart: {
    label: 'Standart',
    desc: '16-40 masa, çoklu istasyon, 3 dil',
    setupKurus: 2_200_000,
    monthlyKurus: 120_000,
  },
  profesyonel: {
    label: 'Profesyonel',
    desc: '41-80 masa, garson modülü, 4+ dil',
    setupKurus: 3_500_000,
    monthlyKurus: 180_000,
  },
};

const DURATION_OPTIONS = [6, 12, 24] as const;
type DurationMonths = (typeof DURATION_OPTIONS)[number];

const schema = z.object({
  tier: z.enum(['baslangic', 'standart', 'profesyonel']),
  contractStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih formatı: YYYY-MM-DD'),
  durationMonths: z.union([
    z.literal(6),
    z.literal(12),
    z.literal(24),
  ]),
  monthlyFeeKurus: z
    .number()
    .int('Tam sayı olmalı')
    .positive('Sıfırdan büyük olmalı'),
  salesPartner: z.enum(['yok', 'proviat']),
  commissionRatePercent: z
    .number()
    .int('Tam sayı olmalı')
    .min(0, 'En az 0 olmalı')
    .max(100, 'En fazla 100 olabilir'),
});

function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function defaultState(): Step2Data {
  return {
    tier: 'baslangic',
    contractStartDate: todayIso(),
    durationMonths: 12,
    monthlyFeeKurus: TIERS.baslangic.monthlyKurus,
    salesPartner: 'yok',
    commissionRatePercent: 0,
  };
}

export function Step2Contract({
  data,
  onNext,
  onBack,
}: {
  data?: Step2Data;
  onNext: (d: Step2Data) => void;
  onBack: () => void;
}) {
  const [form, setForm] = useState<Step2Data>(data ?? defaultState());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feeTouched, setFeeTouched] = useState<boolean>(!!data);

  // When the user picks a new tier, auto-fill the monthly amount — but only
  // if they haven't manually edited it yet (otherwise we'd undo their work).
  useEffect(() => {
    if (feeTouched) return;
    setForm((prev) => ({
      ...prev,
      monthlyFeeKurus: TIERS[prev.tier].monthlyKurus,
    }));
  }, [form.tier, feeTouched]);

  // Convert kuruş → TL for the input; we round-trip through Number to keep
  // the displayed value clean (e.g. 80000 → 800).
  const monthlyTl = (form.monthlyFeeKurus / 100).toFixed(2);

  function handleSalesPartnerChange(value: SalesPartner) {
    setForm((prev) => ({
      ...prev,
      salesPartner: value,
      // 'yok' forces commission to 0; 'proviat' defaults to 30.
      commissionRatePercent:
        value === 'yok' ? 0 : prev.commissionRatePercent || 30,
    }));
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = schema.safeParse(form);
    if (!result.success) {
      const errs: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && !errs[key]) {
          errs[key] = issue.message;
        }
      }
      setErrors(errs);
      return;
    }
    setErrors({});
    onNext(result.data);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-6"
      noValidate
    >
      <header>
        <h2 className="text-lg font-semibold text-slate-100">Anlaşma Detayı</h2>
        <p className="text-xs text-slate-400 mt-1">
          Tier, sözleşme süresi ve satış partneri.
        </p>
      </header>

      {/* Tier picker */}
      <fieldset>
        <legend className="block text-sm text-slate-300 mb-2">
          Tier <span className="text-red-400">*</span>
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(Object.keys(TIERS) as Tier[]).map((tierKey) => {
            const t = TIERS[tierKey];
            const active = form.tier === tierKey;
            return (
              <label
                key={tierKey}
                className={`block cursor-pointer rounded-lg border p-4 transition-colors ${
                  active
                    ? 'border-blue-500 bg-blue-950/40'
                    : 'border-slate-700 bg-slate-900 hover:border-slate-600'
                }`}
              >
                <input
                  type="radio"
                  name="tier"
                  value={tierKey}
                  checked={active}
                  onChange={() =>
                    setForm((prev) => ({ ...prev, tier: tierKey }))
                  }
                  className="sr-only"
                />
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-slate-100">
                    {t.label}
                  </span>
                  <span className="text-xs text-slate-400">
                    {(t.monthlyKurus / 100).toLocaleString('tr-TR')} TL/ay
                  </span>
                </div>
                <p className="text-xs text-slate-400">{t.desc}</p>
                <p className="text-[11px] text-slate-500 mt-2">
                  Kurulum: {(t.setupKurus / 100).toLocaleString('tr-TR')} TL
                </p>
              </label>
            );
          })}
        </div>
        {errors['tier'] && (
          <p className="text-xs text-red-400 mt-1">{errors['tier']}</p>
        )}
      </fieldset>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Contract start date */}
        <div>
          <label
            htmlFor="contractStartDate"
            className="block text-sm text-slate-300 mb-1"
          >
            Sözleşme Başlangıç Tarihi <span className="text-red-400">*</span>
          </label>
          <input
            id="contractStartDate"
            type="date"
            value={form.contractStartDate}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                contractStartDate: e.target.value,
              }))
            }
            className={`w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border focus:outline-none ${
              errors['contractStartDate']
                ? 'border-red-500'
                : 'border-slate-700 focus:border-blue-500'
            }`}
          />
          {errors['contractStartDate'] && (
            <p className="text-xs text-red-400 mt-1">
              {errors['contractStartDate']}
            </p>
          )}
        </div>

        {/* Duration radio */}
        <div>
          <span className="block text-sm text-slate-300 mb-1">
            Süre <span className="text-red-400">*</span>
          </span>
          <div className="flex gap-2">
            {DURATION_OPTIONS.map((months) => {
              const active = form.durationMonths === months;
              return (
                <label
                  key={months}
                  className={`flex-1 text-center cursor-pointer rounded border p-2 text-sm ${
                    active
                      ? 'border-blue-500 bg-blue-950/40 text-slate-100'
                      : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="durationMonths"
                    value={months}
                    checked={active}
                    onChange={() =>
                      setForm((prev) => ({
                        ...prev,
                        durationMonths: months as DurationMonths,
                      }))
                    }
                    className="sr-only"
                  />
                  {months} ay
                </label>
              );
            })}
          </div>
          {errors['durationMonths'] && (
            <p className="text-xs text-red-400 mt-1">
              {errors['durationMonths']}
            </p>
          )}
        </div>
      </div>

      {/* Monthly amount (in TL, stored as kuruş) */}
      <div>
        <label
          htmlFor="monthlyFee"
          className="block text-sm text-slate-300 mb-1"
        >
          Aylık Ücret (TL) <span className="text-red-400">*</span>
        </label>
        <input
          id="monthlyFee"
          type="number"
          step="0.01"
          min="0"
          value={monthlyTl}
          onChange={(e) => {
            setFeeTouched(true);
            const tl = Number(e.target.value);
            const kurus = Math.round(tl * 100);
            setForm((prev) => ({ ...prev, monthlyFeeKurus: kurus }));
          }}
          className={`w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border focus:outline-none ${
            errors['monthlyFeeKurus']
              ? 'border-red-500'
              : 'border-slate-700 focus:border-blue-500'
          }`}
        />
        <p className="text-xs text-slate-500 mt-1">
          Tier seçimine göre otomatik dolar; gerekirse düzenleyin.
        </p>
        {errors['monthlyFeeKurus'] && (
          <p className="text-xs text-red-400 mt-1">
            {errors['monthlyFeeKurus']}
          </p>
        )}
      </div>

      {/* Sales partner */}
      <fieldset>
        <legend className="block text-sm text-slate-300 mb-2">
          Satış Partneri
        </legend>
        <div className="grid grid-cols-2 gap-3">
          <PartnerOption
            active={form.salesPartner === 'yok'}
            onClick={() => handleSalesPartnerChange('yok')}
            label="Yok (Doğrudan)"
            sub="Komisyon yok"
          />
          <PartnerOption
            active={form.salesPartner === 'proviat'}
            onClick={() => handleSalesPartnerChange('proviat')}
            label="Proviat"
            sub="Varsayılan komisyon: %30"
          />
        </div>
      </fieldset>

      {/* Commission rate (only when partner != 'yok') */}
      {form.salesPartner !== 'yok' && (
        <div>
          <label
            htmlFor="commissionRate"
            className="block text-sm text-slate-300 mb-1"
          >
            Komisyon Oranı (%) <span className="text-red-400">*</span>
          </label>
          <input
            id="commissionRate"
            type="number"
            min="0"
            max="100"
            step="1"
            value={form.commissionRatePercent}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                commissionRatePercent: Number(e.target.value),
              }))
            }
            className={`w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border focus:outline-none ${
              errors['commissionRatePercent']
                ? 'border-red-500'
                : 'border-slate-700 focus:border-blue-500'
            }`}
          />
          {errors['commissionRatePercent'] && (
            <p className="text-xs text-red-400 mt-1">
              {errors['commissionRatePercent']}
            </p>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-slate-300 hover:text-white border border-slate-700 rounded text-sm"
        >
          ← Geri
        </button>
        <button
          type="submit"
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white font-medium"
        >
          İleri →
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Inline radio-card for the partner selector.
// ---------------------------------------------------------------------------

function PartnerOption({
  active,
  onClick,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-left rounded-lg border p-3 transition-colors ${
        active
          ? 'border-blue-500 bg-blue-950/40'
          : 'border-slate-700 bg-slate-900 hover:border-slate-600'
      }`}
    >
      <div className="font-semibold text-slate-100 text-sm">{label}</div>
      <div className="text-xs text-slate-400 mt-0.5">{sub}</div>
    </button>
  );
}
