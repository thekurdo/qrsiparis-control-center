'use client';

/**
 * /2fa-verify — per-login TOTP challenge (or backup-code fallback).
 *
 * Reached when /login signed in with valid password but the user has 2FA
 * enabled and didn't supply a code in the first step. We re-call
 * `signIn('credentials', ...)` with the additional `totpCode` (or
 * `backupCode`) field; the same `authorize()` path in operator.ts handles
 * the rest.
 *
 * Username is passed via the `?username=` query param so the operator
 * doesn't have to retype it. (Their password however IS retyped — we never
 * persist it across the page transition.)
 */

import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Şifre veya kod hatalı.',
  LOCKED_OUT:
    'Hesabınız çok sayıda başarısız deneme nedeniyle 15 dakikalığına geçici olarak kilitlendi.',
  INVALID_TOTP: 'Doğrulama kodu hatalı.',
  INVALID_BACKUP_CODE: 'Yedek kod hatalı veya kullanılmış.',
  TWO_FACTOR_NOT_ENABLED:
    'Bu hesap için 2FA kurulumu tamamlanmamış. Yönetici ile iletişime geçin.',
  credentials: 'Doğrulama başarısız.',
  CredentialsSignin: 'Doğrulama başarısız.',
};

export default function TwoFactorVerifyPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialUsername = searchParams.get('username') ?? '';
  const callbackUrl = searchParams.get('callbackUrl') ?? '/';

  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await signIn('credentials', {
        username,
        password,
        ...(useBackup ? { backupCode: code } : { totpCode: code }),
        redirect: false,
        callbackUrl,
      });

      if (!result) {
        setError('Beklenmeyen bir hata oluştu. Tekrar deneyin.');
        return;
      }

      // See operator.ts CredentialsAuthError comment: Auth.js v5 packs our
      // symbolic codes into `result.code` (URL ?code=...); `result.error`
      // is always 'CredentialsSignin' for credentials rejections.
      const errorKey =
        (result as { code?: string | null }).code ?? result.error ?? null;
      if (errorKey) {
        setError(
          ERROR_MESSAGES[errorKey] ??
            'Doğrulama başarısız. Bilgileri kontrol edip tekrar deneyin.',
        );
        return;
      }

      router.push(result.url ?? callbackUrl);
      router.refresh();
    } catch (err) {
      setError('Bağlantı hatası. Tekrar deneyin.');
      // eslint-disable-next-line no-console
      console.error('[2fa-verify] signIn threw', err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-8 shadow-xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-100">
          İki Faktörlü Doğrulama
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {useBackup
            ? 'Yedek kodunuzu girin.'
            : 'Authenticator uygulamanızdaki 6 haneli kodu girin.'}
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label
            htmlFor="username"
            className="block text-sm font-medium text-slate-300 mb-1"
          >
            Kullanıcı Adı
          </label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
            disabled={submitting}
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-slate-300 mb-1"
          >
            Şifre
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
            disabled={submitting}
          />
        </div>

        <div>
          <label
            htmlFor="code"
            className="block text-sm font-medium text-slate-300 mb-1"
          >
            {useBackup ? 'Yedek Kod' : 'Doğrulama Kodu'}
          </label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode={useBackup ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) =>
              setCode(
                useBackup
                  ? e.target.value.toUpperCase().slice(0, 32)
                  : e.target.value.replace(/\D/g, '').slice(0, 6),
              )
            }
            className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-slate-100 text-center text-lg font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
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
          disabled={submitting || !username || !password || !code}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-medium rounded-md px-4 py-2 transition-colors"
        >
          {submitting ? 'Doğrulanıyor…' : 'Doğrula ve Gir'}
        </button>

        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setUseBackup((v) => !v);
              setCode('');
              setError(null);
            }}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            {useBackup
              ? 'Authenticator kodu kullan'
              : 'Yedek Kod Kullan'}
          </button>
        </div>
      </form>
    </div>
  );
}
