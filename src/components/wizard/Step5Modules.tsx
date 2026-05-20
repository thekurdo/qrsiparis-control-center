'use client';
import { useState, type FormEvent } from 'react';

const TIER_DEFAULTS = {
  baslangic: { maxTables: 20, maxStaff: 5, maxProducts: 100, maxCategories: 10, maxStorageMb: 500, ordersPerMinute: 15, apiRequestsPerMinute: 100 },
  standart: { maxTables: 50, maxStaff: 10, maxProducts: 500, maxCategories: 30, maxStorageMb: 2000, ordersPerMinute: 25, apiRequestsPerMinute: 200 },
  profesyonel: { maxTables: 200, maxStaff: 30, maxProducts: 2000, maxCategories: 100, maxStorageMb: 10000, ordersPerMinute: 60, apiRequestsPerMinute: 600 },
} as const;

const LOCALES = [
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
];

// Tier-driven default locale set. The operator can still toggle individual
// languages in the UI; this is just the initial pre-selection on first
// arrival at Step 5. Mirrors the tier descriptions in Step 2
// ("2 dil" / "3 dil" / "4+ dil").
const TIER_DEFAULT_LOCALES: Record<keyof typeof TIER_DEFAULTS, string[]> = {
  baslangic: ['tr', 'en'],
  standart: ['tr', 'en', 'ar'],
  profesyonel: ['tr', 'en', 'ar', 'ru', 'de'],
};

export interface Step5Data {
  modules: { customerPwa: boolean; cashier: boolean; kitchen: boolean; waiter: boolean; admin: boolean; sms: boolean; printer: boolean; kioskMode: boolean };
  locale: { default: string; enabled: string[] };
  limits: typeof TIER_DEFAULTS[keyof typeof TIER_DEFAULTS];
}

export function Step5Modules({ data, tier, onNext, onBack }: { data?: Step5Data; tier: keyof typeof TIER_DEFAULTS; onNext: (d: Step5Data) => void; onBack: () => void }) {
  const limits = TIER_DEFAULTS[tier];
  const [modules, setModules] = useState(data?.modules ?? { customerPwa: true, cashier: true, kitchen: true, waiter: true, admin: true, sms: false, printer: false, kioskMode: false });
  const [defaultLocale, setDefaultLocale] = useState<string>(data?.locale?.default ?? 'tr');
  const [enabledLocales, setEnabledLocales] = useState<string[]>(
    data?.locale?.enabled ?? TIER_DEFAULT_LOCALES[tier],
  );

  function toggleLocale(code: string) {
    if (code === defaultLocale) return; // can't disable default
    setEnabledLocales(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!enabledLocales.includes(defaultLocale)) {
      setEnabledLocales([...enabledLocales, defaultLocale]);
    }
    onNext({ modules, locale: { default: defaultLocale, enabled: enabledLocales }, limits });
  }

  return (
    <form onSubmit={handleSubmit} className="bg-slate-800 rounded-lg p-6 space-y-6">
      <h2 className="text-lg font-semibold text-slate-100">Modüller ve Özellikler</h2>

      <section>
        <h3 className="text-sm font-medium text-slate-300 mb-3">Aktif Modüller</h3>
        <div className="space-y-2">
          {[
            { key: 'customerPwa', label: 'Müşteri PWA (QR Sipariş)', alwaysOn: true },
            { key: 'cashier', label: 'Kasa Paneli', alwaysOn: true },
            { key: 'kitchen', label: 'Mutfak KDS', alwaysOn: false },
            { key: 'waiter', label: 'Garson Paneli', alwaysOn: false },
            { key: 'admin', label: 'Yönetim Paneli', alwaysOn: true },
            { key: 'sms', label: 'SMS Bildirim (V2)', alwaysOn: false, disabled: true },
            { key: 'printer', label: 'Termal Yazıcı (V1.5)', alwaysOn: false, disabled: true },
            { key: 'kioskMode', label: 'Kiosk Modu (V1.5)', alwaysOn: false, disabled: true },
          ].map(m => (
            <label key={m.key} className={`flex items-center gap-3 p-3 bg-slate-900 rounded cursor-pointer ${m.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
              <input
                type="checkbox"
                checked={modules[m.key as keyof typeof modules]}
                disabled={m.alwaysOn || m.disabled}
                onChange={(e) => !m.alwaysOn && !m.disabled && setModules({ ...modules, [m.key]: e.target.checked })}
                className="w-4 h-4"
              />
              <span className="text-slate-200">{m.label}</span>
              {m.alwaysOn && <span className="text-xs text-slate-500 ml-auto">Zorunlu</span>}
            </label>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-medium text-slate-300 mb-3">Diller</h3>
        <p className="text-xs text-slate-500 mb-2">Varsayılan dil:</p>
        <div className="flex gap-2 flex-wrap mb-4">
          {LOCALES.map(l => (
            <button key={l.code} type="button" onClick={() => { setDefaultLocale(l.code); if (!enabledLocales.includes(l.code)) setEnabledLocales([...enabledLocales, l.code]); }}
              className={`px-3 py-1.5 rounded text-sm ${defaultLocale === l.code ? 'bg-blue-600 text-white' : 'bg-slate-900 text-slate-300'}`}>
              {l.flag} {l.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500 mb-2">Aktif diller:</p>
        <div className="flex gap-2 flex-wrap">
          {LOCALES.map(l => (
            <button key={l.code} type="button" onClick={() => toggleLocale(l.code)} disabled={l.code === defaultLocale}
              className={`px-3 py-1.5 rounded text-sm ${enabledLocales.includes(l.code) ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-400'} ${l.code === defaultLocale ? 'opacity-75' : ''}`}>
              {l.flag} {l.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-medium text-slate-300 mb-3">{tier === 'baslangic' ? 'Başlangıç' : tier === 'standart' ? 'Standart' : 'Profesyonel'} Tier Limitleri</h3>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Max Masa" value={limits.maxTables} />
          <Stat label="Max Personel" value={limits.maxStaff} />
          <Stat label="Max Ürün" value={limits.maxProducts} />
          <Stat label="Max Kategori" value={limits.maxCategories} />
          <Stat label="Max Depolama" value={`${limits.maxStorageMb} MB`} />
          <Stat label="Sipariş/dk" value={limits.ordersPerMinute} />
        </dl>
      </section>

      <div className="flex justify-between pt-4">
        <button type="button" onClick={onBack} className="px-4 py-2 text-slate-300 hover:text-white">← Geri</button>
        <button type="submit" className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded text-white font-medium">İleri →</button>
      </div>
    </form>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return <div className="bg-slate-900 p-2 rounded"><dt className="text-xs text-slate-500">{label}</dt><dd className="text-slate-100 font-semibold">{value}</dd></div>;
}
