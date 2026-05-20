/**
 * Step4Template — visual template + brand color + logo + font (Phase H5).
 *
 * Five built-in templates (matches the menu-template registry):
 *   - classic, singleflow, visual, quickorder, minimal.
 *
 * Brand color picker:
 *   - Hex input + native color swatch. We render a live "Aa" preview chip
 *     using the WCAG luminance heuristic (relative luminance > 0.5 →
 *     dark foreground; ≤ 0.5 → light foreground) so operators can see at
 *     a glance whether their pick has enough contrast for the marquee
 *     elements that use it.
 *
 * Logo:
 *   - V1 stub: file input that converts to a pseudo URL via the file's
 *     name. The H6 worker will swap this for a real S3-style upload; the
 *     wizard contract just needs a URL string.
 *
 * Font:
 *   - Curated list (Inter, Playfair, Poppins, Montserrat) plus a "Custom"
 *     escape hatch. Custom mode reveals two extra fields the menu app
 *     uses to inject `@font-face` (fontUrl + fontFamily).
 */
'use client';

import { type FormEvent, useState } from 'react';
import { z } from 'zod';

import type { Step4Data, Template } from './TenantWizardClient';

// ---------------------------------------------------------------------------
// Template catalogue
// ---------------------------------------------------------------------------

interface TemplateMeta {
  key: Template;
  label: string;
  desc: string;
  // Default brand color used by the template's reference design — purely a
  // suggestion, the operator can override.
  defaultColor: string;
}

const TEMPLATES: TemplateMeta[] = [
  {
    key: 'classic',
    label: 'Classic',
    desc: 'Klasik kategori + ürün listesi, her sınıfa uygun.',
    defaultColor: '#0f766e',
  },
  {
    key: 'singleflow',
    label: 'Single Flow',
    desc: 'Tek ekran akışlı, hızlı sipariş için.',
    defaultColor: '#dc2626',
  },
  {
    key: 'visual',
    label: 'Visual',
    desc: 'Büyük görsellerle vitrin tarzı menü.',
    defaultColor: '#9333ea',
  },
  {
    key: 'quickorder',
    label: 'Quick Order',
    desc: 'Sadece sayı ve ekle butonu — fast-food için.',
    defaultColor: '#f59e0b',
  },
  {
    key: 'minimal',
    label: 'Minimal',
    desc: 'Tipografi ağırlıklı, sade tasarım.',
    defaultColor: '#1e293b',
  },
  {
    key: 'sushi',
    label: 'Sushi & Japon',
    desc: 'Maki, nigiri, sashimi vitrini — koyu deniz mavisi temalı.',
    defaultColor: '#1E3A8A',
  },
];

const FONT_PRESETS = [
  'Inter',
  'Playfair Display',
  'Poppins',
  'Montserrat',
  'custom',
] as const;

type FontPreset = (typeof FONT_PRESETS)[number];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const hexColorRegex = /^#[0-9a-fA-F]{6}$/;

const schema = z
  .object({
    template: z.enum(['classic', 'singleflow', 'visual', 'quickorder', 'minimal', 'sushi']),
    primaryColor: z
      .string()
      .regex(hexColorRegex, 'Hex format: #RRGGBB'),
    logoUrl: z.string().url('Geçerli bir URL').optional(),
    font: z.string().min(1, 'Font seçin'),
    customFontUrl: z.string().url('Geçerli bir URL').optional(),
    customFontFamily: z.string().min(1).optional(),
  })
  .refine(
    (data) => {
      if (data.font === 'custom') {
        return !!data.customFontUrl && !!data.customFontFamily;
      }
      return true;
    },
    {
      message: 'Custom font için URL ve font ailesi gerekli',
      path: ['customFontUrl'],
    },
  );

const DEFAULT_FORM: Step4Data = {
  template: 'classic',
  primaryColor: '#0f766e',
  font: 'Inter',
};

