'use client';

/**
 * OperatorUserFormClient — create/edit operator user (Phase H10).
 *
 * Modes:
 *   - mode="create"           Required password field + 2FA-required flag
 *   - mode="edit"             Optional "Şifre Değiştir" toggle exposes a
 *                             password field; submit only sends fields the
 *                             admin actually changed.
 *
 * Fields:
 *   - username  — regex /^[a-z0-9_-]+$/, 3-50 chars
 *   - fullName  — required
 *   - email     — required, valid email
 *   - password  — create: required & validated against PASSWORD_POLICY
 *                 edit: only when "Şifre Değiştir" is on
 *   - role      — admin / operator radio
 *   - isActive  — checkbox (default true)
 *   - require2fa — V1.5 placeholder; in V1 we surface the warning instead
 *
 * "🔄 Otomatik Oluştur" button regenerates a 16-char strong password (server
 * helper would be more secure but we don't need MASTER_KEY in the browser
 * for a short-lived display value; we use crypto.getRandomValues directly).
 *
 * Submit:
 *   POST   /api/internal/operator-users         (create)
 *   PATCH  /api/internal/operator-users/:id     (edit)
 *
 * On successful create, if `require2fa` was checked, we show a banner that
 * explicitly reminds the admin to share the credentials securely AND that
 * the user must complete 2FA setup before they can log in.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import type { OperatorRole } from '@/lib/auth/middleware';

import { OperatorRoleBadge } from './OperatorRoleBadge';

// Mirrors validatePasswordPolicy() in lib/auth/password.ts. Duplicated here
// because pulling in the server module from a 'use client' file would drag
// bcrypt into the browser bundle.
const MIN_PW_LEN = 8;
const MAX_PW_LEN = 128;

const usernameRegex = /^[a-z0-9_-]+$/;

export interface OperatorUserFormInitial {
  id: string;
  username: string;
  fullName: string;
  email: string;
  role: OperatorRole;
  isActive: boolean;
  twoFactorEnabled: boolean;
}

interface FormState {
  username: string;
  fullName: string;
  email: string;
  password: string;
  role: OperatorRole;
  isActive: boolean;
  require2fa: boolean;
  /** Edit-mode toggle: only when true do we send `password`. */
  changePassword: boolean;
}

const EMPTY: FormState = {
  username: '',
  fullName: '',
  email: '',
  password: '',
  role: 'operator',
  isActive: true,
  require2fa: true,
  changePassword: false,
};

/**
 * Browser-side strong password generator. 16 chars, includes
 * lower/upper/digit/symbol from a curated alphabet (no I/O/0/1/l).
 */
function generateBrowserPassword(): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digit = '23456789';
  const symbol = '!@#$%^&*+-=?_';
  const pool = lower + upper + digit + symbol;

  const seed: string[] = [
    pickOne(lower),
    pickOne(upper),
    pickOne(digit),
    pickOne(symbol),
  ];
  while (seed.length < 16) seed.push(pickOne(pool));

  for (let i = seed.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0]! % (i + 1);
    const tmp = seed[i]!;
    seed[i] = seed[j]!;
    seed[j] = tmp;
  }
  return seed.join('');

  function pickOne(alphabet: string): string {
    const max = Math.floor(0xff_ff_ff_ff / alphabet.length) * alphabet.length;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      const v = buf[0]!;
      if (v < max) return alphabet[v % alphabet.length]!;
    }
  }
}

function validate(
  state: FormState,
  mode: 'create' | 'edit',
): Record<string, string> {
  const errs: Record<string, string> = {};

  if (state.username.length < 3 || state.username.length > 50) {
    errs.username = 'Kullanıcı adı 3-50 karakter olmalı';
  } else if (!usernameRegex.test(state.username)) {
    errs.username =
      "Sadece küçük harf, rakam, '_' ve '-' kullanılabilir";
  }

  if (state.fullName.trim().length < 2) {
    errs.fullName = 'Tam ad gerekli';
  }

  if (!/^\S+@\S+\.\S+$/.test(state.email)) {
    errs.email = 'Geçerli bir e-posta giriniz';
  }

  const pwRequired = mode === 'create' || state.changePassword;
  if (pwRequired) {
    if (state.password.length < MIN_PW_LEN) {
      errs.password = `Şifre en az ${MIN_PW_LEN} karakter olmalı`;
    } else if (state.password.length > MAX_PW_LEN) {
      errs.password = `Şifre en fazla ${MAX_PW_LEN} karakter olabilir`;
    } else if (!/[A-Za-zçğıöşüÇĞİÖŞÜ]/.test(state.password)) {
      errs.password = 'Şifre en az bir harf içermeli';
    } else if (!/\d/.test(state.password)) {
      errs.password = 'Şifre en az bir rakam içermeli';
    }
  }

  return errs;
}

