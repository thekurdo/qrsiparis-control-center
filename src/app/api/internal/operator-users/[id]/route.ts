/**
 * Operator-users CRUD — per-id routes (Phase H10).
 *
 * GET    /api/internal/operator-users/:id  — fetch single user (no secrets)
 * PATCH  /api/internal/operator-users/:id  — update fields
 * DELETE /api/internal/operator-users/:id  — soft-delete (is_active = false)
 *
 * Self-protection rules (admin must NOT brick their own session):
 *   - DELETE on own row → 403 FORBIDDEN
 *   - PATCH `isActive=false` on own row → 403 FORBIDDEN
 *   - PATCH `role` change on own row IS allowed (admin demoting themselves
 *     is a legitimate dual-control move; we only block account disable).
 *
 * Patchable fields:
 *   - username, email — uniqueness re-checked on change
 *   - fullName        — free text
 *   - role            — admin | operator
 *   - isActive        — boolean (with self-disable guard)
 *   - password        — optional; bcrypt-hashed if present (12 rounds)
 *
 * Audit: writes `operator_user.updated` / `operator_user.deleted` with the
 * changed-keys list as metadata so we can later report "what was edited
 * when" without exposing values.
 */

import { and, eq, ne, or } from 'drizzle-orm';
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
import { hashPassword, validatePasswordPolicy } from '@/lib/auth/password';
import { recordAudit } from '@/lib/cc/audit';

const usernameRegex = /^[a-z0-9_-]+$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireOperatorAuth(['admin']);
  const { id } = await params;

  const [row] = await db
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
      failedLoginAttempts: operatorUsers.failedLoginAttempts,
      createdAt: operatorUsers.createdAt,
      updatedAt: operatorUsers.updatedAt,
    })
    .from(operatorUsers)
    .where(eq(operatorUsers.id, id))
    .limit(1);

  if (!row) {
    return errorResponse('NOT_FOUND', 'Kullanıcı bulunamadı');
  }
  return successResponse(row);
}

