'use client';

/**
 * /2fa-setup — first-time TOTP setup wizard (Phase H9+ shell).
 *
 * Flow:
 *   1. Page mounts → POST /api/internal/auth/2fa/init → server returns
 *      { secret, qrUrl } (the route handler stores the encrypted secret as
 *      a "pending" value on the user row).
 *   2. User scans QR in their authenticator app (Google Authenticator,
 *      1Password, Authy, etc.) and types the 6-digit code back.
 *   3. POST /api/internal/auth/2fa/verify-setup with the code → on success
 *      the server flips `two_factor_enabled=true`, generates 4 backup codes,
 *      and returns them ONCE in the response body. We display them with a
 *      download-as-txt button. Operator confirms → redirect to `/`.
 *
 * The init/verify-setup endpoints land in a follow-up worker; if they aren't
 * deployed yet the page shows a graceful "henüz hazır değil" notice.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

interface InitResponse {
  secret: string;
  qrUrl: string; // otpauth:// URL — render via QR endpoint or qrcode.react
  qrImageDataUrl?: string; // optional pre-rendered data URL
}

interface VerifySetupResponse {
  backupCodes: string[]; // 4 codes per IMPL §1.B/H2
}

type Phase = 'loading' | 'scan' | 'backup' | 'unavailable';

export default function TwoFactorSetupPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [initData, setInitData] = useState<InitResponse | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Step 1 — fetch a fresh secret on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/internal/auth/2fa/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          if (cancelled) return;
          // 404 = endpoint not deployed yet. Render a graceful notice rather
          // than a confusing error.
          setPhase(res.status === 404 ? 'unavailable' : 'scan');
          if (res.status !== 404) {
            setError('2FA başlatılamadı. Sayfayı yenileyin.');
          }
          return;
        }
        const data = (await res.json()) as InitResponse;
        if (cancelled) return;
        setInitData(data);
        setPhase('scan');
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[2fa-setup] init failed', err);
        setPhase('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onVerifySetup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/internal/auth/2fa/verify-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setError('Kod doğrulanamadı. Tekrar deneyin.');
        return;
      }
      const data = (await res.json()) as VerifySetupResponse;
      setBackupCodes(data.backupCodes);
      setPhase('backup');
    } catch (err) {
      setError('Bağlantı hatası. Tekrar deneyin.');
      // eslint-disable-next-line no-console
      console.error('[2fa-setup] verify-setup failed', err);
    } finally {
      setSubmitting(false);
    }
  }

  function onDownloadBackupCodes() {
    const blob = new Blob(
      [
        `QrSiparis Control Center — 2FA Yedek Kodları\n` +
          `Tarih: ${new Date().toISOString()}\n\n` +
          backupCodes.map((c, i) => `${i + 1}. ${c}`).join('\n') +
          `\n\nHer kod yalnızca bir kez kullanılabilir. Güvenli bir yerde saklayın.\n`,
      ],
      { type: 'text/plain;charset=utf-8' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'qrsiparis-2fa-yedek-kodlar.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function onConfirm() {
    router.push('/');
    router.refresh();
  }

  // ---- Render ----

  if (phase === 'loading') {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-8 text-center text-slate-400">
        Yükleniyor…
      </div>
    );
  }

  if (phase === 'unavailable') {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
        <h1 className="text-xl font-semibold text-slate-100 mb-2">
          2FA Kurulumu
        </h1>
        <p className="text-sm text-slate-400">
          2FA kurulum servisi şu an hazır değil. Yönetici ile iletişime geçin.
        </p>
      </div>
    );
  }

  if (phase === 'scan') {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
        <h1 className="text-xl font-semibold text-slate-100 mb-1">
          2FA Kurulumu
        </h1>
        <p className="text-sm text-slate-400 mb-6">
          Authenticator uygulamanızda QR kodu tarayın, ardından 6 haneli kodu
          girerek doğrulayın.
        </p>

        {/* QR code: use server-rendered data URL if provided, else hint a fallback. */}
        <div className="flex justify-center mb-4">
          {initData?.qrImageDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={initData.qrImageDataUrl}
              alt="2FA QR Kodu"
              className="bg-white p-2 rounded"
              width={200}
              height={200}
            />
          ) : (
            <div className="bg-slate-900 border border-slate-700 rounded p-4 text-xs font-mono text-slate-500 break-all max-w-full">
              {initData?.qrUrl ?? '(QR URL alınamadı)'}
            </div>
          )}
        </div>

        {initData?.secret && (
          <div className="mb-4 text-center">
            <div className="text-xs text-slate-400 mb-1">Manuel anahtar</div>
            <code className="text-sm font-mono text-slate-200 break-all">
              {initData.secret}
            </code>
          </div>
        )}

        <form onSubmit={onVerifySetup} className="space-y-4" noValidate>
          <div>
            <label
              htmlFor="code"
              className="block text-sm font-medium text-slate-300 mb-1"
            >
              6 Haneli Kod
            </label>
            <input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
              autoFocus
              required
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
              }
              className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-slate-100 text-center text-xl font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
              disabled={submitting}
            />
          </div>

          {error && (
            <div
              role="alert"
              className="bg-red-900/30 border border-red-500/40 rounded-md px-3 py-2 text-sm text-red-200"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || code.length !== 6}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-medium rounded-md px-4 py-2 transition-colors"
          >
            {submitting ? 'Doğrulanıyor…' : 'Doğrula'}
          </button>
        </form>
      </div>
    );
  }

  // phase === 'backup'
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
      <h1 className="text-xl font-semibold text-slate-100 mb-1">
        Yedek Kodlar
      </h1>
      <p className="text-sm text-slate-400 mb-4">
        Aşağıdaki 4 kod yalnızca bir kez gösterilir. Authenticator
        uygulamanıza erişemediğinizde tek seferlik giriş için kullanılır.
        İndirip güvenli bir yerde saklayın.
      </p>

      <div className="bg-slate-900 border border-slate-700 rounded-md p-4 mb-4 grid grid-cols-2 gap-2 font-mono text-sm text-slate-100">
        {backupCodes.map((c, i) => (
          <div key={i} className="text-center">
            {c}
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <button
          type="button"
          onClick={onDownloadBackupCodes}
          className="w-full bg-slate-700 hover:bg-slate-600 text-slate-100 font-medium rounded-md px-4 py-2 transition-colors"
        >
          Yedek Kodları İndir (.txt)
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-md px-4 py-2 transition-colors"
        >
          Onayla ve Devam Et
        </button>
      </div>
    </div>
  );
}
