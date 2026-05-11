/**
 * TOTP (RFC 6238) helpers for operator 2FA (Phase H2).
 *
 * Wraps `otplib`'s `authenticator` module:
 *   - 30-second time step (default)
 *   - SHA-1 HMAC (default — what Google Authenticator / Authy / 1Password
 *     all consume)
 *   - Base32-encoded secret (default)
 *   - Window=±1 (i.e., the previous and next 30 s codes are also accepted)
 *     — this absorbs ~30 s of clock drift between the operator's phone and
 *     the server, which is necessary in real-world conditions
 *
 * Why otplib and not a hand-rolled implementation: TOTP is unforgiving —
 * a single off-by-one in counter handling silently fails for some seconds.
 * `otplib` is the reference Node implementation, audited, and matches the
 * RFC test vectors. It's already in `package.json`.
 *
 * --- ENCRYPTION GOTCHA ---
 * The string returned by `generateTotpSecret()` is the RAW Base32 secret.
 * It MUST be encrypted via `lib/crypto/aes-gcm.ts` before being written to
 * `operator_users.two_factor_secret`. The schema column comment marks the
 * column as encrypted; this file does NOT do the encryption itself, so the
 * caller (operator.ts authorize / the 2fa-setup route handler) is in charge.
 *
 * --- TIMING NOTE ---
 * `verifyTotpCode` is fast (microsecond-class) so timing-attack resistance
 * is not a meaningful concern — a TOTP code has only 1 000 000 possible
 * values and is rate-limited by the same 5/15min brute-force counter as
 * password attempts (R12).
 */

import { authenticator } from 'otplib';

// Configure the authenticator module exactly once at import time. Otplib
// stores options on the singleton instance, so this state is global across
// the process — which is fine because we want every call site to share the
// same drift window.
authenticator.options = {
  // ±1 step (= ±30 s). RFC 6238 §5.2 recommends window=1 as a usability
  // accommodation. Larger windows weaken security; window=0 is too strict
  // for typical phone clock drift.
  window: 1,
};

/**
 * Length of the secret in Base32 characters. otplib's `generateSecret(N)`
 * takes a byte length; 20 bytes (160 bits) -> 32 Base32 chars, which is
 * the de-facto standard for Google Authenticator URLs.
 *
 * Don't lower this — RFC 4226 §4 recommends ≥160 bits of entropy for the
 * shared secret.
 */
const SECRET_BYTE_LEN = 20;

/**
 * Issuer string baked into the otpauth URL. Shows up in authenticator app
 * UI as the account label prefix (`qrsiparis:siyar@example.com`).
 *
 * Lowercase + ASCII-only so authenticator apps parse it cleanly. If we
 * later run multiple control-center instances, each can override this via
 * the `buildOtpauthUrl` issuer parameter.
 */
const DEFAULT_ISSUER = 'qrsiparis';

/**
 * Generate a fresh Base32 TOTP secret. The returned string is plaintext —
 * encrypt it with `lib/crypto/aes-gcm.ts#encrypt()` before storing.
 *
 * Returns 32 Base32 chars (= 20 bytes / 160 bits).
 */
export function generateTotpSecret(): string {
  return authenticator.generateSecret(SECRET_BYTE_LEN);
}

/**
 * Build the `otpauth://totp/...` URL that the QR code on the /2fa-setup
 * page encodes. Authenticator apps scan this URL and persist the secret
 * + label.
 *
 * Format (RFC-compatible):
 *   otpauth://totp/{issuer}:{username}?secret={secret}&issuer={issuer}
 *
 * `issuer` appears twice (in the path AND query) for compatibility with
 * the broadest set of authenticator apps — older clients only read one or
 * the other. Both must agree.
 *
 * URL components are encoded so usernames containing `@`, spaces, or
 * special chars don't break the URL.
 */
export function buildOtpauthUrl(
  username: string,
  secret: string,
  issuer: string = DEFAULT_ISSUER,
): string {
  const safeUsername = encodeURIComponent(username);
  const safeIssuer = encodeURIComponent(issuer);
  // otplib has its own keyuri builder, but invoking it here makes the
  // structure explicit and lets us guarantee both `issuer` placements.
  return `otpauth://totp/${safeIssuer}:${safeUsername}?secret=${encodeURIComponent(
    secret,
  )}&issuer=${safeIssuer}`;
}

/**
 * Verify a 6-digit TOTP code against the user's secret.
 *
 * Returns `true` if the code matches the current 30 s window or the
 * adjacent windows (±30 s drift). Returns `false` for any of:
 *   - wrong code
 *   - code outside the drift window
 *   - malformed input (non-numeric, wrong length)
 *
 * The caller (operator.ts) is responsible for:
 *   1. Decrypting the stored secret BEFORE passing it here
 *   2. Tracking replay (a leaked code valid for 30 s is the threat surface;
 *      the brute-force counter R12 limits exposure)
 *
 * NOTE: `authenticator.check` returns false on any thrown internal error
 * (malformed Base32, etc.) — we do NOT swallow those silently because
 * malformed secret = encrypted-store corruption and should surface as a
 * production error.
 */
export function verifyTotpCode(secret: string, code: string): boolean {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return false;
  }
  return authenticator.check(code, secret);
}
