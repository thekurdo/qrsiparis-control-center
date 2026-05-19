/**
 * POST /api/internal/auth/2fa/init  (Phase H2)
 *
 * First step of the TOTP enrolment wizard rendered by /2fa-setup.
 *
 * Behaviour:
 *   1. Reads the current session — must be authenticated. If not, returns
 *      401 (the page will rerender into its `unavailable` notice path or
 *      the auth layout will already have redirected to /login).
 *   2. If a pending (unverified) TOTP secret already exists on the row
 *      AND the caller did NOT pass `?regenerate=true`, decrypt and
 *      re-return that secret. This makes repeat /init calls idempotent —
 *      React StrictMode double-mounts the setup page in dev so the
 *      effect-driven POST runs twice; without idempotency each call
 *      rotated the secret and the QR shown in-page ended up mismatched
 *      with the row.
 *   3. Otherwise generate a fresh Base32 TOTP secret via
 *      `generateTotpSecret()`.
 *   4. Writes the secret into `operator_users.two_factor_secret`
 *      (AES-GCM-encrypted) — `two_factor_enabled` stays false, so the
 *      CHECK constraint on the backup-codes count is not yet triggered.
 *      This column doubles as the "pending" slot during enrolment; once
 *      `verify-setup` succeeds we flip `two_factor_enabled=true` and the
 *      same secret becomes the live one.
 *   5. Builds the otpauth:// URL for QR-code rendering and uses `qrcode`
 *      to produce a data URL the page can drop straight into an <img>.
 *   6. Returns `{ secret, qrUrl, qrImageDataUrl }` — the page renders
 *      these for the operator to scan in their authenticator app.
 *
 * Why no audit row here: the meaningful security event is "2FA enabled",
 * not "QR code displayed". We write the audit log on `verify-setup` after
 * the operator proves possession of the device.
 */

import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';

import { db } from '@/db/client';
import { operatorUsers } from '@/db/schema';
import { errorResponse } from '@/lib/api/response';
import { auth } from '@/lib/auth/operator';
import { buildOtpauthUrl, generateTotpSecret } from '@/lib/auth/totp';
import { decrypt, encrypt } from '@/lib/crypto/aes-gcm';

/**
 * Response body shape. We return this object directly (not wrapped in the
 * standard `{ success, data }` envelope) because the /2fa-setup client
 * declares its `InitResponse` interface as `{ secret, qrUrl, qrImageDataUrl? }`
 * — unwrapping in the page would create a needless data-shape divergence.
 * The two 2FA endpoints (init + verify-setup) are the only two control-
 * center routes that return raw bodies; everything else uses the envelope.
 */
interface InitResponse {
  /** Base32 secret — shown beneath the QR as the "manual entry" key. */
  secret: string;
  /** otpauth://totp/... URL (encoded by the QR; useful for fallback display). */
  qrUrl: string;
  /** Pre-rendered PNG data URL so the page does not need a QR JS lib. */
  qrImageDataUrl: string;
}

export async function POST(req: NextRequest) {
  // We call auth() directly rather than `requireOperatorAuth()` because
  // this endpoint MUST remain reachable while `two_factor_enabled = false`
  // — the panel-route middleware would otherwise loop us back to /2fa-setup.
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse('UNAUTHORIZED', 'Oturum açmanız gerekiyor');
  }

  const username = session.user.username ?? 'operator';

  // Verify the operator row exists and is not already 2FA-enabled. If
  // 2FA is already on, the setup wizard should not be issuing fresh
  // secrets — direct the caller elsewhere with a clear code.
  const [row] = await db
    .select({
      id: operatorUsers.id,
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
    return errorResponse(
      'CONFLICT',
      '2FA zaten etkin — yeniden kurmak için önce sıfırlatın',
    );
  }

  // Idempotency: reuse the existing pending secret unless the caller
  // explicitly asks to rotate. If decrypt fails we fall through to
  // generating a fresh one — a corrupted blob is functionally the same
  // as "no pending secret" from the operator's point of view.
  const regenerate = req.nextUrl.searchParams.get('regenerate') === 'true';
  let secret: string | null = null;
  if (!regenerate && row.twoFactorSecret) {
    try {
      secret = decrypt(row.twoFactorSecret);
    } catch {
      secret = null;
    }
  }

  if (!secret) {
    secret = generateTotpSecret();
    // Persist the encrypted secret as the pending value. We deliberately
    // do NOT flip `two_factor_enabled` yet — the verify-setup endpoint
    // does that only after the operator proves possession of the device.
    const encryptedSecret = encrypt(secret);
    await db
      .update(operatorUsers)
      .set({ twoFactorSecret: encryptedSecret })
      .where(eq(operatorUsers.id, session.user.id));
  }

  const qrUrl = buildOtpauthUrl(username, secret);

  // PNG data URL keeps the page self-contained — no separate QR endpoint.
  const qrImageDataUrl = await QRCode.toDataURL(qrUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });

  const body: InitResponse = { secret, qrUrl, qrImageDataUrl };
  return NextResponse.json<InitResponse>(body);
}
