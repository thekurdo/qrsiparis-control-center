/**
 * /sunucular/yeni — add a VPS to the fleet (Phase H4).
 *
 * Client component (form interactivity). POSTs to `/api/internal/servers`,
 * which is wired up in Phase H6/H7. While that endpoint is missing the form
 * will surface the 404 inline — that's expected at this milestone.
 *
 * Field set per Doc 17 §3.5 (9 fields plus optional notes); maxTenants
 * default = 20 anchors to the IMPL §1.PB3 capacity contract.
 *
 * Sensitive payloads (`sshPrivateKey`, `coolifyApiToken`) are sent over the
 * authenticated channel and encrypted server-side via lib/crypto/aes-gcm.ts
 * before insertion (handled by the H6/H7 route handler).
 */
'use client';

import { useState, type FormEvent, type InputHTMLAttributes } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function YeniSunucuPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const fd = new FormData(e.currentTarget);
    const body = {
      name: fd.get('name'),
      publicIp: fd.get('publicIp'),
      publicHostname: fd.get('publicHostname'),
      sshPort: Number(fd.get('sshPort')) || 22,
      sshUser: fd.get('sshUser'),
      sshPrivateKey: fd.get('sshPrivateKey'),
      coolifyUrl: fd.get('coolifyUrl'),
      coolifyApiToken: fd.get('coolifyApiToken'),
      location: fd.get('location'),
      maxTenantsTheoretical: Number(fd.get('maxTenantsTheoretical')) || 20,
      notes: fd.get('notes'),
    };

    try {
      const res = await fetch('/api/internal/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json?.error?.message ?? `Hata (${res.status})`);
        setSubmitting(false);
        return;
      }
      router.push('/sunucular');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Bağlantı hatası';
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link href="/sunucular" className="text-blue-400 text-sm hover:underline">
        ← Sunucular
      </Link>
      <h1 className="text-2xl font-semibold text-slate-100">Yeni Sunucu Ekle</h1>

      <form onSubmit={handleSubmit} className="bg-slate-800 rounded-lg p-6 space-y-4">
        <Field
          label="Sunucu Etiketi"
          name="name"
          required
          placeholder="vps-01-frankfurt"
        />
        <Field
          label="Public IP"
          name="publicIp"
          required
          pattern="\d+\.\d+\.\d+\.\d+"
          placeholder="X.X.X.X"
        />
        <Field
          label="Public Hostname (opsiyonel)"
          name="publicHostname"
          placeholder="vps01.qrsiparis.app"
        />

        <div className="grid grid-cols-2 gap-4">
          <Field label="SSH Port" name="sshPort" type="number" defaultValue="22" />
          <Field label="SSH Kullanıcı" name="sshUser" defaultValue="root" />
        </div>

        <div>
          <label className="block text-sm text-slate-300 mb-1">
            SSH Private Key (PEM)
          </label>
          <textarea
            name="sshPrivateKey"
            required
            rows={6}
            className="w-full bg-slate-900 text-slate-100 rounded p-3 font-mono text-xs border border-slate-700 focus:border-blue-500 focus:outline-none"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
          />
          <p className="text-xs text-slate-500 mt-1">
            Sunucuya kaydetmeden önce AES-256-GCM ile şifrelenir.
          </p>
        </div>

        <Field
          label="Coolify URL"
          name="coolifyUrl"
          required
          type="url"
          placeholder="https://coolify.vps01.qrsiparis.app"
        />
        <Field
          label="Coolify API Token"
          name="coolifyApiToken"
          required
          type="password"
        />

        <div className="grid grid-cols-2 gap-4">
          <Field label="Lokasyon" name="location" placeholder="Frankfurt" />
          <Field
            label="Maks. Müşteri Sayısı"
            name="maxTenantsTheoretical"
            type="number"
            defaultValue="20"
            min="1"
            max="50"
          />
        </div>

        <div>
          <label className="block text-sm text-slate-300 mb-1">
            Notlar (opsiyonel)
          </label>
          <textarea
            name="notes"
            rows={3}
            className="w-full bg-slate-900 text-slate-100 rounded p-3 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
          />
        </div>

        {error && (
          <div className="bg-red-900/40 text-red-300 p-3 rounded text-sm">{error}</div>
        )}

        <div className="flex justify-end gap-3 pt-4">
          <Link
            href="/sunucular"
            className="px-4 py-2 text-slate-300 hover:text-white"
          >
            İptal
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-white font-medium"
          >
            {submitting ? 'Kaydediliyor...' : 'Kaydet'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  ...props
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="block text-sm text-slate-300 mb-1">{label}</label>
      <input
        {...props}
        className="w-full bg-slate-900 text-slate-100 rounded p-2 text-sm border border-slate-700 focus:border-blue-500 focus:outline-none"
      />
    </div>
  );
}
