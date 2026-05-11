/**
 * POST /api/internal/operator-users/:id/reset-2fa  (Phase H10)
 *
 * Admin-triggered 2FA reset for a target operator user. Clears:
 *   - two_factor_secret              → null
 *   - two_factor_backup_codes        → empty array
 *   - two_factor_enabled             → false
 *
 * After this, the user must re-run /2fa-setup on next login. The DB CHECK
 * constraint `ck_operator_users_backup_codes_count` only requires exactly
 * 4 codes when `two_factor_enabled = true`, so disabling first and clearing
 * the array is constraint-safe.
 *
 * Audit: writes `operator_user.2fa_reset` with the admin actor and the
 * target user as the entity.
 *
 * Self-reset note: an admin CAN reset their own 2FA (sometimes legitimate
 * — e.g., lost authenticator). After self-reset, their next login will be
 * password-only (no 2FA prompt) until they reconfigure.
 */

import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';

import { db } from '@/db/client';
import { operatorUsers } from '@/db/schema';
import {
  errorResponse,
  getClientIp,
  getUserAgent,
  successResponse,
} from '@/lib/api/response';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { recordAudit } from '@/lib/cc/audit';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireOperatorAuth(['admin']);
  const { id } = await params;

  const [existing] = await db
    .select({
      id: operatorUsers.id,
      username: operatorUsers.username,
      twoFactorEnabled: operatorUsers.twoFactorEnabled,
    })
    .from(operatorUsers)
    .where(eq(operatorUsers.id, id))
    .limit(1);
  if (!existing) {
    return errorResponse('NOT_FOUND', 'Kullanıcı bulunamadı');
  }

  // Order matters: clear `enabled` first to satisfy the backup-codes CHECK
  // constraint, then null out the secret + codes. (A single UPDATE with all
  // three columns also works because Postgres evaluates row-level CHECK
  // after all SET assignments — but the explicit order is defensive.)
  await db
    .update(operatorUsers)
    .set({
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorBackupCodes: [],
    })
    .where(eq(operatorUsers.id, id));

  await recordAudit({
    userId: session.user.id,
    action: 'operator_user.2fa_reset',
    entityType: 'operator_user',
    entityId: id,
    metadata: {
      username: existing.username,
      previouslyEnabled: existing.twoFactorEnabled,
      selfReset: id === session.user.id,
    },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  return successResponse({ id, twoFactorEnabled: false });
}
