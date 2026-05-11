import type { ReactNode } from 'react';

/**
 * Definition-list field for tenant/server detail pages. Pairs a small slate-400
 * label with a slate-100 value. `mono` switches the value to JetBrains Mono for
 * IDs / slugs / IPs.
 */
export function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400 mb-1">
        {label}
      </dt>
      <dd
        className={`text-sm text-slate-100 ${mono ? 'font-mono' : ''}`}
      >
        {value ?? '—'}
      </dd>
    </div>
  );
}
