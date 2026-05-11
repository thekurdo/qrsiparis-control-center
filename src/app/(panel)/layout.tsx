/**
 * Panel shell layout — auth gate + sidebar + header (Phase H9+).
 *
 * Wraps every route inside `app/(panel)/...` with:
 *   1. Server-side auth check (redirects to /login on missing session)
 *   2. CCSidebar — vertical navigation, role-aware
 *   3. CCHeader — sticky topbar with user avatar + dropdown
 *
 * Server component intentionally — auth gating + initial render happens on
 * the server so the panel never flashes its chrome before redirecting.
 */

import type { ReactNode } from 'react';

import { CCHeader } from '@/components/cc/CCHeader';
import { CCSidebar } from '@/components/cc/CCSidebar';
import { requireOperatorAuth } from '@/lib/auth/middleware';

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const session = await requireOperatorAuth();
  return (
    <div className="control-center min-h-screen bg-slate-900 text-slate-100 flex">
      <CCSidebar role={session.user.role} />
      <div className="flex-1 flex flex-col">
        <CCHeader user={session.user} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
