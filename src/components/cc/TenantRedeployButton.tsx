'use client';

/**
 * TenantRedeployButton — "Yeniden Dağıt" action on the tenant detail page.
 *
 * Posts to /api/internal/deployments with deploymentType='redeploy'. The
 * redeploy pipeline (initial→precheck→redeploy-trigger→container-start→
 * health-check) restarts the existing container with the same image + the
 * same `config_snapshot` — useful when a tenant container is stuck or the
 * operator wants to force-restart after an upstream incident.
 *
 * Disabled states:
 *   - status='cancelled' (the API returns BUSINESS_RULE_VIOLATION anyway
 *     but disabling client-side gives operators immediate feedback).
 *   - container_status='not_deployed' (no container to restart — operator
 *     needs to run the initial deploy via the wizard).
 *
 * On success → router.push(`/deployments/{deploymentId}`) so the operator
 * sees the live SSE log. On 409 CONFLICT we surface the existing
 * deployment's id and the operator can click through to its log instead.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  TenantStatus,
  TenantContainerStatus,
} from '@/types/db';

interface ApiResponse {
  success: boolean;
  data?: { deploymentId: string };
  error?: {
    code: string;
    message: string;
    details?: { deploymentId?: string };
  };
}

export function TenantRedeployButton({
  tenantId,
  status,
  containerStatus,
}: {
  tenantId: string;
  status: TenantStatus;
  containerStatus: TenantContainerStatus;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled =
    status === 'cancelled' || containerStatus === 'not_deployed' || submitting;

  async function handleClick() {
    if (disabled) return;
    if (
      !window.confirm(
        'Müşteri konteyneri aynı imaj + aynı konfig ile yeniden başlatılacak. Devam edilsin mi?',
      )
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/internal/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          deploymentType: 'redeploy',
          triggerReason: 'Operator-driven redeploy (panel)',
        }),
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || !json.success || !json.data) {
        const fallbackId = json.error?.details?.deploymentId;
        if (fallbackId) {
          // Already in flight — jump to its log instead of erroring out.
          router.push(`/deployments/${fallbackId}`);
          return;
        }
        setError(json.error?.message ?? 'Yeniden dağıtım başlatılamadı');
        setSubmitting(false);
        return;
      }
      router.push(`/deployments/${json.data.deploymentId}`);
    } catch {
      setError('Sunucuya ulaşılamadı');
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        data-testid="tenant-action-redeploy"
        className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm text-white font-medium"
        title={
          status === 'cancelled'
            ? 'İptal edilmiş müşteri için yeniden dağıtım yapılamaz'
            : containerStatus === 'not_deployed'
              ? 'Konteyner yok — önce ilk kurulumu yap'
              : undefined
        }
      >
        {submitting ? 'Başlatılıyor...' : 'Yeniden Dağıt'}
      </button>
      {error ? (
        <p
          className="text-xs text-red-400 mt-1 w-full"
          data-testid="tenant-redeploy-error"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