export function OperatorUserFormClient({
  mode,
  initial,
}: {
  mode: 'create' | 'edit';
  initial?: OperatorUserFormInitial;
}) {
  const router = useRouter();

  const [form, setForm] = useState<FormState>(() => {
    if (mode === 'edit' && initial) {
      return {
        username: initial.username,
        fullName: initial.fullName,
        email: initial.email,
        password: '',
        role: initial.role,
        isActive: initial.isActive,
        require2fa: initial.twoFactorEnabled,
        changePassword: false,
      };
    }
    return EMPTY;
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showCreatedReminder, setShowCreatedReminder] = useState<{
    username: string;
    require2fa: boolean;
  } | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);

    const errs = validate(form, mode);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      let res: Response;
      if (mode === 'create') {
        res = await fetch('/api/internal/operator-users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: form.username,
            fullName: form.fullName,
            email: form.email,
            password: form.password,
            role: form.role,
            isActive: form.isActive,
          }),
        });
      } else {
        if (!initial) throw new Error('Düzenleme moduna ilk veri yok');
        const body: Record<string, unknown> = {
          username: form.username,
          fullName: form.fullName,
          email: form.email,
          role: form.role,
          isActive: form.isActive,
        };
        if (form.changePassword && form.password.length > 0) {
          body.password = form.password;
        }
        res = await fetch(
          `/api/internal/operator-users/${initial.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
      }
      const json = (await res.json()) as {
        success: boolean;
        error?: { message: string; fieldErrors?: Record<string, string> };
      };
      if (!json.success) {
        if (json.error?.fieldErrors) setErrors(json.error.fieldErrors);
        setSubmitError(json.error?.message ?? 'İşlem başarısız.');
        return;
      }
      if (mode === 'create') {
        setShowCreatedReminder({
          username: form.username,
          require2fa: form.require2fa,
        });
      } else {
        router.push('/sistem/kullanicilar');
        router.refresh();
      }
    } catch {
      setSubmitError('Sunucuya ulaşılamadı.');
    } finally {
      setSubmitting(false);
    }
  }

  const passwordEnabled = mode === 'create' || form.changePassword;

  if (showCreatedReminder) {
    return (
      <div className="space-y-6 max-w-2xl">
        <header>
          <Link
            href="/sistem/kullanicilar"
            className="text-blue-400 text-sm hover:underline"
          >
            ← Kullanıcılar
          </Link>
          <h1 className="text-2xl font-semibold text-slate-100 mt-2">
            Kullanıcı Oluşturuldu
          </h1>
        </header>
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4">
          <p className="text-sm text-slate-200">
            <span className="font-mono">{showCreatedReminder.username}</span>{' '}
            kullanıcısı başarıyla oluşturuldu.
          </p>
          {showCreatedReminder.require2fa ? (
            <div className="bg-amber-900/30 border border-amber-700 rounded-md px-4 py-3 text-sm text-amber-200">
              <strong>Hatırlatma:</strong> Bu kullanıcı 2FA kurmadan sisteme
              giremez. İlk girişte /2fa-setup sayfasında TOTP&apos;yi
              etkinleştirmelidir.
            </div>
          ) : (
            <div className="bg-slate-900/50 border border-slate-700 rounded-md px-4 py-3 text-sm text-slate-300">
              2FA isteğe bağlı bırakıldı. V1.5&apos;te zorunlu hale gelecek.
            </div>
          )}
          <p className="text-xs text-slate-500">
            Şifreyi kullanıcıya güvenli bir kanal üzerinden iletin (telefon,
            Signal, vb.). Şifre tekrar gösterilmeyecek.
          </p>
          <div className="flex gap-2 pt-2">
            <Link
              href="/sistem/kullanicilar"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white font-medium text-sm"
            >
              Kullanıcı Listesine Dön
            </Link>
            <button
              type="button"
              onClick={() => {
                setShowCreatedReminder(null);
                setForm(EMPTY);
              }}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-slate-100 text-sm"
            >
              Bir Tane Daha Ekle
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <Link
          href="/sistem/kullanicilar"
          className="text-blue-400 text-sm hover:underline"
        >
          ← Kullanıcılar
        </Link>
        <h1 className="text-2xl font-semibold text-slate-100 mt-2">
          {mode === 'create' ? 'Yeni Kullanıcı' : 'Kullanıcıyı Düzenle'}
        </h1>
        {mode === 'edit' && initial ? (
          <p className="text-sm text-slate-400 mt-1 flex items-center gap-2">
            <span className="font-mono">{initial.username}</span>
            <OperatorRoleBadge role={initial.role} />
          </p>
        ) : null}
      </header>

      <form
        onSubmit={handleSubmit}
        className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4"
        noValidate
      >
        {submitError ? (
          <div className="bg-red-900/30 border border-red-700 rounded-md px-4 py-3 text-sm text-red-200">
            {submitError}
          </div>
        ) : null}

        <Field
          label="Kullanıcı Adı"
          value={form.username}
          onChange={(v) => update('username', v.toLowerCase())}
          error={errors['username']}
          required
          mono
          hint="Sadece küçük harf, rakam, '_' ve '-' (3-50 karakter)"
        />
        <Field
          label="Tam Ad"
          value={form.fullName}
          onChange={(v) => update('fullName', v)}
          error={errors['fullName']}
          required
        />
        <Field
          label="E-posta"
          value={form.email}
          onChange={(v) => update('email', v)}
          error={errors['email']}
          type="email"
          required
        />

        {mode === 'edit' ? (
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.changePassword}
              onChange={(e) => update('changePassword', e.target.checked)}
              className="w-4 h-4 accent-blue-500"
            />
            Şifre Değiştir
          </label>
        ) : null}

        {passwordEnabled ? (
          <div>
            <label className="block text-sm text-slate-300 mb-1">
              Şifre {mode === 'create' ? <span className="text-red-400 ml-0.5">*</span> : null}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  value={form.password}
                  onChange={(e) => update('password', e.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  className={`w-full bg-slate-900 text-slate-100 rounded p-2 pr-10 text-sm border focus:outline-none font-mono ${
                    errors['password']
                      ? 'border-red-500'
                      : 'border-slate-700 focus:border-blue-500'
                  }`}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-200"
                  aria-label={
                    showPassword ? 'Şifreyi gizle' : 'Şifreyi göster'
                  }
                >
                  {showPassword ? '🙈' : '👁'}
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  update('password', generateBrowserPassword());
                  setShowPassword(true);
                }}
                className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-100 whitespace-nowrap"
                title="16 karakterlik güçlü şifre üret"
              >
                🔄 Otomatik Oluştur
              </button>
            </div>
            {errors['password'] ? (
              <p className="text-xs text-red-400 mt-1">{errors['password']}</p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                En az 8 karakter, 1 harf ve 1 rakam içermeli.
              </p>
            )}
          </div>
        ) : null}

        <fieldset>
          <legend className="block text-sm text-slate-300 mb-1">
            Rol <span className="text-red-400 ml-0.5">*</span>
          </legend>
          <div className="space-y-2">
            <label className="flex items-start gap-3 p-3 rounded border border-slate-700 cursor-pointer hover:bg-slate-700/30 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-900/20">
              <input
                type="radio"
                name="role"
                checked={form.role === 'admin'}
                onChange={() => update('role', 'admin')}
                className="mt-1 accent-blue-500"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <OperatorRoleBadge role="admin" />
                  <span className="text-sm font-medium text-slate-100">
                    Admin
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Tüm tenant&apos;ları yönet, sunucu ekle, kullanıcı yönet.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 rounded border border-slate-700 cursor-pointer hover:bg-slate-700/30 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-900/20">
              <input
                type="radio"
                name="role"
                checked={form.role === 'operator'}
                onChange={() => update('role', 'operator')}
                className="mt-1 accent-blue-500"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <OperatorRoleBadge role="operator" />
                  <span className="text-sm font-medium text-slate-100">
                    Operatör
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Tenant ekle/izle, deploy başlat (kullanıcı yönetemez).
                </p>
              </div>
            </label>
          </div>
        </fieldset>

        <div className="space-y-2 pt-2">
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => update('isActive', e.target.checked)}
              className="w-4 h-4 accent-blue-500"
            />
            Aktif
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.require2fa}
              onChange={(e) => update('require2fa', e.target.checked)}
              className="w-4 h-4 accent-blue-500"
            />
            <span>2FA Zorunlu</span>
            <span className="text-[10px] uppercase tracking-wide bg-amber-900/40 text-amber-300 rounded px-1.5 py-0.5">
              V1.5
            </span>
          </label>
          {form.require2fa ? (
            <p className="text-xs text-slate-500 ml-6">
              V1: Bilgi amaçlı bayrak. V1.5&apos;te giriş engelleyici olarak
              uygulanacak. Yeni kullanıcı /2fa-setup sayfasında TOTP&apos;yi
              kendisi kurmalıdır.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Link
            href="/sistem/kullanicilar"
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-slate-100 text-sm"
          >
            İptal
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed rounded text-white font-medium text-sm"
          >
            {submitting
              ? 'Kaydediliyor...'
              : mode === 'create'
                ? 'Kullanıcı Oluştur'
                : 'Kaydet'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local Field component (kept inline for the same reason as Step1BasicInfo).
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  hint?: string;
  type?: string;
  required?: boolean;
  mono?: boolean;
}

function Field({
  label,
  value,
  onChange,
  error,
  hint,
  type = 'text',
  required,
  mono,
}: FieldProps) {
  const baseClass = `w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border focus:outline-none ${
    error ? 'border-red-500' : 'border-slate-700 focus:border-blue-500'
  } ${mono ? 'font-mono' : ''}`;
  return (
    <div>
      <label className="block text-sm text-slate-300 mb-1">
        {label}
        {required ? <span className="text-red-400 ml-0.5">*</span> : null}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        className={baseClass}
      />
      {hint && !error ? (
        <p className="text-xs text-slate-500 mt-1">{hint}</p>
      ) : null}
      {error ? <p className="text-xs text-red-400 mt-1">{error}</p> : null}
    </div>
  );
}
