/**
 * Step3Domain — pick domain strategy (own vs. provided subdomain) and preview
 * the four ops URLs the tenant will use post-launch (Phase H5).
 *
 * Two paths:
 *   1. Bizden Alt-Domain Al (DEFAULT) — auto-fills `<shortCode>.<baseDomain>`
 *      on first pick. Field stays editable so the operator can tweak it
 *      (e.g. for staging hostnames) without going back to Step 1.
 *   2. Müşterinin kendi domain'i — operator types e.g.
 *      `siparis.acmepide.com`. Validated as a basic hostname pattern.
 *
 * Base domain comes from `NEXT_PUBLIC_BASE_DOMAIN` (set in CC's Coolify env,
 * `siparisqr.com.tr` in prod). NOTE: this is a NEXT_PUBLIC_* var, so it is
 * inlined at BUILD time — the Dockerfile must pass it as a build arg for the
 * env override to take effect. The fallback below is the prod default so a
 * missing build arg still produces a correct build.
 *
 * Editability rule:
 *   `domainManuallyEdited` flag — flipped true the moment the operator types
 *   in the field. Mode toggles only auto-overwrite the value when it still
 *   matches a previous auto-fill pattern, never after manual edits.
 *
 * Preview block: builds live URLs from `state.domain` and (when available)
 *   the locale picked in Step 5. Routes are `/<locale>/<role>` to mirror
 *   the customer-app's `[locale]` segment layout.
 */
'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import type { Step3Data } from './TenantWizardClient';

// Base domain for the bizden-alt-domain mode. Override per environment via
// NEXT_PUBLIC_BASE_DOMAIN; default keeps local dev sane.
const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN ?? 'siparisqr.com.tr';

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
    .regex(
      hostnameRegex,
      'Geçersiz domain formatı — geçerli bir domain giriniz (örn: ornek.com)',
    ),
  useSubdomain: z.boolean(),
});

const PREVIEW_PATHS: Array<{ path: string; label: string }> = [
  { path: 'yonetim', label: 'Yönetim' },
  { path: 'kasa', label: 'Kasa' },
  { path: 'mutfak', label: 'Mutfak' },
  { path: 'garson', label: 'Garson' },
];

