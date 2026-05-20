'use client';

/**
 * DeploymentDetailClient — interactive deploy detail page (Phase H8).
 *
 * Server component (page.tsx) hydrates this with the joined deployment row
 * and we render:
 *   - Header: deploymentType + status pill + tenant + server + triggered by
 *   - Step progress card — one row per pipeline step. We parse the live
 *     log buffer for `step.start <NAME>`, `step.done <NAME>`, and
 *     `step.failed` markers (emitted by `runPipeline()`) so the chip
 *     state always matches the current pipeline frame.
 *   - <DeploymentLogStream> — live SSE log streamer
 *   - Action buttons (TR copy, V1 vs V1.5 split):
 *       active   → İptal Et (V1.5 stub), Logu İndir (handled inside stream)
 *       failed   → Otomatik Rollback (V1.5), Manuel Müdahale,
 *                  Yeniden Dene (POST /api/internal/deployments),
 *                  Müşteri Olarak Kapat (V1.5)
 *       success  → Müşteriye Git (link)
 *
 * Yeniden Dene posts a fresh deployment with the same tenant + type, then
 * navigates to the new deployment's detail page so the operator can watch
 * the retry live.
 *
 * Step list: only the `initial` deploy type has all 10 steps wired in V1.
 * Other types either no-op (V1.5) or have shorter step lists — we render
 * the appropriate template based on `deploymentType`.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import {
  DeployStatusPill,
  type DeployStatus,
} from '@/components/StatusPill';
import type { DeploymentType } from '@/types/db';

import { DeploymentLogStream } from './DeploymentLogStream';

// ---------------------------------------------------------------------------
// Server-shipped row shape (must mirror page.tsx select projection)
// ---------------------------------------------------------------------------
export interface DeploymentDetailRow {
  deploymentId: string;
  deploymentType: DeploymentType;
  status: DeployStatus;
  appVersion: string;
  configVersion: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationSeconds: number | null;
  triggerReason: string | null;
  log: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  createdAt: Date;
  tenantId: string | null;
  tenantName: string | null;
  tenantShortCode: string | null;
  tenantDomain: string | null;
  serverId: string | null;
  serverName: string | null;
  serverPublicIp: string | null;
  triggeredByUsername: string | null;
  triggeredByFullName: string | null;
}

// Step labels per deploy type — order matches src/lib/deploy/steps/index.ts.
// The string values match the `step.start <NAME>` markers emitted by
// runPipeline so we can parse progress out of the live log.
const STEP_TEMPLATES: Record<DeploymentType, ReadonlyArray<{ name: string; label: string }>> = {
  initial: [
    { name: 'PRECHECK', label: 'Ön Kontrol' },
    { name: 'CONFIG_GENERATE', label: 'Konfigürasyon Üret' },
    { name: 'COOLIFY_APP_CREATE', label: 'Coolify Uygulaması Oluştur' },
    { name: 'DOCKER_IMAGE_PULL', label: 'Docker Image Pull' },
    { name: 'CONFIG_INJECT', label: 'Konfigürasyon Yaz' },
    { name: 'CONTAINER_START', label: 'Container Başlat' },
    { name: 'HEALTH_CHECK', label: 'Sağlık Kontrolü' },
    { name: 'SSL_CERTIFICATE', label: 'SSL Sertifika' },
    { name: 'DOMAIN_VERIFICATION', label: 'Domain Doğrulama' },
    { name: 'POST_DEPLOY', label: 'Sonrası İşlemler' },
  ],
  config_update: [
    { name: 'CONFIG_GENERATE', label: 'Konfigürasyon Üret' },
    { name: 'CONFIG_INJECT', label: 'Konfigürasyon Yaz' },
    { name: 'CONTAINER_RESTART', label: 'Container Yeniden Başlat' },
    { name: 'HEALTH_CHECK', label: 'Sağlık Kontrolü' },
  ],
  app_update: [
    { name: 'PRECHECK', label: 'Ön Kontrol' },
    { name: 'DOCKER_IMAGE_PULL', label: 'Docker Image Pull' },
    { name: 'CONTAINER_RESTART', label: 'Container Yeniden Başlat' },
    { name: 'HEALTH_CHECK', label: 'Sağlık Kontrolü' },
  ],
  redeploy: [
    { name: 'CONTAINER_RESTART', label: 'Container Yeniden Başlat' },
    { name: 'HEALTH_CHECK', label: 'Sağlık Kontrolü' },
  ],
  rollback: [
    { name: 'ROLLBACK_PREP', label: 'Rollback Hazırlık' },
    { name: 'CONTAINER_RESTART', label: 'Container Yeniden Başlat' },
    { name: 'HEALTH_CHECK', label: 'Sağlık Kontrolü' },
  ],
};

type StepState = 'pending' | 'running' | 'done' | 'failed';

function parseStepStates(
  log: string | null,
  deploymentStatus: DeployStatus,
  template: ReadonlyArray<{ name: string; label: string }>,
): Record<string, StepState> {
  const result: Record<string, StepState> = {};
  for (const s of template) result[s.name] = 'pending';

  if (!log) return result;

  // Walk lines and toggle state. The pipeline emits, in order:
  //   `step.start <NAME>` → mark running
  //   `step.done  <NAME>` → mark done
  //   `step.failed ...`   → mark current (last running) failed
  const lines = log.split('\n');
  let lastRunning: string | null = null;

  for (const line of lines) {
    // The format is `[ts] [level] step.start NAME` so we just split on
    // whitespace and look at the last two tokens.
    const startMatch = line.match(/step\.start\s+([A-Z_][A-Z0-9_]*)/);
    if (startMatch && startMatch[1]) {
      const n = startMatch[1];
      if (n in result) {
        result[n] = 'running';
        lastRunning = n;
      }
      continue;
    }
    const doneMatch = line.match(/step\.done\s+([A-Z_][A-Z0-9_]*)/);
    if (doneMatch && doneMatch[1]) {
      const n = doneMatch[1];
      if (n in result) {
        result[n] = 'done';
      }
      if (lastRunning === n) lastRunning = null;
      continue;
    }
    if (/step\.failed\b/.test(line) && lastRunning && lastRunning in result) {
      result[lastRunning] = 'failed';
    }
  }

  // Cap any lingering 'running' state once the deployment is terminal.
  if (
    deploymentStatus === 'success' ||
    deploymentStatus === 'failed' ||
    deploymentStatus === 'rolled_back'
  ) {
    for (const k of Object.keys(result)) {
      if (result[k] === 'running') {
        result[k] = deploymentStatus === 'success' ? 'done' : 'failed';
      }
    }
  }
  return result;
}

const DEPLOY_TYPE_LABELS: Record<DeploymentType, string> = {
  initial: 'İlk Kurulum',
  config_update: 'Konfigürasyon Güncelleme',
  app_update: 'Uygulama Güncelleme',
  redeploy: 'Yeniden Dağıt',
  rollback: 'Geri Alma',
};

function formatDateTime(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('tr-TR');
}

export function DeploymentDetailClient({
  initial,
}: {
  initial: DeploymentDetailRow;
}) {
  const router = useRouter();
  const [retryPending, setRetryPending] = useState(false);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);

  const isActive =
    initial.status === 'pending' || initial.status === 'in_progress';
  const isFailed = initial.status === 'failed';
  const isSuccess = initial.status === 'success';

  const template = STEP_TEMPLATES[initial.deploymentType];

  // Re-parse step states whenever the persisted log changes. The live
  // SSE stream updates the *log column* on the next flushLogs, so the
  // step row truth comes from the persisted log; the SSE pane is the
  // live tail. When the page is refreshed via router.refresh() we get
  // the latest persisted log and re-derive step states from there.
  const stepStates = useMemo(
    () => parseStepStates(initial.log, initial.status, template),
    [initial.log, initial.status, template],
  );

  async function handleRetry() {
    if (!initial.tenantId) {
      setBanner({ kind: 'error', text: 'Müşteri bilgisi eksik.' });
      return;
    }
    setRetryPending(true);
    try {
      const res = await fetch('/api/internal/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: initial.tenantId,
          deploymentType: initial.deploymentType,
          appVersion: initial.appVersion,
          triggerReason: `retry of ${initial.deploymentId}`,
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { deploymentId?: string };
        error?: { message: string };
      };
      if (!json.success) {
        setBanner({
          kind: 'error',
          text: json.error?.message ?? 'Yeniden deneme başarısız.',
        });
        return;
      }
      const newId = json.data?.deploymentId;
      if (newId) {
        router.push(`/deployments/${newId}`);
      } else {
        router.refresh();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Sunucuya ulaşılamadı.' });
    } finally {
      setRetryPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href="/deployments"
        className="text-blue-400 text-sm hover:underline"
      >
        ← Deployments
      </Link>

      {banner ? (
        <div
          className={`px-4 py-3 rounded-md text-sm border ${
            banner.kind === 'success'
              ? 'bg-emerald-900/30 border-emerald-700 text-emerald-200'
              : 'bg-red-900/30 border-red-700 text-red-200'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{banner.text}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Kapat
            </button>
          </div>
        </div>
      ) : null}

      <header className="bg-slate-800 border border-slate-700 rounded-lg p-5">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold text-slate-100">
                {DEPLOY_TYPE_LABELS[initial.deploymentType]}
              </h1>
              <DeployStatusPill status={initial.status} />
              <span className="text-xs text-slate-500 font-mono">
                {initial.deploymentId.slice(0, 8)}
              </span>
            </div>
            <div className="text-sm text-slate-400 space-y-1">
              <div>
                Müşteri:{' '}
                {initial.tenantId ? (
                  <Link
                    href={`/musteriler/${initial.tenantId}`}
                    className="text-slate-200 hover:underline"
                  >
                    {initial.tenantName ?? '—'}
                  </Link>
                ) : (
                  <span className="text-slate-200">{initial.tenantName ?? '—'}</span>
                )}
                {initial.tenantShortCode ? (
                  <span className="text-xs text-slate-500 font-mono ml-2">
                    {initial.tenantShortCode}
                  </span>
                ) : null}
              </div>
              <div>
                Sunucu:{' '}
                {initial.serverId ? (
                  <Link
                    href={`/sunucular/${initial.serverId}`}
                    className="text-slate-200 hover:underline"
                  >
                    {initial.serverName ?? '—'}
                  </Link>
                ) : (
                  <span className="text-slate-200">{initial.serverName ?? '—'}</span>
                )}
                {initial.serverPublicIp ? (
                  <span className="text-xs text-slate-500 font-mono ml-2">
                    {initial.serverPublicIp}
                  </span>
                ) : null}
              </div>
              <div>
                Tetikleyen:{' '}
                <span className="text-slate-200">
                  {initial.triggeredByFullName ??
                    initial.triggeredByUsername ??
                    '—'}
                </span>
                {initial.triggeredByUsername ? (
                  <span className="text-xs text-slate-500 font-mono ml-2">
                    {initial.triggeredByUsername}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <DetailMetaGrid initial={initial} />
        </div>

        {initial.errorCode || initial.errorMessage ? (
          <div className="mt-4 px-4 py-3 bg-red-900/30 border border-red-700/60 rounded text-sm text-red-200">
            {initial.errorCode ? (
              <div className="font-mono text-xs uppercase tracking-wide text-red-300 mb-1">
                {initial.errorCode}
              </div>
            ) : null}
            {initial.errorMessage ? <div>{initial.errorMessage}</div> : null}
          </div>
        ) : null}

        {initial.triggerReason ? (
          <div className="mt-3 text-xs text-slate-400">
            <span className="text-slate-500">Tetikleme nedeni:</span>{' '}
            {initial.triggerReason}
          </div>
        ) : null}
      </header>

      {/* Active deploy progress indicator — spinner + live elapsed counter.
          Renders only while the deployment is pending/in_progress. We pick
          `startedAt ?? createdAt` as the anchor so the counter is meaningful
          even if the BullMQ worker hasn't yet flipped status to in_progress
          (the row exists from the moment the POST commits). */}
      {isActive ? (
        <ActiveDeploymentBanner
          anchor={initial.startedAt ?? initial.createdAt}
          status={initial.status}
        />
      ) : null}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        {isActive ? (
          <>
            <button
              type="button"
              disabled
              className="px-3 py-2 bg-amber-700 opacity-50 rounded text-sm cursor-not-allowed text-amber-100"
              title="V1.5"
            >
              İptal Et (V1.5)
            </button>
          </>
        ) : null}
        {isFailed ? (
          <>
            <button
              type="button"
              disabled
              className="px-3 py-2 bg-amber-700 opacity-50 rounded text-sm cursor-not-allowed text-amber-100"
              title="V1.5"
            >
              Otomatik Rollback (V1.5)
            </button>
            <button
              type="button"
              disabled
              className="px-3 py-2 bg-slate-700 opacity-50 rounded text-sm cursor-not-allowed text-slate-200"
              title="V1.5"
            >
              Manuel Müdahale (V1.5)
            </button>
            <button
              type="button"
              onClick={handleRetry}
              disabled={retryPending || !initial.tenantId}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {retryPending ? 'Gönderiliyor...' : 'Yeniden Dene'}
            </button>
            <button
              type="button"
              disabled
              className="px-3 py-2 bg-red-900/40 opacity-50 rounded text-sm cursor-not-allowed text-red-200"
              title="V1.5"
            >
              Müşteri Olarak Kapat (V1.5)
            </button>
          </>
        ) : null}
        {isSuccess && initial.tenantId ? (
          <Link
            href={`/musteriler/${initial.tenantId}`}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white font-medium"
          >
            Müşteriye Git
          </Link>
        ) : null}
        {initial.tenantDomain ? (
          <a
            href={`https://${initial.tenantDomain}`}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-100"
          >
            Domain Aç ↗
          </a>
        ) : null}
      </div>

      {/* Step progress */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-5">
        <h2 className="font-semibold text-slate-100 mb-4">
          Adımlar ({template.length})
        </h2>
        <ol className="space-y-2">
          {template.map((s, idx) => {
            const state = stepStates[s.name] ?? 'pending';
            return (
              <li
                key={s.name}
                className="flex items-center gap-3 px-3 py-2 bg-slate-900/40 rounded"
              >
                <StepIcon state={state} index={idx + 1} />
                <div className="flex-1">
                  <div className="text-sm text-slate-200">{s.label}</div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    {s.name}
                  </div>
                </div>
                <StepStateBadge state={state} />
              </li>
            );
          })}
        </ol>
      </div>

      {/* Live log */}
      <DeploymentLogStream
        deploymentId={initial.deploymentId}
        initialLog={initial.log}
        isActive={isActive}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline subcomponents
// ---------------------------------------------------------------------------

function DetailMetaGrid({ initial }: { initial: DeploymentDetailRow }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-400">
      <dt>Versiyon</dt>
      <dd className="text-slate-200 font-mono">{initial.appVersion}</dd>
      <dt>Config v</dt>
      <dd className="text-slate-200 font-mono">
        {initial.configVersion ?? '—'}
      </dd>
      <dt>Oluşturuldu</dt>
      <dd className="text-slate-200">{formatDateTime(initial.createdAt)}</dd>
      <dt>Başladı</dt>
      <dd className="text-slate-200">{formatDateTime(initial.startedAt)}</dd>
      <dt>Tamamlandı</dt>
      <dd className="text-slate-200">{formatDateTime(initial.completedAt)}</dd>
      <dt>Süre</dt>
      <dd className="text-slate-200 tabular-nums">
        {initial.durationSeconds !== null && initial.durationSeconds !== undefined
          ? `${initial.durationSeconds}s`
          : '—'}
      </dd>
    </dl>
  );
}

