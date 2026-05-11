/**
 * 2FA backup-code generation, storage, and one-time consumption (Phase H2).
 *
 * Spec (IMPL §3 — backup codes / Doc 17 §3.4):
 *   - Exactly 4 codes per operator user (DB CHECK constraint enforces this)
 *   - Format: `XXXX-NNNN` (4 letters + dash + 4 digits = 9 chars) — e.g.
 *     `ABCD-1234`. Easy to read and dictate over the phone.
 *   - Ambiguous chars stripped: `I O 0 1` (look like other glyphs). Codes
 *     are intended to be transcribed by humans on a recovery phone call.
 *   - Each code is `bcrypt`-hashed (cost 8, random input -> we don't need
 *     password-grade cost) and then `aes-gcm`-encrypted for at-rest defence
 *     in depth (DB read-only attacker still can't brute-force the hash
 *     dictionary without first breaking AES-GCM).
 *   - Plaintext codes are returned to the caller ONCE — the route handler
 *     surfaces them on the 2FA-setup confirmation screen and that's the
 *     only chance the operator has to copy them. After that they're hashed.
 *
 * Why two layers (bcrypt + AES) for codes:
 *   - bcrypt alone = if DB leaks, attacker can brute-force the small
 *     keyspace of `[A-Z]{4}-[0-9]{4}` (≈ 23⁴ × 8⁴ = 1.16 B combinations,
 *     well within bcrypt(8) brute-force at $1M of cloud).
 *   - AES alone = anyone with DB row + MASTER_KEY recovers all codes.
 *   - bcrypt + AES = attacker needs MASTER_KEY (env var) AND offline
 *     compute, doubling the wall.
 *   - The backup-codes column's bcrypt cost is 8 (not 12) because the
 *     generated codes already have ~30 bits of entropy; we don't need
 *     hot-CPU password-grade cost on top of strong randomness.
 *
 * Verification flow (one-time consume):
 *   1. Caller passes the user-typed `code` plus the array of stored
 *      encrypted-bcrypt blobs (the column value).
 *   2. We decrypt each blob, bcrypt.compare against `code`, find the match.
 *   3. On match: return `{ valid: true, remainingHashes: <other 3> }`.
 *      The CALLER writes `remainingHashes` back to DB to consume the code.
 *   4. On no match: `{ valid: false }`. Caller increments brute-force.
 *
 * Why caller-side write: the DB row update needs a transaction context
 * that varies (login vs operator-self regenerate). Returning the new array
 * keeps this module pure and lets the caller compose with its own txn.
 */

import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

import { decrypt, encrypt } from '@/lib/crypto/aes-gcm';

// ---------------------------------------------------------------------------
// Code-generation alphabet (chosen for human-transcription safety)
// ---------------------------------------------------------------------------

/**
 * Letters used in the alpha segment. `I` and `O` excluded (look like 1/0).
 *
 * Length = 23 -> log₂(23⁴) ≈ 18.1 bits from the alpha segment alone.
 */
const SAFE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Digits used in the numeric segment. `0` and `1` excluded (look like O/I).
 *
 * Length = 8 -> log₂(8⁴) = 12 bits from the numeric segment.
 *
 * Combined: ≈ 30.1 bits per code. Four codes give the user ≈ 32 bits of
 * cumulative recovery entropy — enough to defeat random guessing under
 * the brute-force counter (R12) even if all 4 are guessed in parallel.
 */
const SAFE_DIGIT = '23456789';

/** Number of codes stored per user. DB CHECK enforces this exact count. */
const COUNT = 4;

/** Length of each segment of the formatted code. */
const ALPHA_LEN = 4;
const DIGIT_LEN = 4;

/**
 * bcrypt cost for backup-code hashes.
 *
 * 8 rounds (~10 ms) is enough because the input space is already random
 * — we're not hashing user-chosen passwords. The lower cost keeps login
 * latency bounded when the user enters a backup code (we have to
 * bcrypt-compare against up to 4 hashes serially).
 *
 * IMPORTANT: This cost MUST stay ≤ 12. Auth.js v5 default is 12 (used for
 * passwords); using a different cost here is intentional and documented.
 */
const BCRYPT_COST = 8;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Output of `generateBackupCodes()`. The caller MUST treat
 * `plaintextCodes` as ephemeral — render once and never persist.
 */
export interface GeneratedBackupCodes {
  /**
   * The 4 codes in their human-readable form (e.g. `['ABCD-1234', ...]`).
   * Show these to the operator exactly once on the 2FA-setup screen.
   */
  plaintextCodes: string[];

  /**
   * The 4 codes after bcrypt-then-AES-GCM, ready to be written into
   * `operator_users.two_factor_backup_codes`. The DB column is `text[]`
   * so this array maps 1:1.
   */
  hashedForStorage: string[];
}

/**
 * Generate 4 fresh backup codes plus their AES-encrypted bcrypt hashes.
 *
 * Cryptographic randomness via `crypto.randomBytes` (uniform sampling
 * via rejection — `randomInt` would be simpler but isn't available
 * synchronously at module evaluation time in older Node, so we do it
 * manually with `randomBytes`).
 *
 * Async because bcrypt.hash is async (and we want to hash all 4 in
 * parallel for setup-screen latency).
 */
