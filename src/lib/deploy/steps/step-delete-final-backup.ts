/**
 * DELETE_FINAL_BACKUP — first real step of the `delete` pipeline.
 *
 * Take a last hot-backup of the tenant's SQLite DB before we tear
 * everything down. Same shape as `lib/crons/daily-backup` but writes to a
 * dedicated `final-backup-` filename pattern so operators can tell
 * "this is the keepsake taken right before deletion" apart from a
 * regular daily snapshot.
 *
 * Failure semantics: best-effort. If the backup fails we LOG and
 * continue with deletion — the operator pressed Delete, the customer's
 * contract is over, and refusing to delete because the backup failed
 * would just leave dangling resources. The audit row carries the
 * `backup_skipped` reason so ops can chase later if needed.
 *
 * Idempotency: writing the same file path twice is fine; the second
 * call overwrites. Re-running the step on a retried delete is safe.
 */

import { decryptNullable } from '@/lib/crypto/aes-gcm';
import { getSshClient } from '@/lib/ssh';

import { type PipelineStep } from '../pipeline';

export const stepDeleteFinalBackup: PipelineStep = {
  name: 'DELETE_FINAL_BACKUP',
  async forward(ctx) {
    let privateKey = '';
    if (process.env['TEST_MODE'] !== 'mock') {
      try {
        privateKey =
          decryptNullable(ctx.server.sshPrivateKeyEncrypted) ?? '';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log(
          'warn',
          `DELETE_FINAL_BACKUP: SSH key decrypt failed (continuing without backup): ${msg}`,
        );
        return;
      }
      if (!privateKey) {
        ctx.log(
          'warn',
          'DELETE_FINAL_BACKUP: no SSH key configured (continuing without backup)',
        );
        return;
      }
    }

    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);
    const hostPath = `/var/backups/qrsiparis/final-backup-${ctx.tenant.shortCode}-${ts}.sqlite.gz`;
    const cmd = [
      `mkdir -p /var/backups/qrsiparis`,
      `CN=$(docker ps --format '{{.Names}}' | while read c; do docker inspect "$c" --format '{{range .Mounts}}{{.Name}} {{end}}' 2>/dev/null | grep -q "${ctx.tenant.shortCode}-data" && { echo "$c"; break; }; done)`,
      `[ -z "$CN" ] && { echo "no container for ${ctx.tenant.shortCode} (already torn down?)" >&2; exit 0; }`,
      `docker exec "$CN" sqlite3 /data/db.sqlite ".backup /tmp/final.sqlite" 2>&1 || exit 0`,
      `docker cp "$CN:/tmp/final.sqlite" /tmp/final-${ctx.tenant.shortCode}.sqlite 2>&1 || exit 0`,
      `docker exec "$CN" rm -f /tmp/final.sqlite`,
      `gzip -9 -c /tmp/final-${ctx.tenant.shortCode}.sqlite > ${hostPath}`,
      `rm -f /tmp/final-${ctx.tenant.shortCode}.sqlite`,
      `stat -c '%s' ${hostPath} 2>/dev/null || echo 0`,
    ].join(' && ');

    const ssh = getSshClient();
    try {
      await ssh.connect({
        host: ctx.server.publicIp,
        port: ctx.server.sshPort,
        username: ctx.server.sshUser,
        privateKey,
      });
      const r = await ssh.exec(cmd);
      ctx.log(
        'info',
        `DELETE_FINAL_BACKUP: ${hostPath} (exit=${r.exitCode}, stdout last line: ${(r.stdout.trim().split('\n').pop() ?? '').slice(0, 80)})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log(
        'warn',
        `DELETE_FINAL_BACKUP: ssh path failed (continuing deletion): ${msg}`,
      );
    } finally {
      try {
        await ssh.disconnect();
      } catch {
        /* ignore */
      }
    }
  },
  async rollback(ctx) {
    ctx.log('info', 'DELETE_FINAL_BACKUP rollback: noop (backup file kept)');
  },
};
