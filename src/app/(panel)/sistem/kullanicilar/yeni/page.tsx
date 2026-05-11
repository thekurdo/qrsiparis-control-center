/**
 * /sistem/kullanicilar/yeni — create operator user (Phase H10).
 *
 * Server-component shell that gates admin-only and hands off to the
 * client form. No data fetching needed — pure form.
 */

import { OperatorUserFormClient } from '@/components/cc/OperatorUserFormClient';
import { requireOperatorAuth } from '@/lib/auth/middleware';

export default async function NewOperatorUserPage() {
  await requireOperatorAuth(['admin']);
  return <OperatorUserFormClient mode="create" />;
}
