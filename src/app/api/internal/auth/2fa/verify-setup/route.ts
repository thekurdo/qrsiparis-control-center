/**
 * POST /api/internal/auth/2fa/verify-setup  (Phase H2)
 *
 * Second step of the TOTP enrolment wizard rendered by /2fa-setup.
 *
 * Behaviour:
 *   1. Reads the current session — 401 otherwise.
 *   2. Reads `{ code }` from the body and rejects malformed inputs early.
 *   3. Loads the operator row; bails if 2FA is already enabled (the wizard
 *      should not have called us in that case) or if no pending secret is
 *      present (the operator never hit /init).
 *   4. Decrypts the pending secret and runs `verifyTotpCode()` against the
 *      submitted code. On mismatch returns 400.
 *   5. Generates 4 fresh backup codes (`generateBackupCodes()` — each one
 *      already bcrypt-hashed + AES-GCM encrypted ready for storage), then
 *      atomically flips `two_factor_enabled=true` and writes the codes.
 *      The order (codes first, then `enabled`) matters: the table CHECK
 *      constraint `ck_operator_users_backup_codes_count` requires
 *      `array_length = 4` whenever `two_factor_enabled = true`, and
 *      Postgres evaluates row-level CHECKs only after all SET assignments,
 *      so a single UPDATE that sets both is safe.
 *   6. Writes an `audit_log` row with `action = '2fa_enabled'` — this is
 *      the security-meaningful event in the enrolment sequence.
 *   7. Returns `{ backupCodes }` so the wizard can show them once.
 *
 * Response shape, like `/init`, is raw (not the standard envelope) to
 * match the existing client `VerifySetupResponse` interface.
 *
 * Failure modes that produce 400:
 *   - missing/non-string code
 *   - code not a 6-digit numeric string
 *   - code did not validate against the pending TOTP secret
 *   - pending secret missing or corrupted (treated as "fresh /init needed")
 */

import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { db } from '@/db/client';
import { operatorUsers } from '@/db/schema';
import {
  errorResponse,
  getClientIp,
  getUserAgent,
} from '@/lib/api/response';
import { generateBackupCodes } from '@/lib/auth/backup-codes';
import { auth } from '@/lib/auth/operator';
import { verifyTotpCode } from '@/lib/auth/totp';
import { recordAudit } from '@/lib/cc/audit';
import { decrypt } from '@/lib/crypto/aes-gcm';

/** Response body — see file header for why this is not wrapped. */
interface VerifySetupResponse {
  /** 4 plaintext backup codes — shown to the operator exactly once. */
  backupCodes: string[];
}

interface VerifySetupBody {
  code?: unknown;
}

export async function POST(req: NextRequest) {
  // We call `auth()` directly (not `requireOperatorAuth()`) because this
  // endpoint must remain reachable while `two_factor_enabled = false`.
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse('UNAUTHORIZED', 'Oturum açmanız gerekiyor');
  }

  let body: VerifySetupBody;
  try {
    body = (await req.json()) as VerifySetupBody;
  } catch {
    return errorResponse('VALIDATION_ERROR', 'Geçersiz JSON gövdesi');
  }

  const code = typeof body.code === 'string' ? body.code : '';
  if (!/^\d{6}$/.test(code)) {
    return errorResponse('VALIDATION_ERROR', '6 haneli sayısal kod bekleniyor');
  }

  const [row] = await db
    .select({
      id: operatorUsers.id,
      username: operatorUsers.username,
      twoFactorSecret: operatorUsers.twoFactorSecret,
      twoFactorEnabled: operatorUsers.twoFactorEnabled,
    })
    .from(operatorUsers)
    .where(eq(operatorUsers.id, session.user.id))
    .limit(1);
  if (!row) {
    return errorResponse('UNAUTHORIZED', 'Oturum geçersiz');
  }
  if (row.twoFactorEnabled) {
    return errorResponse('CONFLICT', '2FA zaten etkin');
  }
  if (!row.twoFactorSecret) {
    return errorResponse(
      'VALIDATION_ERROR',
      'Önce QR kodu oluşturun (/2fa-setup sayfasını yenileyin)',
    );
  }

  // Decrypt the pending secret. If decryption fails (corrupted blob, key
  // rotation mid-enrolment) we treat it as "no pending secret" so the
  // caller is steered back to /init rather than seeing a crypto error.
  let secretPlain: string;
  try {
    secretPlain = decrypt(row.twoFactorSecret);
  } catch {
    return errorResponse(
      'VALIDATION_ERROR',
      'Bekleyen 2FA anahtarı çözülemedi — kurulumu baştan başlatın',
    );
  }

  if (!verifyTotpCode(secretPlain, code)) {
    return errorResponse('INVALID_TOTP', 'Kod doğrulanamadı — tekrar deneyin');
  }

  // Code is valid. Generate backup codes and flip enabled in a single
  // UPDATE so the row-level CHECK constraint sees a consistent state.
  const { plaintextCodes, hashedForStorage } = await generateBackupCodes();
  await db
    .update(operatorUsers)
    .set({
      twoFactorEnabled: true,
      twoFactorBackupCodes: hashedForStorage,
    })
    .where(eq(operatorUsers.id, row.id));

  // Audit the enable event. action='2fa_enabled' matches S1 spec text.
  // The actor and the target are the same user (self-enrolment).
  await recordAudit({
    userId: row.id,
    action: '2fa_enabled',
    entityType: 'operator_user',
    entityId: row.id,
    metadata: { username: row.username },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  const response: VerifySetupResponse = { backupCodes: plaintextCodes };
  return NextResponse.json<VerifySetupResponse>(response);
}
