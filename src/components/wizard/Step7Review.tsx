/**
 * Step7Review — final summary + contract upload + deploy trigger.
 *
 * H5b polish: removed the six-checkbox "operator friction" panel that used
 * to gate the DEPLOY button. Those items (DNS, SSL, healthcheck, login URL,
 * assets, welcome email) are all handled automatically by the deployment
 * pipeline now, so we surface them as a read-only "Otomatik kontroller"
 * panel with green ticks instead of asking the operator to confirm each one.
 *
 * The summary also explicitly renders `durationMonths` with a "12 ay"
 * fallback so the contract block can never display an empty
 * "Sözleşme Süresi:" row even if Step 2's local state somehow bypasses the
 * default selection (defensive — Step 2 already initializes to 12).
 */
'use client';
import { useState } from 'react';

const AUTOMATIC_CHECKS: { label: string; sub: string }[] = [
  { label: 'DNS yapılandırması (CNAME / A record)', sub: 'Wildcard *.qrsiparis.app otomatik eşlenir' },
  { label: "SSL sertifikası (Let's Encrypt)", sub: 'İlk deploy sırasında otomatik üretilir' },
  { label: 'Container health check', sub: 'Pipeline step04 → step05 doğrular' },
  { label: 'Login URL erişilebilirliği', sub: 'Smoke test step06 tarafından' },
  { label: "Asset'ler (logo, ikonlar)", sub: 'Build adımında CDN\'e yüklenir' },
  { label: 'Hoşgeldin e-postası', sub: 'Tenant yaratıldığında otomatik tetiklenir' },
];

export function Step7Review({
  state,
  onBack,
  onDeploy,
  submitting,
  error,
}: {
  state: any;
  onBack: () => void;
  onDeploy: () => void;
  submitting: boolean;
  error?: string | null;
}) {
  const [contractFile, setContractFile] = useState<File | null>(null);

  const durationMonths = state.step2?.durationMonths ?? 12;
  const monthlyFeeTl =
    typeof state.step2?.monthlyFeeKurus === 'number'
      ? (state.step2.monthlyFeeKurus / 100).toLocaleString('tr-TR')
      : '—';

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="bg-slate-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">Özet</h2>
        <div className="space-y-3 text-sm">
          <Section
            title="Restoran"
            data={state.step1}
            fields={['restaurantName', 'shortCode', 'contactName', 'phone', 'email', 'city', 'address']}
          />
          <div className="border-l-2 border-slate-700 pl-3">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Anlaşma</h4>
            <dl className="text-slate-300">
              <Row label="tier" value={JSON.stringify(state.step2?.tier)} />
              <Row label="contractStartDate" value={JSON.stringify(state.step2?.contractStartDate)} />
              <Row label="Sözleşme Süresi" value={`${durationMonths} ay`} />
              <Row label="Yıllık Bakım Ücreti" value={`${monthlyFeeTl} TL`} />
              <Row label="salesPartner" value={JSON.stringify(state.step2?.salesPartner)} />
            </dl>
          </div>
          <Section title="Domain" data={state.step3} fields={['domain']} />
          <Section title="Şablon" data={state.step4} fields={['template', 'primaryColor', 'font']} />
          <Section title="Modüller" data={state.step5?.modules ?? {}} />
          <Section title="Diller" data={state.step5?.locale ?? {}} />
          <Section title="Sunucu" data={{ id: state.step6?.serverId }} />
        </div>
      </div>

      {/* Contract upload */}
      <div className="bg-slate-800 rounded-lg p-6">
        <h3 className="font-semibold text-slate-100 mb-3">Sözleşme PDF (denetim için saklanır)</h3>
        <input
          type="file"
          accept=".pdf"
          onChange={(e) => setContractFile(e.target.files?.[0] ?? null)}
          className="text-slate-300"
        />
        {contractFile && <p className="text-xs text-emerald-400 mt-2">✓ {contractFile.name} hazır</p>}
      </div>

      {/* Automatic checks panel — replaces the old "Deploy Checklist" */}
      <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-lg p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-emerald-100">Otomatik kontroller</h3>
          <span className="text-xs text-emerald-300/80">Sistem hallediyor</span>
        </div>
        <ul className="space-y-2">
          {AUTOMATIC_CHECKS.map((item) => (
            <li key={item.label} className="flex items-start gap-3 p-2 rounded">
              <span
                aria-hidden="true"
                className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600/30 text-emerald-300 text-sm"
              >
                ✓
              </span>
              <div className="leading-tight">
                <div className="text-sm text-emerald-50">{item.label}</div>
                <div className="text-xs text-emerald-300/70">{item.sub}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {error && <div className="bg-red-900/40 text-red-300 p-3 rounded">{error}</div>}

      <div className="flex justify-between pt-4">
        <button type="button" onClick={onBack} className="px-4 py-2 text-slate-300 hover:text-white">
          ← Geri
        </button>
        <button
          type="button"
          onClick={onDeploy}
          disabled={submitting}
          className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 px-8 py-3 rounded text-white font-semibold text-lg"
        >
          {submitting ? 'Deploy başlatılıyor...' : 'DEPLOY BAŞLAT 🚀'}
        </button>
      </div>
    </div>
  );
}

function Section({ title, data, fields }: { title: string; data: any; fields?: string[] }) {
  if (!data) return null;
  return (
    <div className="border-l-2 border-slate-700 pl-3">
      <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">{title}</h4>
      <dl className="text-slate-300">
        {(fields ?? Object.keys(data)).map((field) => (
          <div key={field} className="flex gap-2">
            <dt className="text-slate-500 text-xs">{field}:</dt>
            <dd className="text-xs">{JSON.stringify(data[field])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500 text-xs">{label}:</dt>
      <dd className="text-xs">{value}</dd>
    </div>
  );
}
