/**
 * Typed error classes for the control-center API surface (Phase H2).
 *
 * Independent copy of the app's error class pattern (see
 * `qrsiparis-app/src/lib/api/errors.ts`). Mirrors the same idea: route
 * handlers `throw` a typed error; the wrapper converts it into the canonical
 * `errorResponse(code, message, …)` shape. Auth-specific classes added
 * for the 2FA + brute-force flows.
 */
import type { ErrorCode } from './response';
import { CODE_TO_STATUS } from './response';

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/**
 * Base class for every domain-thrown API error. Carries:
 *   - `code` — machine-readable error code (drives status mapping)
 *   - `message` — Turkish-by-default user-facing string
 *   - `statusCode` — overrides `CODE_TO_STATUS[code]` when needed
 *   - `details`, `fieldErrors` — optional metadata for the client
 */
export class ApiBaseError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly fieldErrors?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      statusCode?: number;
      details?: unknown;
      fieldErrors?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = options.statusCode ?? CODE_TO_STATUS[code];
    if (options.details !== undefined) this.details = options.details;
    if (options.fieldErrors !== undefined) this.fieldErrors = options.fieldErrors;

    // Restore prototype chain after `super()` (TS / ES5 quirk).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Generic subclasses
// ---------------------------------------------------------------------------

export class ValidationError extends ApiBaseError {
  constructor(
    message = 'Geçersiz girdi',
    fieldErrors?: Record<string, string>,
    details?: unknown,
  ) {
    super('VALIDATION_ERROR', message, { fieldErrors, details });
  }
}

export class UnauthorizedError extends ApiBaseError {
  constructor(message = 'Oturum açmanız gerekiyor') {
    super('UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends ApiBaseError {
  constructor(message = 'Bu işlem için yetkiniz yok') {
    super('FORBIDDEN', message);
  }
}

export class NotFoundError extends ApiBaseError {
  constructor(message = 'Kayıt bulunamadı') {
    super('NOT_FOUND', message);
  }
}

export class ConflictError extends ApiBaseError {
  constructor(message = 'Çakışma var', details?: unknown) {
    super('CONFLICT', message, { details });
  }
}

export class RateLimitedError extends ApiBaseError {
  public readonly retryAfterSeconds: number;

  constructor(
    retryAfterSeconds: number,
    message = 'Çok fazla istek, lütfen biraz bekleyin',
  ) {
    super('RATE_LIMITED', message);
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export class InternalError extends ApiBaseError {
  public override readonly cause?: unknown;

  constructor(message = 'Beklenmeyen bir hata oluştu', cause?: unknown) {
    super('INTERNAL_ERROR', message);
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Auth-specific errors
// ---------------------------------------------------------------------------

/**
 * `401 INVALID_CREDENTIALS` — username unknown OR password mismatch.
 *
 * IMPORTANT: The error message is intentionally generic — never leak
 * "user not found" vs "wrong password". This matches the brute-force
 * mitigation (timing-attack resistance).
 */
export class InvalidCredentialsError extends ApiBaseError {
  constructor(message = 'Kullanıcı adı veya şifre hatalı') {
    super('INVALID_CREDENTIALS', message);
  }
}

/**
 * `200 NEEDS_TWO_FACTOR` — username+password OK, but the user has 2FA
 * enabled and didn't supply a TOTP/backup code with the login request.
 *
 * Status is 200 because the request "succeeded" — the server is just
 * telling the client what the next required step is. The frontend should
 * redirect to `/2fa-verify` (carrying the partial-auth state via cookie).
 */
export class NeedsTwoFactorError extends ApiBaseError {
  constructor(message = 'İki faktörlü doğrulama kodu gerekli') {
    super('NEEDS_TWO_FACTOR', message);
  }
}

/**
 * `401 INVALID_TOTP` — TOTP code did not validate (wrong digits or expired).
 */
export class InvalidTotpError extends ApiBaseError {
  constructor(message = 'Doğrulama kodu hatalı veya süresi dolmuş') {
    super('INVALID_TOTP', message);
  }
}

/**
 * `401 INVALID_BACKUP_CODE` — backup code unknown or already consumed.
 */
export class InvalidBackupCodeError extends ApiBaseError {
  constructor(message = 'Yedek kod hatalı veya kullanılmış') {
    super('INVALID_BACKUP_CODE', message);
  }
}

/**
 * `429 LOCKED_OUT` — too many failed login attempts; user is temporarily
 * locked out. Even a correct password is rejected during the lockout
 * window (15 min per IMPL §3 R12).
 */
export class LockedOutError extends ApiBaseError {
  public readonly retryAfterSeconds: number;

  constructor(
    retryAfterSeconds: number,
    message = 'Çok fazla başarısız deneme — hesap 15 dakika kilitlendi',
  ) {
    super('LOCKED_OUT', message);
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

/**
 * `403 IP_NOT_WHITELISTED` — request IP is not in the allowlist
 * (Doc 17 §11.1). Implemented at app middleware level when env-configured;
 * transparent in dev when allowlist is empty.
 */
export class IpNotWhitelistedError extends ApiBaseError {
  constructor(message = 'Bu IP adresinden erişim engellendi') {
    super('IP_NOT_WHITELISTED', message);
  }
}

/**
 * `422 TWO_FACTOR_NOT_ENABLED` — operation requires 2FA but the user
 * hasn't completed setup yet. Used by routes that need 2FA-confirmed
 * sessions (e.g. operator user CRUD in Phase H10).
 */
export class TwoFactorNotEnabledError extends ApiBaseError {
  constructor(
    message = 'Bu işlem için iki faktörlü doğrulama gerekli — lütfen önce 2FA kurun',
  ) {
    super('TWO_FACTOR_NOT_ENABLED', message);
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isApiError(value: unknown): value is ApiBaseError {
  return value instanceof ApiBaseError;
}
