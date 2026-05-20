'use client';

/**
 * TenantConfigEditClient — operator-facing config-edit form (V1.5).
 *
 * The form covers the fields operators actually change in practice:
 *   - restaurant.name
 *   - branding.template / .primaryColor / .font / .theme
 *   - modules.cashier/.kitchen/.waiter/.admin/.i18n/.printer/.sms/.kioskMode
 *   - limits.maxTables / .maxStaff / .maxProducts
 *
 * Anything else in the existing snapshot (operationalHours, locale,
 * template-specific sub-config) is passed through verbatim — we never
 * strip unknown keys. An "Advanced JSON" panel (collapsed by default)
 * lets the operator edit the raw payload directly for the fields we
 * don't expose; on submit, the structured form fields override the
 * JSON's matching keys (so the operator who toggles "kitchen=false" in
 * the form wins over a stale `modules.kitchen: true` line in their JSON
 * paste — last-write-wins by control surface position).
 *
 * Submit flow:
 *   1. Merge structured fields into the JSON snapshot.
 *   2. POST to /api/internal/tenants/[id]/config.
 *   3. On success → router.push(`/deployments/{deploymentId}`).
 *   4. On failure → show the API's error message, keep the form intact.
 *
 * --- WHY ONE BIG CLIENT COMPONENT VS PER-SECTION SUB-COMPONENTS ---
 * The wizard is split into Step1..Step7 because each step is a distinct
 * decision point with its own validation gate and progress indicator. The
 * edit form is a single screen with no validation gates between sections,
 * so splitting it adds prop-drilling without semantic benefit. We keep
 * sections inside fieldsets in one component for now; if a section's
 * complexity grows (e.g. real operational-hours editor in V2) we'll
 * extract it then.
 */

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';

type Snapshot = Record<string, unknown>;

interface RestaurantBlock {
  name?: string;
  [k: string]: unknown;
}
interface BrandingBlock {
  template?: string;
  primaryColor?: string;
  font?: string;
  theme?: string;
  [k: string]: unknown;
}
interface ModulesBlock {
  cashier?: boolean;
  kitchen?: boolean;
  waiter?: boolean;
  admin?: boolean;
  i18n?: boolean;
  printer?: boolean;
  sms?: boolean;
  kioskMode?: boolean;
  [k: string]: unknown;
}
interface LimitsBlock {
  maxTables?: number;
  maxStaff?: number;
  maxProducts?: number;
  [k: string]: unknown;
}

const TEMPLATES = [
  { value: 'classic', label: 'Classic' },
  { value: 'visual', label: 'Visual' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'quickorder', label: 'Quick Order' },
  { value: 'singleflow', label: 'Single Flow' },
] as const;

const FONTS = [
  { value: 'inter', label: 'Inter' },
  { value: 'playfair', label: 'Playfair Display' },
  { value: 'tahoma', label: 'Tahoma' },
  { value: 'poppins', label: 'Poppins' },
  { value: 'montserrat', label: 'Montserrat' },
] as const;

const THEMES = [
  { value: 'light', label: 'Açık' },
  { value: 'dark', label: 'Koyu' },
  { value: 'auto', label: 'Otomatik' },
] as const;

const MODULE_FIELDS: Array<{ key: keyof ModulesBlock; label: string }> = [
  { key: 'cashier', label: 'Kasa' },
  { key: 'kitchen', label: 'Mutfak KDS' },
  { key: 'waiter', label: 'Garson' },
  { key: 'admin', label: 'Yönetim Paneli' },
  { key: 'i18n', label: 'Çoklu Dil (i18n)' },
  { key: 'printer', label: 'Yazıcı' },
  { key: 'sms', label: 'SMS' },
  { key: 'kioskMode', label: 'Kiosk Modu' },
];

