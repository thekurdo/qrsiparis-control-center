/**
 * /sistem/ayarlar — genel CC ayarları (Phase H13).
 *
 * V1 kapsamı: çoğu ayar env-driven (read-only). Telegram chat ID, Slack
 * webhook, log retention, default backup path gibi runtime ayarlanabilir
 * alanlar V1.5'te DB-stored hâle gelecek. Bu sayfa şimdilik env'i okur
 * ve maskelenmiş şekilde gösterir.
 *
 * Admin-only: `requireOperatorAuth(['admin'])` operator rolünü reddeder.
 *
 * Credential masking: DATABASE_URL / REDIS_URL gibi connection string'ler
 * `<user>:<password>@host` formatındadır. Şifre kısmını UI'da göstermemek
 * için `maskCredentials` ile `:***@` ile değiştirilir.
 */

import { GeneralSettingsClient } from '@/components/cc/GeneralSettingsClient';
import { requireOperatorAuth } from '@/lib/auth/middleware';

function maskCredentials(url: string): string {
  // user:pass@host  →  user:***@host
  return url.replace(/:[^@]+@/, ':***@');
}

export default async function GenelAyarlarPage() {
  await requireOperatorAuth(['admin']);

  const settings = {
    appVersion: process.env.APP_VERSION ?? 'dev',
    redisUrl: maskCredentials(process.env.REDIS_URL ?? ''),
    databaseUrl: maskCredentials(process.env.DATABASE_URL ?? ''),
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    slackConfigured: Boolean(process.env.SLACK_WEBHOOK_URL),
    masterKeyConfigured: Boolean(
      process.env.MASTER_KEY && process.env.MASTER_KEY.length === 64,
    ),
    defaultBackupPath: process.env.DEFAULT_BACKUP_PATH ?? '/data/backups',
    logRetentionDays: Number(process.env.LOG_RETENTION_DAYS ?? '90'),
  };

  return <GeneralSettingsClient settings={settings} />;
}
