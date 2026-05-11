'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

interface DeployChecklist { dnsConfigured: boolean; sslReady: boolean; containerHealthcheck: boolean; loginUrlVerified: boolean; assetsUploaded: boolean; sponsoredEmailSent: boolean; }

export function Step7Review({ state, onBack, onDeploy, submitting, error }: { state: any; onBack: () => void; onDeploy: () => void; submitting: boolean; error?: string | null }) {
  const [checklist, setChecklist] = useState<DeployChecklist>({ dnsConfigured: false, sslReady: false, containerHealthcheck: false, loginUrlVerified: false, assetsUploaded: false, sponsoredEmailSent: false });
  const [contractFile, setContractFile] = useState<File | null>(null);

  // Required: at least DNS + SSL + container per spec; relaxed for V1
  const allChecked = checklist.dnsConfigured && checklist.sslReady && checklist.containerHealthcheck;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="bg-slate-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">Özet</h2>
        <div className="space-y-3 text-sm">
          <Section title="Restoran" data={state.step1} fields={['restaurantName', 'shortCode', 'contactName', 'phone', 'email', 'city', 'address']} />
          <Section title="Anlaşma" data={state.step2} fields={['tier', 'contractStartDate', 'durationMonths', 'monthlyFeeKurus', 'salesPartner']} />
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
        <input type="file" accept=".pdf" onChange={(e) => setContractFile(e.target.files?.[0] ?? null)} className="text-slate-300" />
        {contractFile && <p className="text-xs text-emerald-400 mt-2">✓ {contractFile.name} hazır</p>}
      </div>

      {/* Deploy checklist */}
      <div className="bg-slate-800 rounded-lg p-6">
        <h3 className="font-semibold text-slate-100 mb-3">Deploy Checklist</h3>
        <div className="space-y-2">
          {[
            { key: 'dnsConfigured', label: 'DNS yapılandırıldı (CNAME / A record)', required: true },
            { key: 'sslReady', label: 'SSL hazır (Let\'s Encrypt otomatik)', required: true },
            { key: 'containerHealthcheck', label: 'Container health check geçer', required: true },
            { key: 'loginUrlVerified', label: 'Login URL erişilebilir', required: false },
            { key: 'assetsUploaded', label: 'Asset\'ler yüklendi (logo, ikonlar)', required: false },
            { key: 'sponsoredEmailSent', label: 'Hoşgeldin e-postası gönderildi', required: false },
          ].map(item => (
            <label key={item.key} className="flex items-center gap-3 p-2 cursor-pointer hover:bg-slate-700/30 rounded">
              <input type="checkbox" checked={checklist[item.key as keyof DeployChecklist]} onChange={(e) => setChecklist({ ...checklist, [item.key]: e.target.checked })} className="w-4 h-4" />
              <span className="text-slate-200 text-sm">{item.label}{item.required && ' *'}</span>
            </label>
          ))}
        </div>
      </div>

      {error && <div className="bg-red-900/40 text-red-300 p-3 rounded">{error}</div>}

      <div className="flex justify-between pt-4">
        <button type="button" onClick={onBack} className="px-4 py-2 text-slate-300 hover:text-white">← Geri</button>
        <button type="button" onClick={onDeploy} disabled={submitting || !allChecked} className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 px-8 py-3 rounded text-white font-semibold text-lg">
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
        {(fields ?? Object.keys(data)).map(field => (
          <div key={field} className="flex gap-2">
            <dt className="text-slate-500 text-xs">{field}:</dt>
            <dd className="text-xs">{JSON.stringify(data[field])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
