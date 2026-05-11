/**
 * /sistem/kullanicilar/[id] — edit operator user (Phase H10).
 *
 * Admin-only. Fetches the target user but EXCLUDES the sensitive columns
 * (password_hash, two_factor_secret, two_factor_backup_codes) so they
 * never get serialized into the React tree → DOM.
 */

import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

import { db } from '@/db/client';
import { operatorUsers } from '@/db/schema';
import { OperatorUserFormClient } from '@/components/cc/OperatorUserFormClient';
import { requireOperatorAuth } from '@/lib/auth/middleware';

export default async function OperatorUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperatorAuth(['admin']);
  const { id } = await params;

  const [user] = await db
    .select({
      id: operatorUsers.id,
      username: operatorUsers.username,
      email: operatorUsers.email,
      fullName: operatorUsers.fullName,
      role: operatorUsers.role,
      isActive: operatorUsers.isActive,
      twoFactorEnabled: operatorUsers.twoFactorEnabled,
    })
    .from(operatorUsers)
    .where(eq(operatorUsers.id, id))
    .limit(1);

  if (!user) notFound();

  return <OperatorUserFormClient mode="edit" initial={user} />;
}
