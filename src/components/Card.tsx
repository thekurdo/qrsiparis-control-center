import type { ReactNode } from 'react';

/**
 * Generic card wrapper used by detail/list panels in the operator UI.
 * Dark theme: slate-800 background with a subtle border. Spacing left to
 * the caller via children.
 */
export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`bg-slate-800 border border-slate-700 rounded-lg p-6 ${className}`}
    >
      {children}
    </section>
  );
}
