'use client';

/**
 * TenantLifecycleActions — pause / resume / cancel buttons for the tenant
 * detail page (Scenario S13).
 *
 * Surfaces three actions, conditionally enabled based on `tenant.status`:
 *   - "Duraklat" (Pause)   — enabled when status='active'
 *   - "Yeniden Aç" (Resume)— enabled when status='paused'
 *   - "İptal Et" (Cancel)  — enabled when status in {onboarding, active, paused}
 *
 * Cancellation is destructive (the row stays but new deploys are blocked
 * by `/api/internal/deployments` and all crons skip cancelled tenants).
 * To defend against fat-finger clicks we use a 2-step confirm modal:
 *   Step 1: Operator clicks "İptal Et" → modal opens.
 *   Step 2: Modal requires typing the literal string "İPTAL ET" (Turkish
 *           upper-case for "CANCEL"). The "Onayla" button stays disabled
 *           until that string matches exactly.
 *
 * Pause and Resume use simple one-click confirmations (same dialog
 * scaffold, no typed challenge) because they're reversible.
 *
 * On success the dialog closes and we `router.refresh()` so the server
 * component re-renders with the updated tenant.status + recent audit
 * rows. We don't fully reload the page — `router.refresh()` is the
 * canonical Next.js App Router idiom and preserves scroll position.
 *
 * --- WHY ONE CLIENT COMPONENT WITH THREE DIALOG VARIANTS ---
 * Splitting into 3 dialog components (PauseDialog, ResumeDialog,
 * CancelDialog) felt over-modeled — the only meaningful difference is
 * the typed-challenge for Cancel. We keep this as one component with a
 * mode prop on the inner Dialog to minimise duplication. The
 * `ResetPasswordDialog` / `Reset2FADialog` pattern in /sistem/kullanicilar
 * is more standalone because they have wildly different bodies (password
 * reveal vs username re-type); the lifecycle dialogs all show "are you
 * sure" copy.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { TenantStatus } from '@/types/db';

export type LifecycleAction = 'pause' | 'resume' | 'cancel';

interface LifecycleApiResponse {
  success: boolean;
  data?: { id: string; status: TenantStatus; coolifyError: string | null };
  error?: { code: string; message: string };
}

const ACTION_LABEL: Record<LifecycleAction, string> = {
  pause: 'Duraklat',
  resume: 'Yeniden Aç',
  cancel: 'İptal Et',
};

const ACTION_BODY: Record<LifecycleAction, string> = {
  pause:
    'Müşteri konteynerı durdurulacak ve site geçici olarak erişilemez olacak. Devam Et tıklayarak müşteriyi tekrar açabilirsiniz.',
  resume:
    'Müşteri konteynerı yeniden başlatılacak ve site tekrar erişilebilir olacak.',
  cancel:
    'Bu işlem geri alınamaz. Müşterinin konteynerı silinecek, yeni dağıtımlar engellenecek, otomatik yedek/sözleşme cron job’ları artık çalışmayacak. Veri silinmez (kayıt durum=cancelled olur).',
};

const ACTION_BUTTON_STYLE: Record<LifecycleAction, string> = {
  // Pause: amber — caution but reversible.
  pause:
    'bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed',
  // Resume: blue — positive, the system's primary brand colour.
  resume:
    'bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed',
  // Cancel: red — destructive.
  cancel:
    'bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed',
};

export function TenantLifecycleActions({
  tenantId,
  status,
}: {
  tenantId: string;
  status: TenantStatus;
}) {
  const router = useRouter();
  const [activeAction, setActiveAction] = useState<LifecycleAction | null>(
    null,
  );

  // Action availability map. We render all three buttons always (so
  // operators can see the available actions at a glance even when
  // disabled) and gate them via `disabled`.
  const canPause = status === 'active';
  const canResume = status === 'paused';
  const canCancel =
    status === 'onboarding' || status === 'active' || status === 'paused';

  function handleClose() {
    setActiveAction(null);
  }

  function handleSuccess() {
    setActiveAction(null);
    // router.refresh() re-renders the surrounding server component so
    // the new tenant.status / containerStatus / audit-trail strip
    // reflect immediately. We don't navigate away from the detail page.
    router.refresh();
  }

  return (
    <div
      className="flex flex-wrap gap-2"
      data-testid="tenant-lifecycle-actions"
      data-tenant-status={status}
    >
      <button
        type="button"
        onClick={() => setActiveAction('pause')}
        disabled={!canPause}
        data-testid="tenant-action-pause"
        className={`px-3 py-2 rounded text-sm text-white font-medium ${ACTION_BUTTON_STYLE.pause}`}
      >
        {ACTION_LABEL.pause}
      </button>
      <button
        type="button"
        onClick={() => setActiveAction('resume')}
        disabled={!canResume}
        data-testid="tenant-action-resume"
        className={`px-3 py-2 rounded text-sm text-white font-medium ${ACTION_BUTTON_STYLE.resume}`}
      >
        {ACTION_LABEL.resume}
      </button>
      <button
        type="button"
        onClick={() => setActiveAction('cancel')}
        disabled={!canCancel}
        data-testid="tenant-action-cancel"
        className={`px-3 py-2 rounded text-sm text-white font-medium ${ACTION_BUTTON_STYLE.cancel}`}
      >
        {ACTION_LABEL.cancel}
      </button>

      {activeAction ? (
        <LifecycleDialog
          tenantId={tenantId}
          action={activeAction}
          onClose={handleClose}
          onDone={handleSuccess}
        />
      ) : null}
    </div>
  );
}

/**
 * Confirmation dialog. For cancel we require a typed "İPTAL ET" challenge
 * before enabling the confirm button — a 2-step destructive guard.
 *
 * For pause / resume the body is plain "Onayla / İptal" with one click.
 *
 * Layout copies `ResetPasswordDialog` / `Reset2FADialog`:
 *   - Fixed-positioned overlay (`bg-black/60`) covering the whole viewport
 *   - Centred panel (`max-w-md`) with header / body / footer
 *   - Click-outside-to-close (only on the overlay, not the panel itself)
 *   - Escape key closes
 */
