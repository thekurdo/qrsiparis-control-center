'use client';
import { useState, type FormEvent } from 'react';

export interface Step6Data { serverId: string; }

interface ServerOption {
  id: string;
  name: string;
  publicIp: string;
  publicHostname: string | null;
  status: string;
  currentTenantCount: number;
  maxTenantsTheoretical: number | null;
}

export function Step6Server({ data, servers, onNext, onBack }: { data?: Step6Data; servers: ServerOption[]; onNext: (d: Step6Data) => void; onBack: () => void }) {
  // Auto-suggest least-full server (not at cap, status active)
  const available = servers.filter(s => s.status === 'active' && s.currentTenantCount < (s.maxTenantsTheoretical ?? 20));
  const leastFull = available.sort((a, b) => a.currentTenantCount - b.currentTenantCount)[0];

  const [selectedId, setSelectedId] = useState(data?.serverId ?? leastFull?.id ?? '');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    onNext({ serverId: selectedId });
  }

  return (
    <form onSubmit={handleSubmit} className="bg-slate-800 rounded-lg p-6 space-y-4">
      <h2 className="text-lg font-semibold text-slate-100">Sunucu Ataması</h2>

      <div className="space-y-2">
        {servers.map(s => {
          const cap = s.maxTenantsTheoretical ?? 20;
          const isFull = s.currentTenantCount >= cap;
          const ratio = (s.currentTenantCount / cap) * 100;
          return (
            <label key={s.id} className={`flex items-start gap-3 p-3 rounded cursor-pointer transition-colors ${selectedId === s.id ? 'bg-blue-900/40 border-2 border-blue-500' : 'bg-slate-900 border-2 border-transparent'} ${isFull ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-700/50'}`}>
              <input type="radio" name="serverId" value={s.id} checked={selectedId === s.id} disabled={isFull} onChange={(e) => setSelectedId(e.target.value)} className="mt-1" />
              <div className="flex-1">
                <div className="flex justify-between">
                  <span className="font-medium text-slate-100">{s.name}</span>
                  {isFull && <span className="text-xs bg-red-900/40 text-red-300 px-2 py-0.5 rounded">DOLU</span>}
                  {!isFull && leastFull?.id === s.id && <span className="text-xs bg-emerald-900/40 text-emerald-300 px-2 py-0.5 rounded">Önerilen</span>}
                </div>
                <p className="text-sm text-slate-400 font-mono">{s.publicIp}{s.publicHostname ? ` · ${s.publicHostname}` : ''}</p>
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>Müşteri: {s.currentTenantCount}/{cap}</span>
                  </div>
                  <div className="h-1.5 bg-slate-800 rounded overflow-hidden">
                    <div className={`h-full ${ratio < 60 ? 'bg-emerald-500' : ratio < 80 ? 'bg-amber-500' : 'bg-red-500'}`} style={{width: `${ratio}%`}} />
                  </div>
                </div>
              </div>
            </label>
          );
        })}
        {available.length === 0 && (
          <div className="text-center py-8 text-slate-400">
            <p>Müsait sunucu yok. <a href="/sunucular/yeni" className="text-blue-400 hover:underline">Yeni sunucu ekle</a></p>
          </div>
        )}
      </div>

      <div className="flex justify-between pt-4">
        <button type="button" onClick={onBack} className="px-4 py-2 text-slate-300 hover:text-white">← Geri</button>
        <button type="submit" disabled={!selectedId} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-6 py-2 rounded text-white font-medium">İleri →</button>
      </div>
    </form>
  );
}
