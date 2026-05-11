/**
 * POST /api/internal/operator-users/:id/reset-password  (Phase H10)
 *
 * Admin-triggered password reset. Generates a new 16-char strong password
 * server-side, bcrypt-hashes it (cost 12 — same as the create flow), and
 * returns the plaintext to the caller ONCE.
 *
 * The plaintext leaves the server exactly once. The frontend
 * (<ResetPasswordDialog>) renders it in a one-time reveal modal with a
 * "Copy" button; after dialog close, neither the admin nor the server can
 * recover it. The admin must transmit it to the user via a secure
 * out-of-band channel.
 *
 * Side effects:
 *   - operator_users.password_hash       ← bcrypt(newPassword, 12)
 *   - operator_users.failed_login_attempts ← 0     (clear lockout state)
 *   - operator_users.failed_login_locked_until ← null
 *
 * We deliberately do NOT clear 2FA state — admins can reset password and
 * 2FA independently.
 *
 * Audit: writes `operator_user.password_reset`. Metadata records the
 * actor + target. The plaintext password itself is NEVER logged.
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
import { hashPassword } from '@/lib/auth/password';
import { recordAudit } from '@/lib/cc/audit';
import { generatePassword } from '@/lib/cc/generate-password';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireOperatorAuth(['admin']);
  const { id } = await params;

  const [existing] = await db
    .select({ id: operatorUsers.id, username: operatorUsers.username })
    .from(operatorUsers)
    .where(eq(operatorUsers.id, id))
    .limit(1);
  if (!existing) {
    return errorResponse('NOT_FOUND', 'Kullanıcı bulunamadı');
  }

  const newPassword = generatePassword({ length: 16, symbols: true });
  const passwordHash = await hashPassword(newPassword);

  await db
    .update(operatorUsers)
    .set({
      passwordHash,
      // Clear lockout state — a fresh password should always be usable.
      failedLoginAttempts: 0,
      failedLoginLockedUntil: null,
    })
    .where(eq(operatorUsers.id, id));

  await recordAudit({
    userId: session.user.id,
    action: 'operator_user.password_reset',
    entityType: 'operator_user',
    entityId: id,
    metadata: {
      username: existing.username,
      selfReset: id === session.user.id,
    },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  // The plaintext password is in the response body exactly once. Browsers
  // will not log this in their history (only request/response bodies are
  // visible in devtools, and only to the admin who initiated the call).
  return successResponse({ password: newPassword });
}
