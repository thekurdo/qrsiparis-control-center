/**
 * Operator-users CRUD — collection routes (Phase H10).
 *
 * GET   /api/internal/operator-users   — list (admin only)
 * POST  /api/internal/operator-users   — create (admin only)
 *
 * Both endpoints require an admin session. Operators (role='operator')
 * cannot manage other users per IMPL §3 R13.
 *
 * POST validation:
 *   - username      regex /^[a-z0-9_-]+$/, 3-50 chars, must be unique
 *   - fullName      ≥ 2 chars
 *   - email         RFC-ish, must be unique
 *   - password      validatePasswordPolicy() (8+ chars, 1 letter, 1 digit)
 *   - role          'admin' | 'operator'
 *   - isActive      boolean (defaults to true)
 *
 * Conflict surface:
 *   - Username collision → 409 CONFLICT (fieldErrors.username)
 *   - Email collision    → 409 CONFLICT (fieldErrors.email)
 *
 * Audit: writes `operator_user.created` with the new user id as entityId.
 */

import { eq, or } from 'drizzle-orm';
import type { NextRequest } from 'next/server';

import { db } from '@/db/client';
import { operatorUsers } from '@/db/schema';
import { errorResponse, getClientIp, getUserAgent, successResponse } from '@/lib/api/response';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { hashPassword, validatePasswordPolicy } from '@/lib/auth/password';
import { recordAudit } from '@/lib/cc/audit';

const usernameRegex = /^[a-z0-9_-]+$/;

export async function GET() {
  await requireOperatorAuth(['admin']);

  const rows = await db
    .select({
      id: operatorUsers.id,
      username: operatorUsers.username,
      email: operatorUsers.email,
      fullName: operatorUsers.fullName,
      role: operatorUsers.role,
      isActive: operatorUsers.isActive,
      twoFactorEnabled: operatorUsers.twoFactorEnabled,
      lastLoginAt: operatorUsers.lastLoginAt,
      failedLoginLockedUntil: operatorUsers.failedLoginLockedUntil,
      createdAt: operatorUsers.createdAt,
      updatedAt: operatorUsers.updatedAt,
    })
    .from(operatorUsers)
    .orderBy(operatorUsers.createdAt);

  return successResponse(rows);
}

interface CreateBody {
  username?: unknown;
  fullName?: unknown;
  email?: unknown;
  password?: unknown;
  role?: unknown;
  isActive?: unknown;
}

export async function POST(req: NextRequest) {
  const session = await requireOperatorAuth(['admin']);

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return errorResponse('VALIDATION_ERROR', 'Geçersiz JSON gövdesi');
  }

  const fieldErrors: Record<string, string> = {};

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (username.length < 3 || username.length > 50) {
    fieldErrors.username = 'Kullanıcı adı 3-50 karakter olmalı';
  } else if (!usernameRegex.test(username)) {
    fieldErrors.username = "Sadece küçük harf, rakam, '_' ve '-' kullanılabilir";
  }

  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  if (fullName.length < 2) {
    fieldErrors.fullName = 'Tam ad gerekli';
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    fieldErrors.email = 'Geçerli bir e-posta giriniz';
  }

  const password = typeof body.password === 'string' ? body.password : '';
  const pwCheck = validatePasswordPolicy(password);
  if (!pwCheck.valid) {
    fieldErrors.password = pwCheck.reason;
  }

  const role = body.role === 'admin' || body.role === 'operator' ? body.role : null;
  if (!role) {
    fieldErrors.role = "Rol 'admin' veya 'operator' olmalı";
  }

  const isActive = typeof body.isActive === 'boolean' ? body.isActive : true;

  if (Object.keys(fieldErrors).length > 0) {
    return errorResponse('VALIDATION_ERROR', 'Form alanlarını kontrol edin', {
      fieldErrors,
    });
  }

  // Uniqueness pre-check. The DB unique indexes are the source of truth, but
  // a pre-check yields friendlier per-field error messages.
  const existing = await db
    .select({ id: operatorUsers.id, username: operatorUsers.username, email: operatorUsers.email })
    .from(operatorUsers)
    .where(or(eq(operatorUsers.username, username), eq(operatorUsers.email, email)));

  if (existing.length > 0) {
    const conflicts: Record<string, string> = {};
    for (const row of existing) {
      if (row.username === username) conflicts.username = 'Bu kullanıcı adı kullanılıyor';
      if (row.email === email) conflicts.email = 'Bu e-posta kullanılıyor';
    }
    return errorResponse('CONFLICT', 'Kullanıcı adı veya e-posta zaten kayıtlı', {
      fieldErrors: conflicts,
    });
  }

  const passwordHash = await hashPassword(password);

  let inserted: { id: string };
  try {
    const rows = await db
      .insert(operatorUsers)
      .values({
        username,
        email,
        fullName,
        passwordHash,
        // role validated above; non-null asserted via the if-guard
        role: role!,
        isActive,
      })
      .returning({ id: operatorUsers.id });
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    inserted = row;
  } catch (err) {
    // Race-window safety: a unique index can still trip us if two parallel
    // requests slip through the pre-check.
    const message = err instanceof Error ? err.message : 'unknown';
    if (/duplicate key/i.test(message) || /unique/i.test(message)) {
      return errorResponse('CONFLICT', 'Kullanıcı adı veya e-posta zaten kayıtlı');
    }
    // eslint-disable-next-line no-console
    console.error('[operator-users][POST] insert failed', err);
    return errorResponse('INTERNAL_ERROR', 'Kullanıcı oluşturulamadı');
  }

  await recordAudit({
    userId: session.user.id,
    action: 'operator_user.created',
    entityType: 'operator_user',
    entityId: inserted.id,
    metadata: { username, role, isActive },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  return successResponse({ id: inserted.id, username, email, fullName, role, isActive }, {
    status: 201,
  });
}