// ---------------------------------------------------------------------------
// WCAG luminance helper — picks dark vs. light foreground so the preview
// "Aa" chip stays readable across any brand color.
// ---------------------------------------------------------------------------

function relativeLuminance(hex: string): number {
  const m = hex.replace('#', '');
  if (m.length !== 6) return 0;
  const channel = (raw: string): number => {
    const v = parseInt(raw, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = channel(m.slice(0, 2));
  const g = channel(m.slice(2, 4));
  const b = channel(m.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readableForeground(hex: string): string {
  // Per the H5 spec: luminance > 0.5 → use dark text (slate-900);
  // otherwise → use light text (slate-100). Slightly more conservative
  // than full WCAG AA but matches the spec wording exactly.
  return relativeLuminance(hex) > 0.5 ? '#0f172a' : '#f1f5f9';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Step4Template({
  data,
  onNext,
  onBack,
}: {
  data?: Step4Data;
  onNext: (d: Step4Data) => void;
  onBack: () => void;
}) {
  const [form, setForm] = useState<Step4Data>(data ?? DEFAULT_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function handleTemplatePick(template: Template) {
    const meta = TEMPLATES.find((t) => t.key === template);
    setForm((prev) => ({
      ...prev,
      template,
      // Only adopt the template's default color if the operator hasn't
      // already customized it (i.e., they're still on the previous template's
      // default).
      primaryColor:
        meta && (prev.primaryColor === DEFAULT_FORM.primaryColor ||
          TEMPLATES.some((t) => t.defaultColor === prev.primaryColor))
          ? meta.defaultColor
          : prev.primaryColor,
    }));
  }

  function handleFontChange(font: FontPreset) {
    setForm((prev) => ({
      ...prev,
      font,
      // Clear custom-only fields when switching back to a preset.
      ...(font !== 'custom'
        ? { customFontUrl: undefined, customFontFamily: undefined }
        : {}),
    }));
  }

  function handleLogoFile(file: File | null) {
    // V1 stub: we don't have an upload endpoint yet, so we synthesize a
    // pseudo URL from the filename. H6 swaps this for a real upload that
    // returns a CDN URL.
    if (!file) {
      setForm((prev) => ({ ...prev, logoUrl: undefined }));
      return;
    }
    const safe = file.name.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
    setForm((prev) => ({
      ...prev,
      logoUrl: `https://uploads.qrsiparis.app/pending/${safe}`,
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

  const fg = readableForeground(form.primaryColor);

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-6"
      noValidate
    >
      <header>
        <h2 className="text-lg font-semibold text-slate-100">Şablon & Marka</h2>
        <p className="text-xs text-slate-400 mt-1">
          Menü görünümü, ana renk, logo ve yazı tipi.
        </p>
      </header>

      {/* Template gallery */}
      <fieldset>
        <legend className="block text-sm text-slate-300 mb-2">
          Menü Şablonu <span className="text-red-400">*</span>
        </legend>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {TEMPLATES.map((t) => {
            const active = form.template === t.key;
            return (
              <label
                key={t.key}
                className={`block cursor-pointer rounded-lg border p-3 transition-colors ${
                  active
                    ? 'border-blue-500 bg-blue-950/40'
                    : 'border-slate-700 bg-slate-900 hover:border-slate-600'
                }`}
              >
                <input
                  type="radio"
                  name="template"
                  value={t.key}
                  checked={active}
                  onChange={() => handleTemplatePick(t.key)}
                  className="sr-only"
                />
                <div
                  className="w-full h-12 rounded mb-2"
                  style={{ backgroundColor: t.defaultColor }}
                  aria-hidden="true"
                />
                <div className="text-sm font-semibold text-slate-100">
                  {t.label}
                </div>
                <div className="text-[11px] text-slate-400 mt-1 leading-snug">
                  {t.desc}
                </div>
              </label>
            );
          })}
        </div>
        {errors['template'] && (
          <p className="text-xs text-red-400 mt-1">{errors['template']}</p>
        )}
      </fieldset>

      {/* Brand color */}
      <div>
        <label
          htmlFor="primaryColor"
          className="block text-sm text-slate-300 mb-1"
        >
          Ana Renk <span className="text-red-400">*</span>
        </label>
        <div className="flex items-center gap-3">
          <input
            id="primaryColor"
            type="color"
            value={form.primaryColor}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, primaryColor: e.target.value }))
            }
            className="h-10 w-14 rounded cursor-pointer border border-slate-700 bg-slate-900"
          />
          <input
            type="text"
            value={form.primaryColor}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, primaryColor: e.target.value }))
            }
            placeholder="#0f766e"
            className={`w-32 bg-slate-900 text-slate-100 rounded p-2 text-sm font-mono border focus:outline-none ${
              errors['primaryColor']
                ? 'border-red-500'
                : 'border-slate-700 focus:border-blue-500'
            }`}
          />
          {/* Live preview chip — visualizes auto-contrast text */}
          <div
            className="flex items-center gap-2 px-3 py-2 rounded text-sm font-semibold"
            style={{ backgroundColor: form.primaryColor, color: fg }}
            aria-label="Renk önizlemesi"
          >
            Aa Önizleme
          </div>
        </div>
        {errors['primaryColor'] && (
          <p className="text-xs text-red-400 mt-1">{errors['primaryColor']}</p>
        )}
      </div>

      {/* Logo */}
      <div>
        <label htmlFor="logo" className="block text-sm text-slate-300 mb-1">
          Logo (opsiyonel)
        </label>
        <input
          id="logo"
          type="file"
          accept="image/*"
          onChange={(e) => handleLogoFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded file:border-0 file:bg-slate-700 file:text-slate-100 hover:file:bg-slate-600"
        />
        {form.logoUrl && (
          <p className="text-xs text-slate-500 mt-1 font-mono break-all">
            {form.logoUrl}
          </p>
        )}
      </div>

      {/* Font selector */}
      <div>
        <label htmlFor="font" className="block text-sm text-slate-300 mb-1">
          Yazı Tipi <span className="text-red-400">*</span>
        </label>
        <select
          id="font"
          value={
            FONT_PRESETS.includes(form.font as FontPreset)
              ? form.font
              : 'custom'
          }
          onChange={(e) => handleFontChange(e.target.value as FontPreset)}
          className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
        >
          {FONT_PRESETS.map((font) => (
            <option key={font} value={font}>
              {font === 'custom' ? 'Özel (custom)' : font}
            </option>
          ))}
        </select>
      </div>

      {/* Custom font fields */}
      {form.font === 'custom' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 bg-slate-900/50 border border-slate-700 rounded">
          <div>
            <label
              htmlFor="customFontUrl"
              className="block text-xs text-slate-400 mb-1"
            >
              Font URL <span className="text-red-400">*</span>
            </label>
            <input
              id="customFontUrl"
              type="url"
              value={form.customFontUrl ?? ''}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  customFontUrl: e.target.value,
                }))
              }
              placeholder="https://fonts.googleapis.com/..."
              className={`w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border focus:outline-none ${
                errors['customFontUrl']
                  ? 'border-red-500'
                  : 'border-slate-700 focus:border-blue-500'
              }`}
            />
            {errors['customFontUrl'] && (
              <p className="text-xs text-red-400 mt-1">
                {errors['customFontUrl']}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="customFontFamily"
              className="block text-xs text-slate-400 mb-1"
            >
              Font Family <span className="text-red-400">*</span>
            </label>
            <input
              id="customFontFamily"
              type="text"
              value={form.customFontFamily ?? ''}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  customFontFamily: e.target.value,
                }))
              }
              placeholder="örn: 'My Brand Sans', sans-serif"
              className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
      )}

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
