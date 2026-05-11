/**
 * Status badges/pills used throughout the operator panel.
 *
 * - `StatusPill`           — tenants.status (onboarding | active | paused | cancelled)
 * - `ContainerStatusPill`  — tenants.container_status (not_deployed | running | stopped | error)
 * - `DeployStatusPill`     — deployments.status (pending | in_progress | success | failed | rolled_back)
 * - `TierBadge`            — tenants.tier (baslangic | standart | profesyonel)
 *
 * All pills are server-component-safe (no hooks). Dark theme palette only —
 * V1 ships dark-only per IMPL §1.
 */

export type TenantStatus = 'onboarding' | 'active' | 'paused' | 'cancelled';
export type ContainerStatus = 'not_deployed' | 'running' | 'stopped' | 'error';
export type DeployStatus =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'rolled_back';
export type Tier = 'baslangic' | 'standart' | 'profesyonel';

const PILL_BASE = 'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium';

export function StatusPill({ status }: { status: TenantStatus }) {
  const config = {
    onboarding: { cls: 'bg-blue-900/40 text-blue-300', label: 'Onboarding' },
    active: { cls: 'bg-emerald-900/40 text-emerald-300', label: 'Aktif' },
    paused: { cls: 'bg-amber-900/40 text-amber-300', label: 'Duraklatıldı' },
    cancelled: { cls: 'bg-slate-700 text-slate-400', label: 'İptal' },
  }[status];
  return <span className={`${PILL_BASE} ${config.cls}`}>{config.label}</span>;
}

export function ContainerStatusPill({ status }: { status: ContainerStatus }) {
  const config = {
    not_deployed: { cls: 'bg-slate-700 text-slate-400', label: 'Deploy Edilmedi' },
    running: { cls: 'bg-emerald-900/40 text-emerald-300', label: 'Çalışıyor' },
    stopped: { cls: 'bg-amber-900/40 text-amber-300', label: 'Durduruldu' },
    error: { cls: 'bg-red-900/40 text-red-300', label: 'Hata' },
  }[status];
  return <span className={`${PILL_BASE} ${config.cls}`}>{config.label}</span>;
}

export function DeployStatusPill({ status }: { status: DeployStatus }) {
  const config = {
    pending: { cls: 'bg-slate-700 text-slate-300', label: 'Beklemede' },
    in_progress: { cls: 'bg-blue-900/40 text-blue-300', label: 'Devam Ediyor' },
    success: { cls: 'bg-emerald-900/40 text-emerald-300', label: 'Başarılı' },
    failed: { cls: 'bg-red-900/40 text-red-300', label: 'Başarısız' },
    rolled_back: { cls: 'bg-amber-900/40 text-amber-300', label: 'Geri Alındı' },
  }[status];
  return <span className={`${PILL_BASE} ${config.cls}`}>{config.label}</span>;
}

export function TierBadge({ tier }: { tier: Tier }) {
  const config = {
    baslangic: { cls: 'bg-slate-700 text-slate-200', label: 'Başlangıç' },
    standart: { cls: 'bg-indigo-900/40 text-indigo-300', label: 'Standart' },
    profesyonel: { cls: 'bg-purple-900/40 text-purple-300', label: 'Profesyonel' },
  }[tier];
  return <span className={`${PILL_BASE} ${config.cls}`}>{config.label}</span>;
}
