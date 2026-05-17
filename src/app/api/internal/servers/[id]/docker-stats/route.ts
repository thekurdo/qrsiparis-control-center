/**
 * GET /api/internal/servers/[id]/docker-stats — live container stats (S3).
 *
 * Calls `docker stats --no-stream --format json` over SSH on the target
 * VPS and returns the parsed JSON. Used by the server detail page's "Mock
 * SSH" panel so operators can eyeball CPU% / mem usage without leaving the
 * panel.
 *
 * Auth: any authenticated operator. Read-only command, no mutations.
 *
 * Selection of the SSH backend (real ssh2 vs in-memory mock) happens in
 * `getSshClient()` based on `TEST_MODE=mock`. In mock mode the canned
 * response in `client-mock.ts` is returned verbatim — the encrypted
 * private key on the row is NOT decrypted (mock ignores it).
 *
 * Why GET (not POST):
 *   The action is idempotent and side-effect-free. Browsers can cache the
 *   response via Cache-Control headers if we ever want to (we currently
 *   force no-store to keep stats fresh on reload).
 *
 * Error surface:
 *   - NOT_FOUND        — server id doesn't exist
 *   - INTERNAL_ERROR   — SSH connect/exec/parse failed
 *
 * Response shape on success (matches the `docker stats` mock):
 *   {
 *     name:     string,   // container name
 *     cpuPerc:  string,   // e.g. "4.5%"
 *     memUsage: string,   // e.g. "320MiB / 768MiB"
 *     memPerc:  string,   // e.g. "41.67%"
 *     netIO:    string,   // e.g. "12.4MB / 8.1MB"
 *     raw:      unknown,  // parsed JSON as-is, for the rare future caller
 *   }
 *
 * Downstream notes (S19 backup cron):
 *   S19 will run `pg_dump`/`tar` over SSH on the same connection class.
 *   Both routes go through `getSshClient()` → `connect()` → `exec()`, so
 *   the mock failure-injection knob (`SSH_MOCK_FAIL=connect|auth|timeout`)
 *   exercises both this route and S19's cron the same way.
 */

import { eq } from 'drizzle-orm';
import { type NextRequest } from 'next/server';

import { db } from '@/db/client';
import { servers } from '@/db/schema';
import { errorResponse, successResponse } from '@/lib/api/response';
import { requireOperatorAuth } from '@/lib/auth/middleware';
import { decryptNullable } from '@/lib/crypto/aes-gcm';
import { getSshClient } from '@/lib/ssh';

interface DockerStatsRaw {
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  NetIO?: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireOperatorAuth();
  const { id } = await params;

  const server = await db
    .select({
      id: servers.id,
      publicIp: servers.publicIp,
      sshPort: servers.sshPort,
      sshUser: servers.sshUser,
      sshPrivateKeyEncrypted: servers.sshPrivateKeyEncrypted,
    })
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1)
    .then((r) => r[0]);
  if (!server) {
    return errorResponse('NOT_FOUND', 'Sunucu bulunamadı');
  }

  // In mock mode the private key is ignored by the SSH client — the
  // fixture seeds `'fake-iv:fake-tag:fake-cipher'` which would throw if
  // we tried to decrypt it. Pass a placeholder and let the mock handle
  // it; the real client (V1.5 prod) would decrypt for real here.
  let privateKey = '';
  if (process.env['TEST_MODE'] !== 'mock') {
    try {
      privateKey = decryptNullable(server.sshPrivateKeyEncrypted) ?? '';
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[docker-stats] decrypt failed', err);
      return errorResponse('INTERNAL_ERROR', 'SSH anahtarı çözülemedi');
    }
    if (!privateKey) {
      return errorResponse('INTERNAL_ERROR', 'Sunucuda SSH anahtarı yok');
    }
  }

  const client = getSshClient();
  try {
    await client.connect({
      host: server.publicIp,
      port: server.sshPort,
      username: server.sshUser,
      privateKey,
    });
    const result = await client.exec('docker stats --no-stream --format json');
    await client.disconnect();

    if (result.exitCode !== 0) {
      return errorResponse(
        'INTERNAL_ERROR',
        `docker stats başarısız (exit=${result.exitCode}): ${result.stderr.slice(0, 200)}`,
      );
    }

    let parsed: DockerStatsRaw;
    try {
      parsed = JSON.parse(result.stdout) as DockerStatsRaw;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[docker-stats] JSON parse failed', err, result.stdout);
      return errorResponse('INTERNAL_ERROR', 'docker stats çıktısı çözümlenemedi');
    }

    return successResponse(
      {
        name: parsed.Name ?? '',
        cpuPerc: parsed.CPUPerc ?? '',
        memUsage: parsed.MemUsage ?? '',
        memPerc: parsed.MemPerc ?? '',
        netIO: parsed.NetIO ?? '',
        raw: parsed,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[docker-stats] SSH failed', err);
    try {
      await client.disconnect();
    } catch {
      /* already failed, ignore */
    }
    const msg = err instanceof Error ? err.message : 'SSH bağlantısı başarısız';
    return errorResponse('INTERNAL_ERROR', `SSH hatası: ${msg}`);
  }
}
