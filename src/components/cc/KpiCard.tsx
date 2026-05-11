import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * KpiCard — single key-metric tile (Phase H9+).
 *
 * Used by the dashboard's 4-card grid and other summary panels. Variants
 * tint the value text to communicate severity at a glance.
 *
 *   - neutral  (default) — slate-100 value, slate-700 border
 *   - warning            — amber-300 value, amber-500/40 border
 *   - danger             — red-300 value, red-500/40 border
 *
 * Pass `link` to make the entire card a clickable Next.js Link.
 */

export type KpiVariant = 'neutral' | 'warning' | 'danger';

export function KpiCard({
  label,
  value,
  link,
  variant = 'neutral',
  hint,
}: {
  label: string;
  value: string | number;
  link?: string;
  variant?: KpiVariant;
  hint?: ReactNode;
}) {
  const accent =
    variant === 'danger'
      ? 'border-red-500/40'
      : variant === 'warning'
        ? 'border-amber-500/40'
        : 'border-slate-700';
  const valueColor =
    variant === 'danger'
      ? 'text-red-300'
      : variant === 'warning'
        ? 'text-amber-300'
        : 'text-slate-100';

  const inner = (
    <div
      className={`bg-slate-800 border ${accent} rounded-lg p-5 transition-colors hover:bg-slate-800/70`}
    >
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
        {label}
      </div>
      <div className={`text-3xl font-semibold ${valueColor}`}>{value}</div>
      {hint && <div className="mt-2 text-xs text-slate-500">{hint}</div>}
    </div>
  );

  return link ? (
    <Link href={link} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}
