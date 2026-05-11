/**
 * Operator password hashing + policy enforcement (Phase H2).
 *
 * Design points (from IMPL §3 / §4 R12 + Doc 17 §11):
 *   - bcrypt @ cost 12 — Auth.js v5 default. Roughly 250-400 ms per hash on
 *     a modern x86 server. The cost is a deliberate brake on offline
 *     attackers; the per-request latency is acceptable on the operator
 *     login surface (which is gated behind IP whitelist anyway).
 *   - `fakeBcryptDelay()` — when the user lookup misses we still want the
 *     response time to look identical to a real-password compare, so
 *     enumeration via timing is defeated. The mean of a real bcrypt(12) on
 *     our class of hardware lands in the 250 ms band.
 *   - Password policy is intentionally weak (8 chars + 1 letter + 1 digit)
 *     because the operator surface is small and 2FA is the second wall.
 *     The rule mirrors Doc 17 §3.1 ("8+ chars + 1 letter + 1 digit").
 *
 * What this file does NOT do:
 *   - It does not write to or read from the DB. Callers compose with
 *     `operator.ts` to do the lookup-then-compare flow.
 *   - It does not throw typed API errors. Throwing `InvalidCredentialsError`
 *     etc. is the orchestrator's job; here we return booleans / structured
 *     validation results.
 *
 * Why bcrypt and not argon2: bcrypt is the dependency Auth.js v5 ships with,
 * already in `package.json`, and is sufficient for a small operator pool
 * (single-digit users). Argon2 would be marginally better cryptographically
 * but adds a native build dependency for negligible practical benefit here.
 */

import bcrypt from 'bcrypt';

/**
 * bcrypt work factor for operator passwords. 12 is the Auth.js v5 default
 * and matches `db/seed.ts` for hash compatibility on the seeded admin row.
 *
 * Rotation: bumping this value does NOT invalidate existing hashes — bcrypt
 * encodes the cost in the hash string, so old hashes still verify. Newly
 * created users get the new cost on their next password set.
 */
const ROUNDS = 12;

/**
 * Calibrated to the median bcrypt(12) duration on our target hosts (a
 * Hostinger KVM 4 with 4 vCPU runs bcrypt(12) at roughly 240-280 ms). If the
 * production host is significantly faster or slower, calibrate by measuring
 * a real `comparePassword` call and adjusting this constant.
 */
const FAKE_DELAY_MS = 250;

/**
 * Hash a plaintext password using bcrypt at the configured cost.
 *
 * The returned string is the full bcrypt hash format including the cost
 * prefix (`$2b$12$...`); store it directly in `operator_users.password_hash`.
 */
export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, ROUNDS);
}

/**
 * Constant-time-ish password compare via bcrypt. Returns a plain boolean
 * (no throwing on mismatch) so the caller controls the failure path
 * (audit log, brute-force counter increment, etc.).
 *
 * `hash` may have any cost prefix — bcrypt parses it from the string,
 * which is what enables cost rotation without forcing re-hashes.
 */
export async function comparePassword(
  pw: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

/**
 * Sleep for the typical bcrypt(12) duration to defeat user-enumeration
 * timing attacks on the login endpoint.
 *
 * Call this from the orchestrator on the username-not-found branch BEFORE
 * returning `INVALID_CREDENTIALS`, so that "user does not exist" and
 * "user exists, password wrong" branches take the same wall-clock time.
 *
 * Implementation note: a real `bcrypt.compare` against a fixed throwaway
 * hash would be more accurate but pulls a large CPU spike on every misses;
 * a flat sleep is a good-enough approximation given operator login is
 * already rate-limited (5 fails/15min lockout).
 */
export async function fakeBcryptDelay(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, FAKE_DELAY_MS);
  });
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Authoritative password policy for operator accounts.
 *
 * Mirrored from Doc 17 §3.1 (staff requirements). Manager-tightening (e.g.,
 * symbol-required) is intentionally NOT applied — operator users are few
 * and 2FA is the meaningful second factor.
 *
 * `maxLength` exists to bound bcrypt input (bcrypt silently truncates at
 * 72 bytes; allowing 128 chars communicates "yes, we'll accept your long
 * passphrase" while hashing only the first 72 — which is still vastly
 * stronger than any 8-char password).
 */
export const PASSWORD_POLICY = {
  minLength: 8,
  maxLength: 128,
  requireLetter: true,
  requireDigit: true,
} as const;

export type PasswordPolicyValidation =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validate a candidate password against `PASSWORD_POLICY`.
 *
 * Returns a discriminated union — call sites pattern-match instead of
 * relying on a magic boolean + side-channel error string.
 *
 * The reason strings are Turkish to match the control-center's TR-only
 * surface (IMPL/Doc 17 §1).
 */
export function validatePasswordPolicy(pw: string): PasswordPolicyValidation {
  if (typeof pw !== 'string') {
    return { valid: false, reason: 'Şifre metin olmalı' };
  }
  if (pw.length < PASSWORD_POLICY.minLength) {
    return {
      valid: false,
      reason: `Şifre en az ${PASSWORD_POLICY.minLength} karakter olmalı`,
    };
  }
  if (pw.length > PASSWORD_POLICY.maxLength) {
    return {
      valid: false,
      reason: `Şifre en fazla ${PASSWORD_POLICY.maxLength} karakter olabilir`,
    };
  }
  if (PASSWORD_POLICY.requireLetter && !/[A-Za-zçğıöşüÇĞİÖŞÜ]/.test(pw)) {
    return { valid: false, reason: 'Şifre en az bir harf içermeli' };
  }
  if (PASSWORD_POLICY.requireDigit && !/\d/.test(pw)) {
    return { valid: false, reason: 'Şifre en az bir rakam içermeli' };
  }
  return { valid: true };
}
