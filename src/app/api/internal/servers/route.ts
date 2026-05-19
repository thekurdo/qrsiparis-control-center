/**
 * POST /api/internal/servers — add a VPS to the fleet (Phase H4 wire-up).
 *
 * Auth: admin only (write surface; IMPL §3 R13).
 *
 * Body (matches the `/sunucular/yeni` form payload):
 *   {
 *     name: string,                  // VPS label, unique
 *     publicIp: string,              // dotted IPv4
 *     publicHostname?: string,
 *     sshPort?: number,              // default 22
 *     sshUser?: string,              // default 'root'
 *     sshPrivateKey: string,         // PEM — encrypted at rest
 *     coolifyUrl: string,
 *     coolifyApiToken: string,       // encrypted at rest
 *     location?: string,             // accepted but not stored (no column yet)
 *     maxTenantsTheoretical?: number,// default 20 (IMPL §1.PB3)
 *     notes?: string,                // accepted but not stored (no column yet)
 *   }
 *
 * Side effects:
 *   - INSERT servers row with status='active' and the IMPL-default
 *     per-tenant CPU / RAM bounds. `totalCpuCores` / `totalRamMb` /
 *     `totalDiskGb` are seeded with the Hostinger VPS plan defaults
 *     (4 / 16384 / 100); the health-probe cron backfills the real values
 *     on the first poll.
 *   - INSERT audit_log `server.created`.
 *
 * Response: the full inserted server row (sans encrypted secrets) so the
 * wizard can redirect to its detail page if needed. 201 on success.
 *
 * Conflict handling mirrors /api/internal/tenants: unique-violation on
 * `uq_servers_name` returns 409 with a `fieldErrors.name` payload.
 *
 * Why we tolerate-and-ignore `location` / `notes`: the form was wired
 * before the schema was finalised; rather than fail the request we
 * accept the fields and drop them. A future migration (V1.5+) can add
 * the columns and start persisting.
 */

import { type NextRequest } from 'next/server';
import { z } from 'zod';

import { db } from '@/db/client';
import { auditLog, servers } from '@/db/schema';
import {
  errorResponse,
  getClientIp,
  getUserAgent,
  successResponse,
} from '@/lib/api/response';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { recordAudit } from '@/lib/cc/audit';
import { encrypt } from '@/lib/crypto/aes-gcm';

const bodySchema = z
  .object({
    name: z.string().min(1).max(100),
    publicIp: z
      .string()
      .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'Geçerli bir IPv4 girin'),
    publicHostname: z
      .string()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    sshPort: z.number().int().min(1).max(65535).optional(),
    sshUser: z
      .string()
      .min(1)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    sshPrivateKey: z.string().min(1),
    coolifyUrl: z.string().url(),
    coolifyApiToken: z.string().min(1),
    location: z.string().optional().nullable(),
    maxTenantsTheoretical: z.number().int().min(1).max(50).optional(),
    notes: z.string().optional().nullable(),
  })
  .passthrough();

type ServerBody = z.infer<typeof bodySchema>;

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
}

function findPgError(err: unknown): PgLikeError | null {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
    if (current && typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      if (typeof obj['code'] === 'string' && /^\d{5}$/.test(obj['code'])) {
        return {
          code: obj['code'],
          constraint:
            typeof obj['constraint'] === 'string'
              ? obj['constraint']
              : undefined,
          detail:
            typeof obj['detail'] === 'string' ? obj['detail'] : undefined,
        };
      }
      current = obj['cause'];
    } else {
      break;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const session = await requireOperatorAuth(['admin']);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('VALIDATION_ERROR', 'Geçersiz JSON gövdesi');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const rawFieldErrors = parsed.error.flatten().fieldErrors;
    const fieldErrors: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawFieldErrors)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
        fieldErrors[k] = v[0];
      }
    }
    return errorResponse('VALIDATION_ERROR', 'Form alanlarını kontrol edin', {
      fieldErrors,
    });
  }

  const data: ServerBody = parsed.data;

  // Encrypt secrets up-front so a crypto-config failure (missing
  // MASTER_KEY) doesn't leave a half-written row.
  let sshPrivateKeyEncrypted: string;
  let coolifyApiTokenEncrypted: string;
  try {
    sshPrivateKeyEncrypted = encrypt(data.sshPrivateKey);
    coolifyApiTokenEncrypted = encrypt(data.coolifyApiToken);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[servers][POST] encrypt failed', err);
    return errorResponse('INTERNAL_ERROR', 'Şifreleme başarısız');
  }

  let inserted: { id: string };
  try {
    inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(servers)
        .values({
          name: data.name,
          publicIp: data.publicIp,
          publicHostname: data.publicHostname ?? null,
          sshPort: data.sshPort ?? 22,
          sshUser: data.sshUser ?? 'root',
          sshPrivateKeyEncrypted,
          // Hostinger VPS plan defaults — the health-probe cron overwrites
          // these on the first poll with the real `nproc` / `free -m` /
          // `df -h /` figures.
          totalCpuCores: 4,
          totalRamMb: 16384,
          totalDiskGb: 100,
          maxTenantsTheoretical: data.maxTenantsTheoretical ?? 20,
          coolifyUrl: data.coolifyUrl,
          coolifyApiTokenEncrypted,
          status: 'active',
        })
        .returning({
          id: servers.id,
          name: servers.name,
          publicIp: servers.publicIp,
          publicHostname: servers.publicHostname,
          sshPort: servers.sshPort,
          sshUser: servers.sshUser,
          coolifyUrl: servers.coolifyUrl,
          maxTenantsTheoretical: servers.maxTenantsTheoretical,
          status: servers.status,
          createdAt: servers.createdAt,
        });

      const row = rows[0];
      if (!row) throw new Error('insert returned no row');

      await tx.insert(auditLog).values({
        userId: session.user.id,
        action: 'server.created',
        entityType: 'server',
        entityId: row.id,
        metadata: {
          name: data.name,
          publicIp: data.publicIp,
          coolifyUrl: data.coolifyUrl,
        },
        ipAddress: null,
        userAgent: null,
      });

      return row;
    });
  } catch (err) {
    const pgErr = findPgError(err);
    const message = err instanceof Error ? err.message : 'unknown';
    const isUniqueViolation =
      pgErr?.code === '23505' ||
      /duplicate key/i.test(message) ||
      /unique/i.test(message);

    if (isUniqueViolation) {
      const constraint = pgErr?.constraint ?? '';
      const conflicts: Record<string, string> = {};
      if (constraint === 'uq_servers_name' || /\bname\b/i.test(message)) {
        conflicts.name = 'Bu sunucu etiketi kullanılıyor';
      }
      return errorResponse('CONFLICT', 'Sunucu etiketi zaten kayıtlı', {
        fieldErrors: conflicts,
      });
    }
    // eslint-disable-next-line no-console
    console.error('[servers][POST] insert failed', err);
    return errorResponse('INTERNAL_ERROR', 'Sunucu oluşturulamadı');
  }

  await recordAudit({
    userId: session.user.id,
    action: 'server.created',
    entityType: 'server',
    entityId: inserted.id,
    metadata: { name: data.name, publicIp: data.publicIp },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });

  return successResponse(inserted, { status: 201 });
}