function LifecycleDialog({
  tenantId,
  action,
  onClose,
  onDone,
}: {
  tenantId: string;
  action: LifecycleAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Cancel needs the operator to type the challenge before "Onayla"
  // enables. The match is exact (trim + identity); we use Turkish upper
  // case so the cue text on the page and the typed value are visually
  // identical (no case folding needed).
  const REQUIRED_CONFIRM_TEXT = 'İPTAL ET';
  const challengePassed =
    action !== 'cancel' || confirmText.trim() === REQUIRED_CONFIRM_TEXT;

  useEffect(() => {
    if (action === 'cancel') {
      inputRef.current?.focus();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, action]);

  async function handleConfirm() {
    if (submitting) return;
    if (!challengePassed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/tenants/${tenantId}/${action}`, {
        method: 'POST',
      });
      const json = (await res.json()) as LifecycleApiResponse;
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'İşlem başarısız.');
        return;
      }
      onDone();
    } catch {
      setError('Sunucuya ulaşılamadı.');
    } finally {
      setSubmitting(false);
    }
  }

  const isCancel = action === 'cancel';
  const titleId = `lifecycle-${action}-title`;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid={`lifecycle-dialog-${action}`}
    >
      <div className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
        <h2 id={titleId} className="text-lg font-semibold text-slate-100">
          {ACTION_LABEL[action]}
        </h2>

        <p className="text-sm text-slate-300">{ACTION_BODY[action]}</p>

        {isCancel ? (
          <div>
            <p className="text-xs text-slate-400 mb-1">
              Onaylamak için{' '}
              <span className="font-mono font-semibold text-red-300">
                {REQUIRED_CONFIRM_TEXT}
              </span>{' '}
              yazın:
            </p>
            <input
              ref={inputRef}
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={REQUIRED_CONFIRM_TEXT}
              data-testid="lifecycle-confirm-input"
              className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-red-500 focus:outline-none font-mono"
            />
          </div>
        ) : null}

        {error ? (
          <p className="text-xs text-red-400" data-testid="lifecycle-error">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-slate-100 text-sm disabled:opacity-60"
          >
            Vazgeç
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!challengePassed || submitting}
            data-testid="lifecycle-confirm-button"
            className={`px-4 py-2 rounded text-white font-medium text-sm ${
              isCancel
                ? 'bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed'
            }`}
          >
            {submitting
              ? 'İşleniyor...'
              : isCancel
                ? 'Onayla ve İptal Et'
                : 'Onayla'}
          </button>
        </div>
      </div>
    </div>
  );
}
