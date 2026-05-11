'use client';

/**
 * GeneralSettingsClient — read-only sistem ayarları paneli (Phase H13).
 *
 * V1: env'den okunan değerleri bölüm bölüm gösterir. Editable alanlar
 * (Telegram chat ID, Slack webhook, log retention) V1.5'te eklenecek.
 *
 * Tek prop: server tarafında hazırlanmış `settings` objesi. Component
 * salt sunum amaçlı; data fetch ya da mutation içermez.
 */

import type { ReactNode } from 'react';

export interface GeneralSettingsData {
  appVersion: string;
  redisUrl: string;
  databaseUrl: string;
  telegramConfigured: boolean;
  slackConfigured: boolean;
  masterKeyConfigured: boolean;
  defaultBackupPath: string;
  logRetentionDays: number;
}

export function GeneralSettingsClient({
  settings,
}: {
  settings: GeneralSettingsData;
}) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-100">Genel Ayarlar</h1>
        <p className="mt-1 text-slate-400">
          Sistem yapılandırması — V1&apos;de çoğu değer env üzerinden okunur.
        </p>
      </header>

      <Section title="Sistem">
        <Field label="App Version" value={settings.appVersion} mono />
        <Field
          label="Database URL"
          value={settings.databaseUrl || '— (tanımsız)'}
          mono
          note="Sadece görüntüleme. Değiştirmek için server restart gerekli."
        />
        <Field
          label="Redis URL"
          value={settings.redisUrl || '— (tanımsız)'}
          mono
        />
        <Field
          label="MASTER_KEY"
          value={
            settings.masterKeyConfigured
              ? '✓ Yapılandırılmış (64 hex)'
              : '⚠ EKSİK'
          }
        />
      </Section>

      <Section title="Bildirim Entegrasyonları">
        <Field
          label="Telegram Bot"
          value={settings.telegramConfigured ? '✓ Yapılandırılmış' : '— Yok'}
          note="env: TELEGRAM_BOT_TOKEN"
        />
        <Field
          label="Slack Webhook"
          value={settings.slackConfigured ? '✓ Yapılandırılmış' : '— Yok'}
          note="env: SLACK_WEBHOOK_URL"
        />
        <p className="text-xs text-slate-500">
          Yapılandırma için sunucu .env dosyasını düzenleyip restart edin.
        </p>
      </Section>

      <Section title="Yedekleme">
        <Field
          label="Varsayılan Yedek Hedefi"
          value={settings.defaultBackupPath}
          mono
        />
        <Field
          label="Log Tutma Süresi"
          value={`${settings.logRetentionDays} gün`}
          note="Audit log'lar bu süreden sonra arşive taşınır (V1.5)"
        />
      </Section>

      <Section title="Kullanıcı Yönetimi">
        <p className="text-sm text-slate-300">
          Operatör kullanıcıları için{' '}
          <a
            href="/sistem/kullanicilar"
            className="text-blue-400 hover:underline"
          >
            Kullanıcılar
          </a>{' '}
          sayfasını kullanın.
        </p>
      </Section>

      <Section title="V1.5 Özellikleri">
        <ul className="space-y-1 text-sm text-slate-400">
          <li>• Telegram/Slack inline ayarlar</li>
          <li>• Cron job tetikleme + log görüntüleme</li>
          <li>• Operatör 2FA yönetimi (zorunlu V1.5)</li>
          <li>• Backup retention ayarları</li>
          <li>• Audit log archive policy</li>
        </ul>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg bg-slate-800 p-6">
      <h2 className="mb-3 text-lg font-semibold text-slate-100">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  mono,
  note,
}: {
  label: string;
  value: string;
  mono?: boolean;
  note?: string;
}) {
  return (
    <div className="grid grid-cols-2 items-start gap-4">
      <dt className="text-sm text-slate-400">{label}</dt>
      <dd>
        <span
          className={`text-slate-200 ${mono ? 'font-mono text-xs' : ''}`}
        >
          {value}
        </span>
        {note && <p className="mt-1 text-xs text-slate-500">{note}</p>}
      </dd>
    </div>
  );
}
