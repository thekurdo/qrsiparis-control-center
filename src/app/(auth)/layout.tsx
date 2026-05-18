import type { ReactNode } from 'react';

/**
 * Auth shell — used by /login, /2fa-setup, /2fa-verify.
 *
 * Plain centered card layout. No navigation chrome (no sidebar/header) so
 * unauthenticated visitors don't see any operator data, and so the form is
 * the entire visual focus.
 *
 * Force-dynamic at the layout (server component) level: it propagates to
 * every page below, which is correct since auth pages depend on per-request
 * search params (callbackUrl, error code, etc.). This also sidesteps the
 * Next.js 16 static-gen error for client components that call useSearchParams.
 */
export const dynamic = 'force-dynamic';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
