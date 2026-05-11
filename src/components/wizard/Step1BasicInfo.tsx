/**
 * Step1BasicInfo — restaurant identity + contact info (Phase H5).
 *
 * Validation:
 *   - `restaurantName` 2-120 chars (matches Doc 17 §3.2 column max)
 *   - `shortCode` regex /^[a-z0-9-]+$/, length 3-50 (matches DB check
 *     `ck_tenants_short_code_format`)
 *   - `phone` E.164 Turkish form +90XXXXXXXXXX (10 digits after +90)
 *   - `email` standard RFC
 *   - `city`, `address` non-empty
 *
 * Auto-slug: `shortCode` is auto-generated from `restaurantName` via a
 * Turkish-aware slug helper. The user can still override it; we only
 * regenerate while they haven't manually edited the field (we detect this
 * by remembering the last auto-value and only overwriting when the current
 * field still matches).
 */
'use client';

import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { z } from 'zod';

import type { Step1Data } from './TenantWizardClient';

// Mirrors the DB CHECK constraint on tenants.short_code (schema.ts).
const shortCodeRegex = /^[a-z0-9-]+$/;
// Turkish-mobile / E.164 form. Accepts +90 followed by exactly 10 digits.
const phoneRegex = /^\+90[0-9]{10}$/;

const schema = z.object({
  restaurantName: z
    .string()
    .min(2, 'En az 2 karakter olmalı')
    .max(120, 'En fazla 120 karakter olabilir'),
  shortCode: z
    .string()
    .min(3, 'En az 3 karakter olmalı')
    .max(50, 'En fazla 50 karakter olabilir')
    .regex(shortCodeRegex, "Sadece küçük harf, rakam ve '-' kullanılabilir"),
  contactName: z
    .string()
    .min(2, 'En az 2 karakter olmalı')
    .max(120, 'En fazla 120 karakter olabilir'),
  phone: z
    .string()
    .regex(phoneRegex, "Format: +90XXXXXXXXXX (10 rakam)"),
  email: z.string().email('Geçerli bir e-posta giriniz'),
  city: z.string().min(2, 'Şehir gerekli'),
  address: z.string().min(2, 'Adres gerekli'),
});

const EMPTY: Step1Data = {
  restaurantName: '',
  shortCode: '',
  contactName: '',
  phone: '+90',
  email: '',
  city: '',
  address: '',
};

/**
 * Turkish-aware slug helper. Maps Turkish-specific letters to their ASCII
 * equivalents before stripping anything that isn't `[a-z0-9-]`, then
 * collapses repeated dashes and trims them off the ends.
 */
function autoSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

export function Step1BasicInfo({
  data,
  onNext,
}: {
  data?: Step1Data;
  onNext: (d: Step1Data) => void;
}) {
  const [form, setForm] = useState<Step1Data>(data ?? EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Track the last auto-generated slug so we know whether the user has
  // edited shortCode manually. Once they do, we stop overwriting it.
  const lastAutoSlug = useRef<string>(data ? autoSlug(data.restaurantName) : '');

  function handleNameChange(value: string) {
    const generated = autoSlug(value);
    setForm((prev) => {
      // Only auto-fill shortCode if the user hasn't customized it.
      const shouldAutoFill =
        prev.shortCode === '' || prev.shortCode === lastAutoSlug.current;
      const next = {
        ...prev,
        restaurantName: value,
        shortCode: shouldAutoFill ? generated : prev.shortCode,
      };
      lastAutoSlug.current = generated;
      return next;
    });
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
      className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4"
      noValidate
    >
      <header className="mb-2">
        <h2 className="text-lg font-semibold text-slate-100">Temel Bilgiler</h2>
        <p className="text-xs text-slate-400 mt-1">
          Restoran adı ve birincil iletişim kanalı.
        </p>
      </header>

      <Field
        label="Restoran Adı"
        value={form.restaurantName}
        onChange={handleNameChange}
        error={errors['restaurantName']}
        placeholder="örn. Acme Pide"
        required
      />

      <Field
        label="Kısa Kod (URL slug)"
        value={form.shortCode}
        onChange={(v) => setForm((prev) => ({ ...prev, shortCode: v }))}
        hint="Restoran adından otomatik üretilir, gerekirse düzenleyin. Sadece küçük harf, rakam ve tire."
        error={errors['shortCode']}
        required
        mono
      />

      <Field
        label="İletişim Adı"
        value={form.contactName}
        onChange={(v) => setForm((prev) => ({ ...prev, contactName: v }))}
        error={errors['contactName']}
        required
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field
          label="Telefon"
          value={form.phone}
          onChange={(v) => setForm((prev) => ({ ...prev, phone: v }))}
          error={errors['phone']}
          placeholder="+90XXXXXXXXXX"
          required
        />
        <Field
          label="E-posta"
          value={form.email}
          onChange={(v) => setForm((prev) => ({ ...prev, email: v }))}
          error={errors['email']}
          type="email"
          required
        />
      </div>

      <Field
        label="Şehir"
        value={form.city}
        onChange={(v) => setForm((prev) => ({ ...prev, city: v }))}
        error={errors['city']}
        placeholder="örn. İstanbul"
        required
      />

      <Field
        label="Adres"
        value={form.address}
        onChange={(v) => setForm((prev) => ({ ...prev, address: v }))}
        error={errors['address']}
        multiline
        required
      />

      <div className="flex justify-end pt-4">
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
// Inline form field (kept local so each step can tune its own variants).
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  hint?: ReactNode;
  type?: string;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  multiline?: boolean;
}

function Field({
  label,
  value,
  onChange,
  error,
  hint,
  type = 'text',
  placeholder,
  required,
  mono,
  multiline,
}: FieldProps) {
  const baseClass = `w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border focus:outline-none ${
    error ? 'border-red-500' : 'border-slate-700 focus:border-blue-500'
  } ${mono ? 'font-mono' : ''}`;

  return (
    <div>
      <label className="block text-sm text-slate-300 mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className={baseClass}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          type={type}
          placeholder={placeholder}
          className={baseClass}
        />
      )}
      {hint && !error && (
        <p className="text-xs text-slate-500 mt-1">{hint}</p>
      )}
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  );
}