function StepIcon({ state, index }: { state: StepState; index: number }) {
  if (state === 'done') {
    return (
      <span
        className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-900/60 text-emerald-300 text-xs"
        aria-label="Tamamlandı"
      >
        ✓
      </span>
    );
  }
  if (state === 'running') {
    return (
      <span
        className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-900/60 text-blue-300 text-xs animate-pulse"
        aria-label="Devam ediyor"
      >
        ●
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span
        className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-900/60 text-red-300 text-xs"
        aria-label="Başarısız"
      >
        ✗
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-700 text-slate-400 text-xs tabular-nums"
      aria-label="Beklemede"
    >
      {index}
    </span>
  );
}

/**
 * ActiveDeploymentBanner — pending/in_progress indicator with elapsed
 * counter (Phase H8 follow-up).
 *
 * Renders a single horizontal strip with:
 *   - a CSS-animated spinner (no external assets — pure border trick)
 *   - the deployment's current status pill (verbose, e.g. "Sırada" vs
 *     "Devam ediyor")
 *   - a tabular-nums "Xs / Xm Ys" elapsed counter rooted at the supplied
 *     `anchor` timestamp. The counter increments client-side via a 1s
 *     interval so the operator gets a live "since trigger" pulse without
 *     polling the server.
 *
 * The interval is cleaned up on unmount AND when `anchor`/`status` change
 * so React's StrictMode double-mount doesn't leave a leaked timer behind.
 */
function ActiveDeploymentBanner({
  anchor,
  status,
}: {
  anchor: Date | null;
  status: DeployStatus;
}) {
  // Re-render every second so the elapsed counter ticks. We deliberately
  // store the elapsed seconds in state (rather than computing inside the
  // render with `Date.now()` and relying on a separate forceUpdate) so
  // React batches the re-renders cleanly and the value is stable across
  // child renders.
  const [elapsedSec, setElapsedSec] = useState<number>(() =>
    computeElapsedSec(anchor),
  );

  useEffect(() => {
    // Compute once immediately so the first paint shows the right value
    // (state init runs on mount but `anchor` might have changed between
    // mount and the first effect cycle).
    setElapsedSec(computeElapsedSec(anchor));
    const id = setInterval(() => {
      setElapsedSec(computeElapsedSec(anchor));
    }, 1000);
    return () => clearInterval(id);
    // `status` is in the deps so the timer is rebuilt when the deploy
    // transitions pending → in_progress (the anchor might shift then).
  }, [anchor, status]);

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-blue-950/40 border border-blue-800/60 rounded-lg">
      <span
        className="inline-block w-4 h-4 rounded-full border-2 border-blue-300 border-t-transparent animate-spin"
        aria-label="Yükleniyor"
        role="status"
      />
      <div className="flex-1 text-sm text-blue-100">
        <span className="font-semibold">
          {status === 'pending' ? 'Kuyruğa alındı' : 'Devam ediyor'}
        </span>
        <span className="text-blue-300/80 ml-2">
          — pipeline {status === 'pending' ? 'başlatılıyor' : 'çalışıyor'}…
        </span>
      </div>
      <span className="text-xs text-blue-200 tabular-nums font-mono">
        {formatElapsed(elapsedSec)}
      </span>
    </div>
  );
}

function computeElapsedSec(anchor: Date | null): number {
  if (!anchor) return 0;
  const t = anchor instanceof Date ? anchor.getTime() : new Date(anchor).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function StepStateBadge({ state }: { state: StepState }) {
  const config = {
    pending: { cls: 'text-slate-500', label: 'Beklemede' },
    running: { cls: 'text-blue-300', label: 'Devam ediyor' },
    done: { cls: 'text-emerald-300', label: 'Tamamlandı' },
    failed: { cls: 'text-red-300', label: 'Hata' },
  }[state];
  return <span className={`text-xs ${config.cls}`}>{config.label}</span>;
}
