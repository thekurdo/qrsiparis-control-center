/**
 * Currency formatter for Turkish Lira amounts stored in kuruş (1 TRY = 100 kr).
 *
 * The DB column `tenants.monthly_fee_kurus` is `bigint`. Drizzle returns it as
 * `number` because we declared `mode: 'number'` (see schema.ts), but a bigint
 * fallback is supported here so the helper is safe for any caller.
 *
 * Output uses tr-TR locale + narrow currency symbol (₺ rather than the long
 * "TRY" code) to match the V1 panel UI tokens.
 */
export function formatTl(kurus: bigint | number | null | undefined): string {
  if (kurus === null || kurus === undefined) return '—';
  const n = typeof kurus === 'bigint' ? Number(kurus) : kurus;
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    currencyDisplay: 'narrowSymbol',
  }).format(n / 100);
}
