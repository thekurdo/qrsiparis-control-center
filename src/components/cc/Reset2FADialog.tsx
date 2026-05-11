'use client';

/**
 * Reset2FADialog — confirms 2FA reset for an operator user (Phase H10).
 *
 * Triggered from <OperatorUserListClient> action menu. POSTs to
 * `/api/internal/operator-users/:id/reset-2fa` which:
 *   - clears `two_factor_secret`
 *   - empties `two_factor_backup_codes`
 *   - sets `two_factor_enabled = false`
 *   - writes audit `operator_user.2fa_reset`
 *
 * UX rules:
 *   - The operator MUST type the username to confirm — defends against
 *     fat-finger clicks on the "Sıfırla" button.
 *   - On success, parent receives `onDone()` and the row in the list
 *     refreshes.
 *
 * Backup codes destruction is explicit copy: "Backup kodları geçersiz
 * olacak ve tekrar kurmak zorundalar." — the admin must understand this.
 */

import { useEffect, useRef, useState } from 'react';

export function Reset2FADialog({
  userId,
  username,
  onClose,
  onDone,
}: {
  userId: string;
  username: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const matches = confirmText.trim() === username;

  async function handleConfirm() {
    if (!matches) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/internal/operator-users/${userId}/reset-2fa`,
        { method: 'POST' },
      );
      const json = (await res.json()) as {
        success: boolean;
        error?: { message: string };
      };
      if (!json.success) {
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

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset2fa-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
        <h2
          id="reset2fa-title"
          className="text-lg font-semibold text-slate-100"
        >
          2FA&apos;yı Sıfırla
        </h2>
        <p className="text-sm text-slate-300">
          <span className="font-mono">{username}</span> kullanıcısının
          2FA&apos;sını sıfırla?
        </p>
        <div className="bg-amber-900/30 border border-amber-700 rounded-md px-3 py-2 text-xs text-amber-200">
          Backup kodları geçersiz olacak ve kullanıcı 2FA&apos;yı tekrar
          kurmak zorundalar.
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Onaylamak için kullanıcı adını yazın:
          </label>
          <input
            ref={inputRef}
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={username}
            className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none font-mono"
          />
        </div>
        {error ? (
          <p className="text-xs text-red-400">{error}</p>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-slate-100 text-sm disabled:opacity-60"
          >
            İptal
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!matches || submitting}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-white font-medium text-sm"
          >
            {submitting ? 'Sıfırlanıyor...' : 'Sıfırla'}
          </button>
        </div>
      </div>
    </div>
  );
}
