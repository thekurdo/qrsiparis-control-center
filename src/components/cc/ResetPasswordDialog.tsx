'use client';

/**
 * ResetPasswordDialog — admin-triggered password reset for an operator
 * user (Phase H10).
 *
 * Two-step UX:
 *   1. Confirmation step — admin clicks "Yeni Şifre Üret".
 *      We POST `/api/internal/operator-users/:id/reset-password` and the
 *      server generates + bcrypt-hashes a new password. The plaintext
 *      password is returned ONCE in the response body.
 *   2. Reveal step — the new password is shown with a Copy button. After
 *      this dialog closes, the admin cannot recover the password (it's
 *      hashed in DB). They must transmit it securely (Signal, phone, etc.).
 *
 * Why generate server-side: the bcrypt cost (12 rounds) lives on the
 * server, and we want the audit log entry to be associated with the
 * actual write. Browser-side generation would either ship the plaintext
 * over the wire (defeats the point) or require duplicate logic.
 *
 * Audit: server writes `operator_user.password_reset` with the admin's
 * userId as the actor and the target user as the entity.
 */

import { useEffect, useState } from 'react';

export function ResetPasswordDialog({
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
  const [phase, setPhase] = useState<'confirm' | 'reveal'>('confirm');
  const [submitting, setSubmitting] = useState(false);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleGenerate() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/internal/operator-users/${userId}/reset-password`,
        { method: 'POST' },
      );
      const json = (await res.json()) as {
        success: boolean;
        data?: { password: string };
        error?: { message: string };
      };
      if (!json.success || !json.data?.password) {
        setError(json.error?.message ?? 'Şifre üretilemedi.');
        return;
      }
      setNewPassword(json.data.password);
      setPhase('reveal');
    } catch {
      setError('Sunucuya ulaşılamadı.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!newPassword) return;
    try {
      await navigator.clipboard.writeText(newPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Pano erişimi reddedildi. Şifreyi manuel kopyalayın.');
    }
  }

  function handleClose() {
    if (phase === 'reveal') {
      // We've already called the API; treat close as "done" so the parent
      // can refresh the list (last_login_at etc. may have changed).
      onDone();
    } else {
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-pw-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
        <h2
          id="reset-pw-title"
          className="text-lg font-semibold text-slate-100"
        >
          Şifreyi Sıfırla
        </h2>

        {phase === 'confirm' ? (
          <>
            <p className="text-sm text-slate-300">
              <span className="font-mono">{username}</span> kullanıcısı için
              yeni güçlü bir şifre üretilsin mi?
            </p>
            <div className="bg-amber-900/30 border border-amber-700 rounded-md px-3 py-2 text-xs text-amber-200">
              Yeni şifre yalnızca bir kez gösterilecek. Güvenli bir kanal
              üzerinden kullanıcıya iletmek sizin sorumluluğunuzdadır.
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
                onClick={handleGenerate}
                disabled={submitting}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded text-white font-medium text-sm"
              >
                {submitting ? 'Üretiliyor...' : 'Yeni Şifre Üret'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-300">
              <span className="font-mono">{username}</span> için yeni şifre:
            </p>
            <div className="bg-slate-900 border border-slate-700 rounded-md p-3 flex items-center gap-2">
              <code className="flex-1 font-mono text-sm text-slate-100 break-all select-all">
                {newPassword}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-white text-xs font-medium whitespace-nowrap"
              >
                {copied ? '✓ Kopyalandı' : 'Kopyala'}
              </button>
            </div>
            <div className="bg-red-900/30 border border-red-700 rounded-md px-3 py-2 text-xs text-red-200">
              <strong>Bu pencere kapandığında şifre tekrar
              gösterilmeyecek.</strong> Şimdi kopyalayın ve kullanıcıya güvenli
              bir kanal üzerinden iletin.
            </div>
            {error ? (
              <p className="text-xs text-red-400">{error}</p>
            ) : null}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-slate-100 text-sm"
              >
                Kapat
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
