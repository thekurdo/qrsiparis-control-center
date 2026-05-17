// NextAuth route handler — canonical Auth.js v5 location (Phase H2).
//
// Auth.js v5 returns the HTTP method handlers grouped under a single
// `handlers` object. Re-export them as the named GET/POST exports that
// Next.js App Router route files require. See `src/lib/auth/operator.ts`
// for the actual auth configuration.
//
// Why `/api/auth/...` and not `/api/internal/...` like the rest of the
// control-center: the next-auth React client (`signIn`, `signOut`,
// `useSession`) hard-codes its default base path to `/api/auth` and
// only honours overrides via `<SessionProvider basePath="...">` at the
// component tree level. None of the auth pages use a provider (they
// call `signIn()` directly), so we keep the handler at the canonical
// path that the client expects. Our custom 2FA endpoints
// (`/api/internal/auth/2fa/...`) are unaffected — they're plain fetch
// calls, not next-auth-client-mediated.

import { handlers } from '@/lib/auth/operator';

export const GET = handlers.GET;
export const POST = handlers.POST;
