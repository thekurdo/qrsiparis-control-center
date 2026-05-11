/**
 * Server-side auth gate helper for operator routes (Phase H2).
 *
 * Used from BOTH:
 *   - Server components (panel pages under `app/(panel)/...`) — call this
 *     at the top of the component to redirect unauthenticated users to
 *     `/login`.
 *   - Route handlers (`app/api/internal/.../route.ts`) — same call, same
 *     redirect semantics. Route handlers can also branch on the returned
 *     session for fine-grained checks.
 *
 * Design notes:
 *   - Returns the resolved session on success (typed with our extended
 *     `Session.user` shape so callers can read `role` / `username` without
 *     a second `auth()` call).
 *   - Uses `redirect()` from `next/navigation` which throws a special
 *     `NEXT_REDIRECT` error — DO NOT wrap calls in try/catch, you'd
 *     swallow the redirect.
 *   - Role check is whitelist-style: pass `['admin']` to require admin,
 *     `['admin','operator']` to allow either. Omitting the parameter
 *     means "any authenticated user".
 *   - On role mismatch we redirect to `/` (panel home). The home page
 *     can then show a "no permission" banner; an explicit `/forbidden`
 *     route would be cleaner but is V1.5.
 *
 * Why no Next.js `middleware.ts` at the project root: that flavour of
 * middleware runs on the edge runtime, which is incompatible with our
 * `pg` driver and bcrypt. Auth gating happens at the server-component /
 * route-handler boundary instead — slightly slower per-request than
 * edge middleware but compatible with our Node-only stack.
 *
 * --- USAGE EXAMPLES (test-fixture style; not a Vitest spec) ---
 *
 *   // In a server component:
 *   export default async function DashboardPage() {
 *     const session = await requireOperatorAuth();
 *     return <div>Hello {session.user.username}</div>;
 *   }
 *
 *   // Admin-only route:
 *   export default async function StaffListPage() {
 *     await requireOperatorAuth(['admin']);
 *     // ...
 *   }
 *
 *   // In a route handler:
 *   export async function GET() {
 *     const session = await requireOperatorAuth(['admin']);
 *     return Response.json({ data: ... });
 *   }
 */

import { redirect } from 'next/navigation';

import { auth } from './operator';

/** Roles that a route may allow. */
export type OperatorRole = 'admin' | 'operator';

/**
 * The shape of the session this helper returns. Matches the module-
 * augmented `Session` from `operator.ts` but tightens the user fields to
 * non-optional (we just verified them).
 */
export interface OperatorSession {
  user: {
    id: string;
    username: string;
    role: OperatorRole;
    email?: string | null;
    name?: string | null;
  };
}

/**
 * Require an authenticated operator session. Optionally restrict to
 * specific roles (whitelist).
 *
 * @param allowedRoles - if provided, the session's `role` must be in this
 * array. Pass `undefined` (or omit) to accept any role.
 *
 * Behaviour:
 *   - No session             → `redirect('/login')`
 *   - Session present, role not in `allowedRoles` → `redirect('/')`
 *   - Otherwise              → returns the typed session
 *
 * The returned object has `user.id` / `user.username` / `user.role`
 * guaranteed non-null. Other fields (`email`, `name`) may be null when
 * the underlying provider didn't supply them.
 */
export async function requireOperatorAuth(
  allowedRoles?: OperatorRole[],
): Promise<OperatorSession> {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  // Belt-and-braces: even though our session callback always sets these,
  // narrow the type here so downstream code doesn't have to.
  const { id, username, role } = session.user;
  if (!id || !username || !role) {
    redirect('/login');
  }

  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    redirect('/');
  }

  return {
    user: {
      id,
      username,
      role,
      email: session.user.email ?? null,
      name: session.user.name ?? null,
    },
  };
}
