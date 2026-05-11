/**
 * /sistem/kullanicilar — operator user list (Phase H10).
 *
 * Admin-only surface (operators CANNOT manage other users — IMPL §3 role
 * matrix, R13). The route gate uses `requireOperatorAuth(['admin'])`; non-
 * admin sessions are bounced to the panel home with a "no permission"
 * indicator (handled by the middleware → '/' redirect).
 *
 * The actual interactive table lives in <OperatorUserListClient> so we can
 * keep router.refresh() / dialog state on the client. This page only does
 * the auth check + the data fetch (server-side ⇒ avoids exposing the API
 * for the initial paint).
 */

import { db } from '@/db/client';
import { operatorUsers } from '@/db/schema';
import { OperatorUserListClient } from '@/components/cc/OperatorUserListClient';
import { requireOperatorAuth } from '@/lib/auth/middleware';

export default async function KullanicilarPage() {
  const session = await requireOperatorAuth(['admin']);

  const users = await db
    .select({
      id: operatorUsers.id,
      username: operatorUsers.username,
      email: operatorUsers.email,
      fullName: operatorUsers.fullName,
      role: operatorUsers.role,
      isActive: operatorUsers.isActive,
      twoFactorEnabled: operatorUsers.twoFactorEnabled,
      lastLoginAt: operatorUsers.lastLoginAt,
      failedLoginLockedUntil: operatorUsers.failedLoginLockedUntil,
      createdAt: operatorUsers.createdAt,
    })
    .from(operatorUsers)
    .orderBy(operatorUsers.createdAt);

  return (
    <OperatorUserListClient users={users} currentUserId={session.user.id} />
  );
}