function readObject(snapshot: Snapshot, key: string): Record<string, unknown> {
  const v = snapshot[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

interface ApiResponse {
  success: boolean;
  data?: { deploymentId: string; configVersion: number };
  error?: { code: string; message: string };
}

export function TenantConfigEditClient({
  tenantId,
  initialSnapshot,
}: {
  tenantId: string;
  initialSnapshot: Snapshot;
}) {
  const router = useRouter();

  // Pre-extract typed slices. We keep `initialSnapshot` itself as the
  // pass-through source-of-truth so unknown keys survive the round-trip.
  const initialRestaurant = useMemo(
    () => readObject(initialSnapshot, 'restaurant') as RestaurantBlock,
    [initialSnapshot],
  );
  const initialBranding = useMemo(
    () => readObject(initialSnapshot, 'branding') as BrandingBlock,
    [initialSnapshot],
  );
  const initialModules = useMemo(
    () => readObject(initialSnapshot, 'modules') as ModulesBlock,
    [initialSnapshot],
  );
  const initialLimits = useMemo(
    () => readObject(initialSnapshot, 'limits') as LimitsBlock,
    [initialSnapshot],
  );

  // ----- Form state -----
  const [restaurantName, setRestaurantName] = useState<string>(
    typeof initialRestaurant.name === 'string' ? initialRestaurant.name : '',
  );

  const [template, setTemplate] = useState<string>(
    typeof initialBranding.template === 'string'
      ? initialBranding.template
      : 'classic',
  );
  const [primaryColor, setPrimaryColor] = useState<string>(
    typeof initialBranding.primaryColor === 'string'
      ? initialBranding.primaryColor
      : '#0f766e',
  );
  const [font, setFont] = useState<string>(
    typeof initialBranding.font === 'string' ? initialBranding.font : 'inter',
  );
  const [theme, setTheme] = useState<string>(
    typeof initialBranding.theme === 'string' ? initialBranding.theme : 'auto',
  );

  const [modules, setModules] = useState<ModulesBlock>(() => ({
    cashier: typeof initialModules.cashier === 'boolean'
      ? initialModules.cashier
      : true,
    kitchen: typeof initialModules.kitchen === 'boolean'
      ? initialModules.kitchen
      : true,
    waiter: typeof initialModules.waiter === 'boolean'
      ? initialModules.waiter
      : false,
    admin: typeof initialModules.admin === 'boolean'
      ? initialModules.admin
      : true,
    i18n: typeof initialModules.i18n === 'boolean'
      ? initialModules.i18n
      : false,
    printer: typeof initialModules.printer === 'boolean'
      ? initialModules.printer
      : false,
    sms: typeof initialModules.sms === 'boolean'
      ? initialModules.sms
      : false,
    kioskMode: typeof initialModules.kioskMode === 'boolean'
      ? initialModules.kioskMode
      : false,
  }));

  const [maxTables, setMaxTables] = useState<string>(
    typeof initialLimits.maxTables === 'number'
      ? String(initialLimits.maxTables)
      : '',
  );
  const [maxStaff, setMaxStaff] = useState<string>(
    typeof initialLimits.maxStaff === 'number'
      ? String(initialLimits.maxStaff)
      : '',
  );
  const [maxProducts, setMaxProducts] = useState<string>(
    typeof initialLimits.maxProducts === 'number'
      ? String(initialLimits.maxProducts)
      : '',
  );

  // Advanced JSON mode: when toggled open, the textarea is seeded with the
  // current snapshot (pretty-printed). On submit, if the operator edited
  // the JSON, we use that as the base and overlay the form fields on top.
  const [jsonMode, setJsonMode] = useState<boolean>(false);
  const [jsonText, setJsonText] = useState<string>(() =>
    JSON.stringify(initialSnapshot, null, 2),
  );
  const [jsonError, setJsonError] = useState<string | null>(null);

  const [triggerReason, setTriggerReason] = useState<string>('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /**
   * Build the final snapshot to PUT. We start from either the JSON
   * textarea (if the operator opened advanced mode and the JSON parses)
   * or the original snapshot, then overlay the structured form fields.
   * Form fields are last-write-wins so a confused operator who edited
   * `modules.kitchen` in both places gets the toggle value.
   *
   * Returns a discriminated `BuildResult` so the caller can distinguish a
   * parse-failure from a valid build without colliding with the snapshot
   * having a literal `error` key (which Zod's passthrough would allow).
   */
  type BuildResult =
    | { ok: true; snapshot: Snapshot }
    | { ok: false; error: string };
  function buildSnapshot(): BuildResult {
    let base: Snapshot;
    if (jsonMode) {
      try {
        const parsed: unknown = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, error: 'JSON kök bir nesne olmalı' };
        }
        base = parsed as Snapshot;
      } catch (e) {
        return {
          ok: false,
          error: `JSON parse hatası: ${
            e instanceof Error ? e.message : 'unknown'
          }`,
        };
      }
    } else {
      base = { ...initialSnapshot };
    }

    const baseRestaurant = readObject(base, 'restaurant');
    const baseBranding = readObject(base, 'branding');
    const baseModules = readObject(base, 'modules');
    const baseLimits = readObject(base, 'limits');

    const merged: Snapshot = {
      ...base,
      restaurant: {
        ...baseRestaurant,
        name: restaurantName,
      },
      branding: {
        ...baseBranding,
        template,
        primaryColor,
        font,
        theme,
      },
      modules: {
        ...baseModules,
        ...modules,
      },
      limits: {
        ...baseLimits,
        ...(maxTables ? { maxTables: Number(maxTables) } : {}),
        ...(maxStaff ? { maxStaff: Number(maxStaff) } : {}),
        ...(maxProducts ? { maxProducts: Number(maxProducts) } : {}),
      },
    };
    return { ok: true, snapshot: merged };
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    setSubmitError(null);
    setJsonError(null);

    if (restaurantName.trim().length === 0) {
      setSubmitError('Restoran adı boş olamaz');
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
      setSubmitError('Ana renk #RRGGBB formatında olmalı');
      return;
    }

    const built = buildSnapshot();
    if (!built.ok) {
      setJsonError(built.error);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/internal/tenants/${tenantId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configSnapshot: built.snapshot,
          triggerReason:
            triggerReason.trim().length > 0
              ? triggerReason.trim()
              : 'Config edit (panel)',
        }),
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || !json.success || !json.data) {
        setSubmitError(json.error?.message ?? 'Konfigürasyon güncellenemedi');
        setSubmitting(false);
        return;
      }
      router.push(`/deployments/${json.data.deploymentId}`);
    } catch {
      setSubmitError('Sunucuya ulaşılamadı');
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6"
      data-testid="tenant-config-edit-form"
    >
      {/* ----- Restaurant ----- */}
      <fieldset className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4">
        <legend className="text-lg font-semibold text-slate-100 px-2">
          Restoran
        </legend>
        <div>
          <label
            htmlFor="restaurantName"
            className="block text-sm text-slate-300 mb-1"
          >
            Restoran Adı <span className="text-red-400">*</span>
          </label>
          <input
            id="restaurantName"
            type="text"
            value={restaurantName}
            onChange={(e) => setRestaurantName(e.target.value)}
            className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
            required
          />
        </div>
      </fieldset>

      {/* ----- Branding ----- */}
      <fieldset className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4">
        <legend className="text-lg font-semibold text-slate-100 px-2">
          Marka
        </legend>

        <div>
          <label
            htmlFor="template"
            className="block text-sm text-slate-300 mb-1"
          >
            Menü Şablonu
          </label>
          <select
            id="template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
          >
            {TEMPLATES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="primaryColor"
            className="block text-sm text-slate-300 mb-1"
          >
            Ana Renk
          </label>
          <div className="flex items-center gap-3">
            <input
              id="primaryColor"
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="h-10 w-14 rounded cursor-pointer border border-slate-700 bg-slate-900"
            />
            <input
              type="text"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              placeholder="#0f766e"
              className="w-32 bg-slate-900 text-slate-100 rounded p-2 text-sm font-mono border border-slate-700 focus:border-blue-500 focus:outline-none"
            />
            <div
              className="px-3 py-2 rounded text-sm font-semibold"
              style={{
                backgroundColor: primaryColor,
                color: '#f1f5f9',
              }}
            >
              Önizleme
            </div>
          </div>
        </div>

        <div>
          <label htmlFor="font" className="block text-sm text-slate-300 mb-1">
            Yazı Tipi
          </label>
          <select
            id="font"
            value={font}
            onChange={(e) => setFont(e.target.value)}
            className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
          >
            {FONTS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className="block text-sm text-slate-300 mb-1">Tema</span>
          <div className="flex gap-2">
            {THEMES.map((t) => (
              <label
                key={t.value}
                className={`px-3 py-1.5 rounded text-sm cursor-pointer border ${
                  theme === t.value
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={theme === t.value}
                  onChange={() => setTheme(t.value)}
                  className="sr-only"
                />
                {t.label}
              </label>
            ))}
          </div>
        </div>
      </fieldset>

      {/* ----- Modules ----- */}
      <fieldset className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-3">
        <legend className="text-lg font-semibold text-slate-100 px-2">
          Modüller
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {MODULE_FIELDS.map((m) => (
            <label
              key={m.key as string}
              className="flex items-center gap-3 p-3 bg-slate-900 rounded cursor-pointer hover:bg-slate-700/50"
            >
              <input
                type="checkbox"
                checked={Boolean(modules[m.key])}
                onChange={(e) =>
                  setModules((prev) => ({
                    ...prev,
                    [m.key]: e.target.checked,
                  }))
                }
                className="w-4 h-4"
              />
              <span className="text-slate-200 text-sm">{m.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* ----- Limits ----- */}
      <fieldset className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4">
        <legend className="text-lg font-semibold text-slate-100 px-2">
          Limitler
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="maxTables"
              className="block text-sm text-slate-300 mb-1"
            >
              Max Masa
            </label>
            <input
              id="maxTables"
              type="number"
              min={0}
              value={maxTables}
              onChange={(e) => setMaxTables(e.target.value)}
              className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="maxStaff"
              className="block text-sm text-slate-300 mb-1"
            >
              Max Personel
            </label>
            <input
              id="maxStaff"
              type="number"
              min={0}
              value={maxStaff}
              onChange={(e) => setMaxStaff(e.target.value)}
              className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="maxProducts"
              className="block text-sm text-slate-300 mb-1"
            >
              Max Ürün
            </label>
            <input
              id="maxProducts"
              type="number"
              min={0}
              value={maxProducts}
              onChange={(e) => setMaxProducts(e.target.value)}
              className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
      </fieldset>

      {/* ----- Advanced JSON ----- */}
      <details
        className="bg-slate-800 border border-slate-700 rounded-lg p-6"
        onToggle={(e) => setJsonMode((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-lg font-semibold text-slate-100 select-none">
          JSON Modu (gelişmiş)
        </summary>
        <p className="text-xs text-slate-400 mt-2">
          Üstteki form alanlarında olmayan ayarları (locale,
          operationalHours, şablona özel ayarlar) buradan düzenleyebilirsin.
          Gönderildiğinde formdaki değerler bu JSON&apos;un üzerine yazılır
          — yani aynı alanı iki yerden değiştirirsen formdaki değer
          kazanır.
        </p>
        <textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          rows={20}
          className="w-full mt-3 bg-slate-900 text-slate-100 rounded p-3 text-xs font-mono border border-slate-700 focus:border-blue-500 focus:outline-none"
          spellCheck={false}
        />
        {jsonError ? (
          <p className="text-xs text-red-400 mt-2">{jsonError}</p>
        ) : null}
      </details>

      {/* ----- Trigger reason + actions ----- */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4">
        <div>
          <label
            htmlFor="triggerReason"
            className="block text-sm text-slate-300 mb-1"
          >
            Değişiklik nedeni (opsiyonel)
          </label>
          <input
            id="triggerReason"
            type="text"
            value={triggerReason}
            onChange={(e) => setTriggerReason(e.target.value)}
            placeholder="örn: yeni şablona geçiş, marka rengi güncellendi"
            maxLength={500}
            className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
          />
        </div>

        {submitError ? (
          <p
            className="text-sm text-red-400"
            data-testid="config-edit-error"
          >
            {submitError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => router.push(`/musteriler/${tenantId}`)}
            disabled={submitting}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-slate-100 text-sm disabled:opacity-60"
          >
            Vazgeç
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white font-medium text-sm disabled:opacity-60 disabled:cursor-not-allowed"
            data-testid="config-edit-submit"
          >
            {submitting
              ? 'Dağıtılıyor...'
              : 'Kaydet ve Yeniden Dağıt'}
          </button>
        </div>
      </div>
    </form>
  );
}