export function Step3Domain({
  data,
  shortCode,
  locale,
  onNext,
  onBack,
}: {
  data?: Step3Data;
  shortCode: string | undefined;
  locale?: string;
  onNext: (d: Step3Data) => void;
  onBack: () => void;
}) {
  const subdomain = shortCode ? `${shortCode}.${BASE_DOMAIN}` : '';

  // Default to "Bizden alt-domain" mode (most first customers don't own a
  // domain). If we already have a shortCode and no prior data, pre-fill.
  const initialUseSubdomain = data?.useSubdomain ?? true;
  const initialDomain =
    data?.domain ?? (initialUseSubdomain && subdomain ? subdomain : '');

  const [form, setForm] = useState<Step3Data>({
    domain: initialDomain,
    useSubdomain: initialUseSubdomain,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Track whether the operator has manually typed into the domain field.
  // Once true, mode toggles will NOT clobber the value unless it still
  // matches a known auto-fill pattern. We also remember the last value the
  // wizard itself auto-filled so we can safely overwrite *that exact string*
  // when the operator flips modes back and forth without typing.
  const manuallyEditedRef = useRef<boolean>(
    !!data?.domain && data.domain !== subdomain,
  );
  const lastAutoFillRef = useRef<string>(
    initialUseSubdomain && subdomain ? subdomain : '',
  );

  // Keep the auto-fill fresh when shortCode arrives late (e.g. operator hit
  // "Back" to Step 1, changed shortCode, then returned). Only overwrites if
  // the field is still showing the previous auto-fill.
  useEffect(() => {
    if (!form.useSubdomain || !subdomain) return;
    if (manuallyEditedRef.current) return;
    if (form.domain === subdomain) return;
    if (form.domain === '' || form.domain === lastAutoFillRef.current) {
      lastAutoFillRef.current = subdomain;
      setForm((prev) => ({ ...prev, domain: subdomain }));
    }
  }, [form.useSubdomain, form.domain, subdomain]);

  function pickOwnDomain() {
    // If the current value is an auto-fill (untouched), clear it. If the
    // operator typed something, leave it alone — they may want to keep it.
    const wasAutoFill =
      !manuallyEditedRef.current && form.domain === lastAutoFillRef.current;
    setForm((prev) => ({
      ...prev,
      useSubdomain: false,
      domain: wasAutoFill ? '' : prev.domain,
    }));
    if (wasAutoFill) {
      lastAutoFillRef.current = '';
    }
  }

  function pickSubdomain() {
    if (!subdomain) return;
    // If the field is empty or holding the previous auto-fill, replace with
    // the fresh subdomain. Otherwise (operator typed a custom value) leave
    // it alone — they can clear the field manually if they want the default.
    const shouldAutoFill =
      !manuallyEditedRef.current &&
      (form.domain === '' || form.domain === lastAutoFillRef.current);
    setForm((prev) => ({
      ...prev,
      useSubdomain: true,
      domain: shouldAutoFill ? subdomain : prev.domain,
    }));
    if (shouldAutoFill) {
      lastAutoFillRef.current = subdomain;
    }
  }

  function handleDomainChange(value: string) {
    const trimmed = value.trim();
    // Any keystroke outside an auto-fill string counts as a manual edit.
    if (trimmed !== lastAutoFillRef.current) {
      manuallyEditedRef.current = true;
    }
    setForm((prev) => ({ ...prev, domain: trimmed }));
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

  // Preview block uses whatever domain is currently in the form, falling
  // back to a placeholder so the layout doesn't jump while the operator
  // types. Locale defaults to 'tr' if Step 5 hasn't been reached yet.
  const previewHost = form.domain || `${shortCode ?? 'restoran'}.${BASE_DOMAIN}`;
  const previewLocale = locale && locale.length > 0 ? locale : 'tr';

  // Placeholder reflects the current mode so the operator sees the format
  // they're aiming for.
  const placeholder = form.useSubdomain
    ? (subdomain || `slug.${BASE_DOMAIN}`)
    : `siparis.${BASE_DOMAIN}`;

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
          active={form.useSubdomain}
          onClick={pickSubdomain}
          title={`Bizden Alt-Domain Al (${BASE_DOMAIN})`}
          desc="Restoran kendi domain'ine sahip değilse hızlı kurulum için bizden bir alt-domain veriyoruz."
          disabled={!shortCode}
        />
        <ModeOption
          active={!form.useSubdomain}
          onClick={pickOwnDomain}
          title="Müşterinin Kendi Domain'i"
          desc="Restoranın sahibi olduğu özel bir domain (örn. siparis.acmepide.com)."
        />
      </div>
      {!shortCode && (
        <p className="text-xs text-amber-400">
          Kısa kod (Step 1) belirlenmeden alt-domain seçilemez.
        </p>
      )}

      {/* Domain field — always editable, regardless of mode. The
          subdomain mode merely auto-fills on first pick; the operator can
          override (e.g. for staging or vanity subdomains). */}
      <div>
        <label htmlFor="domain" className="block text-sm text-slate-300 mb-1">
          Domain <span className="text-red-400">*</span>
        </label>
        <input
          id="domain"
          type="text"
          value={form.domain}
          onChange={(e) => handleDomainChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full bg-slate-900 text-slate-100 rounded p-2 text-sm font-mono border focus:outline-none ${
            errors['domain']
              ? 'border-red-500'
              : 'border-slate-700 focus:border-blue-500'
          }`}
        />
        {form.useSubdomain && subdomain && (
          <p className="text-xs text-slate-500 mt-1">
            Önerilen:{' '}
            <button
              type="button"
              onClick={() => {
                manuallyEditedRef.current = false;
                lastAutoFillRef.current = subdomain;
                setForm((prev) => ({ ...prev, domain: subdomain }));
              }}
              className="font-mono text-slate-300 hover:text-blue-400 underline-offset-2 hover:underline"
            >
              {subdomain}
            </button>{' '}
            — gerekirse düzenleyebilirsiniz.
          </p>
        )}
        {errors['domain'] && (
          <p
            className="text-xs text-red-400 mt-1"
            data-error="domain-format"
            role="alert"
          >
            {errors['domain']}
          </p>
        )}
      </div>

      {/* URL preview — live binding to form.domain + the locale picked in
          Step 5 (defaults to 'tr' if not yet reached). The path prefix
          includes the `[locale]` segment so it matches the real
          customer-app routes. */}
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
                <span className="text-blue-400">
                  /{previewLocale}/{path}
                </span>
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
