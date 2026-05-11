/**
 * Audit-log writer for control-center route handlers (Phase H10).
 *
 * Inserts a row into `audit_log` with:
 *   - userId (operator who triggered the action; nullable for system writes)
 *   - action (canonical dotted name, e.g. `operator_user.created`)
 *   - entityType / entityId (target — operator user id, server id, etc.)
 *   - metadata (free-form JSON; keep it small and PII-free)
 *   - ipAddress + userAgent (SHA-256 hashed for KVKK compliance per
 *     Doc 17 §11.1 — raw IPs MUST NOT be persisted)
 *
 * The `audit_log` table has an immutable trigger (UPDATE/DELETE rejected),
 * so this is genuinely append-only at the DB layer too.
 *
 * Why hash IP+UA: KVKK gate (Doc 17 §11) requires that personal-data fields
 * we don't strictly need in plaintext be hashed. Hashing instead of dropping
 * preserves the "did request X come from same source as request Y" property
 * for forensics without retaining raw identifiers.
 */

import crypto from 'node:crypto';

import { db } from '@/db/client';
import { auditLog } from '@/db/schema';

/**
 * Stable SHA-256 hash for audit log identifier columns. Returns 64 hex chars.
 *
 * `value` may be undefined / null (e.g. some headers are absent); in that
 * case we hash the string `'unknown'` so the column is never NULL — easier
 * for indexes and queries.
 */
function hashIdentifier(value: string | null | undefined): string {
  return crypto
    .createHash('sha256')
    .update(value && value.length > 0 ? value : 'unknown')
    .digest('hex');
}

export interface RecordAuditOptions {
  /** Operator user ID — null for system actions. */
  userId: string | null;
  /** Canonical action name, e.g. `operator_user.created`. */
  action: string;
  /** Logical entity type, e.g. `operator_user`. */
  entityType?: string | null;
  /** Logical entity id (UUID or arbitrary string). */
  entityId?: string | null;
  /** Free-form metadata. Keep it small and PII-free. */
  metadata?: Record<string, unknown> | null;
  /** Raw IP — will be SHA-256 hashed before write. */
  ipAddress?: string | null;
  /** Raw user-agent — will be SHA-256 hashed before write. */
  userAgent?: string | null;
}

/**
 * Insert one audit-log row. Never throws — audit failures should not break
 * the user-facing operation. If the insert fails (DB pool exhaustion etc.)
 * we log to stderr and continue.
 */
export async function recordAudit(opts: RecordAuditOptions): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId: opts.userId,
      action: opts.action,
      entityType: opts.entityType ?? null,
      entityId: opts.entityId ?? null,
      metadata: (opts.metadata ?? null) as never,
      ipAddress: hashIdentifier(opts.ipAddress),
      userAgent: hashIdentifier(opts.userAgent),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record audit log', {
      action: opts.action,
      entityId: opts.entityId,
      err,
    });
  }
}
