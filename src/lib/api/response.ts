/**
 * Control-Center API response envelope (Phase H2).
 *
 * Mirrors `qrsiparis-app/src/lib/api/response.ts` (independent copy — the
 * control-center is a separate codebase per IMPLEMENTATION_NOTES.md §1 PB1
 * + Doc 17 §1). The shape is identical so frontend client code can be
 * lifted between repos with minimal friction.
 *
 * Why a copy and not a shared package:
 *   The two repos may diverge (control-center has internal-only error codes
 *   like NEEDS_TWO_FACTOR, IP_NOT_WHITELISTED). A shared package would bind
 *   their release cycles. Pragmatic copy + small surface keeps things simple.
 *
 * All Route handlers MUST use these helpers so the response shape is
 * uniform across the surface — frontends rely on the
 * `{ success, data | error }` discriminator being present everywhere.
 *
 * Error message language: Turkish (control-center is TR-only V1, Doc 17 §1).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Error code enum (control-center surface)
// ---------------------------------------------------------------------------

/**
 * Canonical list of API error codes for the control-center. Closed set —
 * adding a code is a deliberate decision (update CODE_TO_STATUS in
 * lockstep).
 *
 * Auth-specific codes:
 *   - NEEDS_TWO_FACTOR    — username+password OK, but TOTP/backup required
 *   - INVALID_CREDENTIALS — username or password wrong
 *   - INVALID_TOTP        — TOTP code did not validate
 *   - INVALID_BACKUP_CODE — backup code unknown or already consumed
 *   - LOCKED_OUT          — too many failed attempts; user temporarily locked
 *   - IP_NOT_WHITELISTED  — request from a non-allowlisted IP (Doc 17 §11.1)
 *   - TWO_FACTOR_NOT_ENABLED — operation requires 2FA but it isn't set up yet
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'BUSINESS_RULE_VIOLATION',
  'INTERNAL_ERROR',
  // — auth extensions —
  'NEEDS_TWO_FACTOR',
  'INVALID_CREDENTIALS',
  'INVALID_TOTP',
  'INVALID_BACKUP_CODE',
  'LOCKED_OUT',
  'IP_NOT_WHITELISTED',
  'TWO_FACTOR_NOT_ENABLED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Map an `ErrorCode` to its HTTP status code.
 *
 * NEEDS_TWO_FACTOR = 200 (the request "succeeded" — server tells the client
 * the next required step). Frontend redirects to /2fa-verify on this code.
 */
export const CODE_TO_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  BUSINESS_RULE_VIOLATION: 422,
  INTERNAL_ERROR: 500,
  NEEDS_TWO_FACTOR: 200,
  INVALID_CREDENTIALS: 401,
  INVALID_TOTP: 401,
  INVALID_BACKUP_CODE: 401,
  LOCKED_OUT: 429,
  IP_NOT_WHITELISTED: 403,
  TWO_FACTOR_NOT_ENABLED: 422,
};

// ---------------------------------------------------------------------------
// Type definitions (the discriminated union frontends consume)
// ---------------------------------------------------------------------------

export type SuccessResponse<T> = {
  success: true;
  data: T;
};

export type ApiError = {
  code: ErrorCode;
  message: string;
  details?: unknown;
  fieldErrors?: Record<string, string>;
};

export type ErrorResponse = {
  success: false;
  error: ApiError;
};

export type ApiResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type SuccessResponseOptions = {
  status?: number;
  headers?: HeadersInit;
};

export function successResponse<T>(
  data: T,
  options: SuccessResponseOptions = {},
): NextResponse<SuccessResponse<T>> {
  const status = options.status ?? 200;
  return NextResponse.json<SuccessResponse<T>>(
    { success: true, data },
    { status, headers: options.headers },
  );
}

export function noContentResponse(headers?: HeadersInit): NextResponse {
  return new NextResponse(null, { status: 204, headers });
}

export type ErrorResponseOptions = {
  status?: number;
  details?: unknown;
  fieldErrors?: Record<string, string>;
  headers?: HeadersInit;
};

/**
 * Build an error JSON response with the failure envelope.
 *
 * Status defaults to the `CODE_TO_STATUS` map; pass an explicit `status`
 * to override (rare).
 */
export function errorResponse(
  code: ErrorCode,
  message: string,
  options: ErrorResponseOptions = {},
): NextResponse<ErrorResponse> {
  const status = options.status ?? CODE_TO_STATUS[code];

  const error: ApiError = { code, message };
  if (options.details !== undefined) {
    error.details = options.details;
  }
  if (options.fieldErrors !== undefined) {
    error.fieldErrors = options.fieldErrors;
  }

  return NextResponse.json<ErrorResponse>(
    { success: false, error },
    { status, headers: options.headers },
  );
}

export function validationErrorResponse(
  message: string,
  fieldErrors?: Record<string, string>,
  details?: unknown,
): NextResponse<ErrorResponse> {
  return errorResponse('VALIDATION_ERROR', message, { fieldErrors, details });
}

export function unauthorizedResponse(
  message = 'Oturum açmanız gerekiyor',
): NextResponse<ErrorResponse> {
  return errorResponse('UNAUTHORIZED', message);
}

export function forbiddenResponse(
  message = 'Bu işlem için yetkiniz yok',
): NextResponse<ErrorResponse> {
  return errorResponse('FORBIDDEN', message);
}

export function notFoundResponse(
  message = 'Kayıt bulunamadı',
): NextResponse<ErrorResponse> {
  return errorResponse('NOT_FOUND', message);
}

export function conflictResponse(
  message = 'Çakışma',
  details?: unknown,
): NextResponse<ErrorResponse> {
  return errorResponse('CONFLICT', message, { details });
}

export function rateLimitedResponse(
  retryAfterSeconds: number,
  message = 'Çok fazla istek, lütfen biraz bekleyin',
): NextResponse<ErrorResponse> {
  return errorResponse('RATE_LIMITED', message, {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

export function lockedOutResponse(
  retryAfterSeconds: number,
  message = 'Çok fazla başarısız deneme — hesap geçici olarak kilitlendi',
): NextResponse<ErrorResponse> {
  return errorResponse('LOCKED_OUT', message, {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

export function internalErrorResponse(
  message = 'Beklenmeyen bir hata oluştu',
  details?: unknown,
): NextResponse<ErrorResponse> {
  return errorResponse('INTERNAL_ERROR', message, { details });
}

// ---------------------------------------------------------------------------
// Request helpers (IP extraction, UA, etc.)
// ---------------------------------------------------------------------------

/**
 * Best-effort client-IP extraction from the standard proxy headers.
 *
 * Coolify / Traefik forward the original IP via `x-forwarded-for` (comma-
 * separated chain — the first entry is the originating client). Fall back
 * to `x-real-ip` and finally to a sentinel string so rate-limit keys never
 * collapse to `undefined`.
 */
export function getClientIp(request: Request | NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp && realIp.length > 0) return realIp;
  return 'unknown';
}

/**
 * Read the `User-Agent` header with a stable fallback so audit log writes
 * don't insert NULLs when the browser stripped it.
 */
export function getUserAgent(request: Request | NextRequest): string {
  return request.headers.get('user-agent') ?? 'unknown';
}
