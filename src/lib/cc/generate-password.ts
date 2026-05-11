/**
 * Cryptographically-strong random password generator (Phase H10).
 *
 * Used for:
 *   - Operator user create form ("Otomatik Oluştur" button)
 *   - Operator password reset (admin-triggered) — generates a new password
 *     that's transmitted to the operator once via the reset dialog and
 *     immediately bcrypt-hashed on the server.
 *
 * Properties:
 *   - 16 chars by default (configurable). At ≈ 70-char alphabet that's ~98
 *     bits of entropy — well above any policy floor.
 *   - Guarantees at least one lowercase letter AND one digit (matches
 *     `validatePasswordPolicy()` in lib/auth/password.ts).
 *   - Excludes ambiguous characters (`I O 0 1 l`) so the password can be
 *     read aloud / typed without confusion.
 *   - Symbols included by default for additional entropy. Pass
 *     `{ symbols: false }` if the deployment target rejects them.
 *
 * Crypto-strength: uses `crypto.randomBytes` with rejection sampling to
 * avoid modulo bias on the alphabet selection.
 */

import crypto from 'node:crypto';

const LOWER = 'abcdefghjkmnpqrstuvwxyz'; // no l
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, O
const DIGIT = '23456789'; // no 0, 1
const SYMBOL = '!@#$%^&*+-=?_';

export interface GeneratePasswordOptions {
  length?: number;
  symbols?: boolean;
}

/**
 * Generate a strong random password. Default 16 chars, symbols enabled.
 *
 * The first three positions of the returned string are guaranteed to be
 * lowercase / uppercase / digit (one each), so the resulting password
 * always satisfies `validatePasswordPolicy()`. The remaining positions are
 * sampled uniformly from the full pool, then the whole string is shuffled.
 */
export function generatePassword(options: GeneratePasswordOptions = {}): string {
  const length = Math.max(8, Math.min(128, options.length ?? 16));
  const useSymbols = options.symbols !== false;

  const pool = LOWER + UPPER + DIGIT + (useSymbols ? SYMBOL : '');

  const seed: string[] = [
    pickOne(LOWER),
    pickOne(UPPER),
    pickOne(DIGIT),
  ];
  if (useSymbols) seed.push(pickOne(SYMBOL));

  while (seed.length < length) {
    seed.push(pickOne(pool));
  }
  return shuffle(seed).join('');
}

/** Crypto-strong rejection sampling from `alphabet`. */
function pickOne(alphabet: string): string {
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const buf = crypto.randomBytes(1);
    const b = buf[0]!;
    if (b < max) {
      const ch = alphabet[b % alphabet.length];
      if (ch !== undefined) return ch;
    }
  }
}

/** Fisher-Yates with crypto RNG. */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const buf = crypto.randomBytes(4);
    const r = buf.readUInt32BE(0);
    const j = r % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