interface PatchBody {
  username?: unknown;
  email?: unknown;
  fullName?: unknown;
  role?: unknown;
  isActive?: unknown;
  password?: unknown;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireOperatorAuth(['admin']);
  const { id } = await params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return errorResponse('VALIDATION_ERROR', 'Geçersiz JSON gövdesi');
  }

  // Load the existing row first so we can compare against current values
  // (for change-detection + uniqueness scoping).
  const [existing] = await db
    .select()
    .from(operatorUsers)
    .where(eq(operatorUsers.id, id))
    .limit(1);
  if (!existing) {
    return errorResponse('NOT_FOUND', 'Kullanıcı bulunamadı');
  }

  const fieldErrors: Record<string, string> = {};
  const updates: Partial<typeof operatorUsers.$inferInsert> = {};
  const changedKeys: string[] = [];

  // username
  if (typeof body.username === 'string') {
    const v = body.username.trim();
    if (v !== existing.username) {
      if (v.length < 3 || v.length > 50) {
        fieldErrors.username = 'Kullanıcı adı 3-50 karakter olmalı';
      } else if (!usernameRegex.test(v)) {
        fieldErrors.username =
          "Sadece küçük harf, rakam, '_' ve '-' kullanılabilir";
      } else {
        updates.username = v;
        changedKeys.push('username');
      }
    }
  }

  // email
  if (typeof body.email === 'string') {
    const v = body.email.trim();
    if (v !== existing.email) {
      if (!/^\S+@\S+\.\S+$/.test(v)) {
        fieldErrors.email = 'Geçerli bir e-posta giriniz';
      } else {
        updates.email = v;
        changedKeys.push('email');
      }
    }
  }

  // fullName
  if (typeof body.fullName === 'string') {
    const v = body.fullName.trim();
    if (v !== existing.fullName) {
      if (v.length < 2) {
        fieldErrors.fullName = 'Tam ad gerekli';
      } else {
        updates.fullName = v;
        changedKeys.push('fullName');
      }
    }
  }

  // role
  if (body.role === 'admin' || body.role === 'operator') {
    if (body.role !== existing.role) {
      updates.role = body.role;
      changedKeys.push('role');
    }
  } else if (body.role !== undefined) {
    fieldErrors.role = "Rol 'admin' veya 'operator' olmalı";
  }

  // isActive — with self-disable guard
  if (typeof body.isActive === 'boolean') {
    if (body.isActive !== existing.isActive) {
      if (!body.isActive && id === session.user.id) {
        return errorResponse(
          'FORBIDDEN',
          'Kendi hesabınızı pasifleştiremezsiniz',
        );
      }
      updates.isActive = body.isActive;
      changedKeys.push('isActive');
    }
  }

  // password (optional)
  if (typeof body.password === 'string' && body.password.length > 0) {
    const pwCheck = validatePasswordPolicy(body.password);
    if (!pwCheck.valid) {
      fieldErrors.password = pwCheck.reason;
    } else {
      updates.passwordHash = await hashPassword(body.password);
      changedKeys.push('password');
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return errorResponse('VALIDATION_ERROR', 'Form alanlarını kontrol edin', {
      fieldErrors,
    });
  }

  if (changedKeys.length === 0) {
    // No-op: nothing to update. Return success without auditing anything.
    return successResponse({ id, changed: [] });
  }

  // Uniqueness check for username/email if either changed.
  if (updates.username !== undefined || updates.email !== undefined) {
    const conflictRows = await db
      .select({
        id: operatorUsers.id,
        username: operatorUsers.username,
        email: operatorUsers.email,
      })
      .from(operatorUsers)
      .where(
        and(
          ne(operatorUsers.id, id),
          or(
            updates.username !== undefined
              ? eq(operatorUsers.username, updates.username)
              : undefined,
            updates.email !== undefined
              ? eq(operatorUsers.email, updates.email)
              : undefined,
          ),
        ),
      );

    if (conflictRows.length > 0) {
      const conflicts: Record<string, string> = {};
      for (const row of conflictRows) {
        if (updates.username !== undefined && row.username === updates.username) {
          conflicts.username = 'Bu kullanıcı adı kullanılıyor';
        }
        if (updates.email !== undefined && row.email === updates.email) {
          conflicts.email = 'Bu e-posta kullanılıyor';
        }
      }
      return errorResponse(
        'CONFLICT',
        'Kullanıcı adı veya e-posta zaten kayıtlı',
        { fieldErrors: conflicts },
      );
    }
  }

  try {
    await db
      .update(operatorUsers)
      .set(updates)
      .where(eq(operatorUsers.id, id));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (/duplicate key/i.test(message) || /unique/i.test(message)) {
      return errorResponse('CONFLICT', 'Kullanıcı adı veya e-posta zaten kayıtlı');
    }
    // eslint-disable-next-line no-console
    console.error('[operator-users][PATCH] update failed', err);
    return errorResponse('INTERNAL_ERROR', 'Güncelleme başarısız');
  }

  const ipAddress = getClientIp(req);
  const userAgent = getUserAgent(req);

  await recordAudit({
    userId: session.user.id,
    action: 'operator_user.updated',
    entityType: 'operator_user',
    entityId: id,
    metadata: { changed: changedKeys },
    ipAddress,
    userAgent,
  });

  // Role demotion / promotion is a security-relevant event that deserves a
  // dedicated audit action so admins can filter the log for "who changed
  // someone's role and when" without scanning every `operator_user.updated`
  // metadata blob. Convention is snake_case (matches `backup_code_used`
  // from S12 — see src/lib/auth/operator.ts).
  if (updates.role !== undefined && updates.role !== existing.role) {
    await recordAudit({
      userId: session.user.id,
      action: 'operator_role_changed',
      entityType: 'operator_user',
      entityId: id,
      metadata: {
        username: existing.username,
        oldRole: existing.role,
        newRole: updates.role,
      },
      ipAddress,
      userAgent,
    });
  }

  return successResponse({ id, changed: changedKeys });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireOperatorAuth(['admin']);
  const { id } = await params;

  if (id === session.user.id) {
    return errorResponse('FORBIDDEN', 'Kendi hesabınızı silemezsiniz');
  }

  const [existing] = await db
    .select({
      id: operatorUsers.id,
      username: operatorUsers.username,
      isActive: operatorUsers.isActive,
    })
    .from(operatorUsers)
    .where(eq(operatorUsers.id, id))
    .limit(1);
  if (!existing) {
    return errorResponse('NOT_FOUND', 'Kullanıcı bulunamadı');
  }

  // Soft-delete: keep audit trail. We just toggle isActive=false. The
  // operator_user.created audit row remains, so we have a complete
  // creation→deletion record.
  if (existing.isActive) {
    await db
      .update(operatorUsers)
      .set({ isActive: false })
      .where(eq(operatorUsers.id, id));
  }

  await recordAudit({
    userId: session.user.id,
    action: 'operator_user.deleted',
    entityType: 'operator_user',
    entityId: id,
    metadata: { username: existing.username, soft: true },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  return successResponse({ id, deleted: true });
}
