/**
 * Step3Domain — pick domain strategy (own vs. provided subdomain) and preview
 * the four ops URLs the tenant will use post-launch (Phase H5).
 *
 * Two paths:
 *   1. Müşterinin kendi domain'i (default) — operator types e.g.
 *      `siparis.acmepide.com`. We validate as a basic hostname pattern.
 *   2. Bizden alt-domain — auto-fills `<shortCode>.qrsiparis.app`. The
 *      shortCode is read-only here; if the operator wants to change it
 *      they go back to Step 1.
 *
 * Preview block is informational: shows `/yonetim`, `/kasa`, `/mutfak`,
 * `/garson` so the operator can sanity-check the domain choice before
 * moving on.
 */
'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { z } from 'zod';

import type { Step3Data } from './TenantWizardClient';

const SUBDOMAIN_BASE = 'qrsiparis.app';

// Hostname validation — single-label minimum, accepts dotted labels with
// hyphens, max 253 chars. Doesn't enforce TLD presence (operators sometimes
// stage with `.test` etc.) but mandates at least two labels for non-subdomain
// mode.
const hostnameRegex =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const schema = z.object({
  domain: z
    .string()
    .min(3, 'Domain çok kısa')
    .max(253, 'Domain çok uzun')
    .regex(hostnameRegex, 'Geçerli bir domain giriniz (örn: ornek.com)'),
  useSubdomain: z.boolean(),
});

const PREVIEW_PATHS: Array<{ path: string; label: string }> = [
  { path: '/yonetim', label: 'Yönetim' },
  { path: '/kasa', label: 'Kasa' },
  { path: '/mutfak', label: 'Mutfak' },
  { path: '/garson', label: 'Garson' },
];

export function Step3Domain({
  data,
  shortCode,
  onNext,
  onBack,
}: {
  data?: Step3Data;
  shortCode: string | undefined;
  onNext: (d: Step3Data) => void;
  onBack: () => void;
}) {
  const subdomain = shortCode ? `${shortCode}.${SUBDOMAIN_BASE}` : '';

  const [form, setForm] = useState<Step3Data>(
    data ?? {
      domain: '',
      useSubdomain: false,
    },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  // When subdomain mode is on, sync the displayed domain to the computed
  // value so the preview block stays correct. Switching back to "own" mode
  // clears the field unless the operator already has an explicit value.
  useEffect(() => {
    if (form.useSubdomain && subdomain && form.domain !== subdomain) {
      setForm((prev) => ({ ...prev, domain: subdomain }));
    }
  }, [form.useSubdomain, form.domain, subdomain]);

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

  // The preview block uses whatever domain is currently in the form, falling
  // back to a placeholder so the layout doesn't jump while the operator types.
  const previewHost = form.domain || 'restoran.com';

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-6"
      noValidate
    >
      <header>
        <h2 className="text-lg font-semibold text-slate-100">Domain</h2>
        <p className="text-xs text-slate-400 mt-1">
          Restoranın URL&apos;si — kendi domain&apos;i olabilir veya bizden
          alt-domain alabilir.
        </p>
      </header>

      {/* Mode picker */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ModeOption
          active={!form.useSubdomain}
          onClick={() =>
            setForm((prev) => ({ ...prev, useSubdomain: false, domain: '' }))
          }
          title="Müşterinin Kendi Domain'i"
          desc="Restoranın sahibi olduğu özel bir domain (örn. siparis.acmepide.com)."
        />
        <ModeOption
          active={form.useSubdomain}
          onClick={() =>
            setForm((prev) => ({
              ...prev,
              useSubdomain: true,
              domain: subdomain,
            }))
          }
          title={`Bizden Alt-Domain Al (${SUBDOMAIN_BASE})`}
          desc="Restoran kendi domain'ine sahip değilse hızlı kurulum için bizden bir alt-domain veriyoruz."
          disabled={!shortCode}
        />
      </div>
      {!shortCode && (
        <p className="text-xs text-amber-400">
          Kısa kod (Step 1) belirlenmeden alt-domain seçilemez.
        </p>
      )}

      {/* Domain field */}
      <div>
        <label htmlFor="domain" className="block text-sm text-slate-300 mb-1">
          Domain <span className="text-red-400">*</span>
        </label>
        <input
          id="domain"
          type="text"
          value={form.domain}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, domain: e.target.value.trim() }))
          }
          readOnly={form.useSubdomain}
          placeholder={form.useSubdomain ? subdomain : 'siparis.acmepide.com'}
          className={`w-full bg-slate-900 text-slate-100 rounded p-2 text-sm font-mono border focus:outline-none ${
            errors['domain']
              ? 'border-red-500'
              : 'border-slate-700 focus:border-blue-500'
          } ${form.useSubdomain ? 'opacity-70 cursor-not-allowed' : ''}`}
        />
        {form.useSubdomain && (
          <p className="text-xs text-slate-500 mt-1">
            Otomatik olarak{' '}
            <span className="font-mono text-slate-300">{subdomain}</span> olarak
            atandı.
          </p>
        )}
        {errors['domain'] && (
          <p className="text-xs text-red-400 mt-1">{errors['domain']}</p>
        )}
      </div>

      {/* URL preview */}
      <div className="bg-slate-900/60 border border-slate-700 rounded p-4">
        <h3 className="text-sm font-semibold text-slate-200 mb-2">
          Önizleme
        </h3>
        <ul className="space-y-1 text-xs">
          {PREVIEW_PATHS.map(({ path, label }) => (
            <li key={path} className="flex items-center gap-2">
              <span className="text-slate-400 w-16">{label}</span>
              <span className="font-mono text-slate-200">
                https://{previewHost}
                <span className="text-blue-400">{path}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

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
// Mode-picker card (own domain vs. subdomain).
// ---------------------------------------------------------------------------

function ModeOption({
  active,
  onClick,
  title,
  desc,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`text-left rounded-lg border p-4 transition-colors ${
        active
          ? 'border-blue-500 bg-blue-950/40'
          : 'border-slate-700 bg-slate-900 hover:border-slate-600'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div className="font-semibold text-slate-100 text-sm">{title}</div>
      <div className="text-xs text-slate-400 mt-1">{desc}</div>
    </button>
  );
}