export async function generateBackupCodes(): Promise<GeneratedBackupCodes> {
  const plaintextCodes: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    plaintextCodes.push(generateOneCode());
  }

  // Hash all 4 in parallel — keeps setup-screen TTI snappy.
  const hashes = await Promise.all(
    plaintextCodes.map((code) => bcrypt.hash(code, BCRYPT_COST)),
  );

  // Then encrypt each hash. AES-GCM is fast (microseconds); no parallelism
  // needed but doing it after Promise.all keeps the order guaranteed.
  const hashedForStorage = hashes.map((h) => encrypt(h));

  return { plaintextCodes, hashedForStorage };
}

/**
 * Verify a user-typed backup code and (logically) consume it.
 *
 * Behaviour:
 *   - Normalises the input: uppercase letters, strip spaces, accept either
 *     `ABCD1234` or `ABCD-1234`.
 *   - Decrypts each stored hash, runs bcrypt.compare against the code.
 *   - On match: returns `{ valid: true, remainingHashes }` — the caller
 *     writes `remainingHashes` to DB. The matched hash is REMOVED from
 *     the array (one-time consume).
 *   - On no match: returns `{ valid: false }`. No mutation of stored array.
 *
 * Performance: up to 4 serial bcrypt(8) compares ≈ 40 ms total — bounded
 * and acceptable for a login-path operation.
 *
 * IMPORTANT: Returning `valid: true` does NOT itself consume the code in
 * the database. The caller MUST write `remainingHashes` back. Failure to
 * do so results in a code that can be replayed forever — review gate.
 */
export async function verifyAndConsumeBackupCode(
  code: string,
  storedEncryptedHashes: string[],
): Promise<
  { valid: true; remainingHashes: string[] } | { valid: false }
> {
  const normalised = normaliseCode(code);
  if (!isWellFormed(normalised)) {
    return { valid: false };
  }

  // Decrypt all hashes upfront (cheap — microseconds each). We can't
  // parallelise the bcrypt.compares against the same code without picking
  // a "first match wins" policy, so we go serial and break on hit.
  let decryptedHashes: string[];
  try {
    decryptedHashes = storedEncryptedHashes.map((h) => decrypt(h));
  } catch {
    // Corrupted/tampered blob -> treat as no match. Don't leak the
    // crypto error to the caller; it would fingerprint the storage shape.
    return { valid: false };
  }

  for (let i = 0; i < decryptedHashes.length; i++) {
    const hash = decryptedHashes[i];
    if (hash === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- intentional: short-circuit on first match
    const match = await bcrypt.compare(normalised, hash);
    if (match) {
      // Consume: drop the matched element, return the rest. Order is not
      // preserved on the DB side anyway (text[] is a set of strings to
      // the caller), so any stable removal works.
      const remainingHashes = storedEncryptedHashes.filter((_, idx) => idx !== i);
      return { valid: true, remainingHashes };
    }
  }
  return { valid: false };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate one `XXXX-NNNN` code using crypto-strong RNG. */
function generateOneCode(): string {
  const alpha = randomFromAlphabet(SAFE_ALPHA, ALPHA_LEN);
  const digit = randomFromAlphabet(SAFE_DIGIT, DIGIT_LEN);
  return `${alpha}-${digit}`;
}

/**
 * Crypto-strong random sampling from a (small) alphabet without modulo
 * bias. Uses rejection sampling on bytes from `crypto.randomBytes`.
 */
function randomFromAlphabet(alphabet: string, length: number): string {
  const out: string[] = [];
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  while (out.length < length) {
    const buf = crypto.randomBytes(length);
    for (const b of buf) {
      if (b < max) {
        const ch = alphabet[b % alphabet.length];
        if (ch !== undefined) {
          out.push(ch);
        }
        if (out.length === length) break;
      }
    }
  }
  return out.join('');
}

/**
 * Normalise user input: uppercase, strip whitespace, ensure dash separator.
 *
 * Accepts: `abcd-1234`, `ABCD1234`, `ABCD - 1234`, `ABCD 1234` -> all
 * collapse to `ABCD-1234`.
 */
function normaliseCode(raw: string): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw.replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
  if (stripped.length !== ALPHA_LEN + DIGIT_LEN) return stripped;
  return `${stripped.slice(0, ALPHA_LEN)}-${stripped.slice(ALPHA_LEN)}`;
}

/** Format gate before bcrypt.compare to short-circuit obvious garbage. */
function isWellFormed(code: string): boolean {
  // 4 letters, dash, 4 digits — letters limited to SAFE_ALPHA, digits to
  // SAFE_DIGIT. We tolerate I/O/0/1 by *rejecting* them here rather than
  // re-mapping (ambiguity should fail loud, not silently succeed).
  return /^[A-HJKMNPQ-Z]{4}-[2-9]{4}$/.test(code);
}
