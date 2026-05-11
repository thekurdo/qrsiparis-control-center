import type { ReactNode } from 'react';

/**
 * Auth shell — used by /login, /2fa-setup, /2fa-verify.
 *
 * Plain centered card layout. No navigation chrome (no sidebar/header) so
 * unauthenticated visitors don't see any operator data, and so the form is
 * the entire visual focus.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
