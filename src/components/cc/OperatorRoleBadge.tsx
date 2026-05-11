/**
 * Operator role pill — matches StatusPill visual language (Phase H10).
 *
 *   admin     → blue   (full management surface)
 *   operator  → slate  (tenant CRUD + deploy, no user management)
 *
 * Server-component-safe (no hooks). Reused by:
 *   - OperatorUserListClient (list table)
 *   - OperatorUserFormClient (form preview / read-only fallback)
 */

import type { OperatorRole } from '@/lib/auth/middleware';

const PILL_BASE =
  'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium';

const CONFIG: Record<OperatorRole, { cls: string; label: string }> = {
  admin: { cls: 'bg-blue-900/40 text-blue-300', label: 'Yönetici' },
  operator: { cls: 'bg-slate-700 text-slate-300', label: 'Operatör' },
};

export function OperatorRoleBadge({ role }: { role: OperatorRole }) {
  const cfg = CONFIG[role];
  return <span className={`${PILL_BASE} ${cfg.cls}`}>{cfg.label}</span>;
}
