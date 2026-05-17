'use client';

/**
 * /login — operator login form (Phase H9+ shell over the H2 auth backend).
 *
 * Uses Auth.js v5 client-side `signIn('credentials', ...)`. The Credentials
 * provider's `authorize()` (in `lib/auth/operator.ts`) throws our
 * `CredentialsAuthError` subclass with a symbolic `code`. Auth.js
 * surfaces `code` on the client-side `signIn` result as `result.code`
 * (NOT `result.error` — that's always the string `'CredentialsSignin'`
 * for Credentials provider rejections per @auth/core's URL contract).
 *
 *   - code `INVALID_CREDENTIALS`  → generic "kullanıcı adı / şifre hatalı"
 *   - code `LOCKED_OUT`           → account locked banner
 *   - code `NEEDS_TWO_FACTOR`     → redirect to /2fa-verify with username
 *
 * We pass `redirect: false` to keep the user on this page so we can render
 * an inline error.
 */

import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Kullanıcı adı veya şifre hatalı.',
  LOCKED_OUT:
    'Hesabınız çok sayıda başarısız deneme nedeniyle 15 dakikalığına geçici olarak kilitlendi.',
  // Fallback for raw CredentialsSignin (e.g. if authorize() returned null
  // instead of throwing — Auth.js then emits `code=credentials`).
  credentials: 'Kullanıcı adı veya şifre hatalı.',
  CredentialsSignin: 'Kullanıcı adı veya şifre hatalı.',
};

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
        redirect: false,
        callbackUrl,
      });

      if (!result) {
        setError('Beklenmeyen bir hata oluştu. Tekrar deneyin.');
        return;
      }

      // Auth.js v5 packs our symbolic codes (thrown via CredentialsAuthError)
      // into `result.code`; `result.error` is always 'CredentialsSignin'
      // for any rejection out of the credentials provider. Read both, prefer
      // code (it's more specific).
      const errorKey =
        (result as { code?: string | null }).code ?? result.error ?? null;

      // NEEDS_TWO_FACTOR signal — password OK but TOTP/backup not supplied.
      if (errorKey === 'NEEDS_TWO_FACTOR') {
        const params = new URLSearchParams({ username });
        if (callbackUrl !== '/') params.set('callbackUrl', callbackUrl);
        router.push(`/2fa-verify?${params.toString()}`);
        return;
      }

      if (errorKey) {
        setError(
          ERROR_MESSAGES[errorKey] ??
            'Giriş yapılamadı. Bilgileri kontrol edip tekrar deneyin.',
        );
        return;
      }

      // Success — Auth.js sets the session cookie. Navigate to the panel.
      router.push(result.url ?? callbackUrl);
      router.refresh();
    } catch (err) {
      // Unexpected (network failure, etc.) — surface a generic error.
      setError('Bağlantı hatası. Tekrar deneyin.');
      // eslint-disable-next-line no-console
      console.error('[login] signIn threw', err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-8 shadow-xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-100">
          Control Center
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Operatör girişi
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
            autoFocus
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
          disabled={submitting || !username || !password}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-medium rounded-md px-4 py-2 transition-colors"
        >
          {submitting ? 'Giriş yapılıyor…' : 'Giriş Yap'}
        </button>
      </form>
    </div>
  );
}
