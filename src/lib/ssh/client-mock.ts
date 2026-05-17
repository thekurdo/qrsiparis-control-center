/**
 * In-memory SSH mock used when `TEST_MODE=mock`.
 *
 * Responds to a small dictionary of known commands with predetermined stdout
 * so that deploy/health/backup cron flows can exercise their full code path
 * without a real VPS. Unknown commands return exit code 0 with empty output,
 * which is intentional — tests should assert on the rich-output commands.
 *
 * Failure injection via `SSH_MOCK_FAIL=connect|timeout|auth` env var so a
 * test fixture can flip the env immediately before invoking the code under
 * test (in-process tests only; for full E2E the server's env must be set
 * before boot — see plan §5.1 risk row).
 */

import type { SshClient, SshConfig, SshExecResult } from './types';

const MOCK_RESPONSES: Record<string, SshExecResult> = {
  'docker ps --format json': {
    stdout: JSON.stringify([
      {
        Names: 'qrsiparis-demo',
        State: 'running',
        Status: 'Up 2 hours',
        Image: 'qrsiparis-app:latest',
      },
    ]),
    stderr: '',
    exitCode: 0,
  },
  'docker stats --no-stream --format json': {
    stdout: JSON.stringify({
      Name: 'qrsiparis-demo',
      CPUPerc: '4.5%',
      MemUsage: '320MiB / 768MiB',
      MemPerc: '41.67%',
      NetIO: '12.4MB / 8.1MB',
    }),
    stderr: '',
    exitCode: 0,
  },
  'df -h /': {
    stdout:
      'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       100G   42G   58G  42% /',
    stderr: '',
    exitCode: 0,
  },
  'uptime': {
    stdout: ' 04:24:43 up 12 days,  3:14,  0 users,  load average: 0.42, 0.38, 0.35',
    stderr: '',
    exitCode: 0,
  },
};

export class SshMockClient implements SshClient {
  private connected = false;

  async connect(_cfg: SshConfig): Promise<void> {
    const fail = process.env['SSH_MOCK_FAIL'];
    if (fail === 'connect') {
      throw new Error('Mock SSH: connection refused');
    }
    if (fail === 'auth') {
      throw new Error('Mock SSH: authentication failed');
    }
    if (fail === 'timeout') {
      await new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Mock SSH: connect timeout')), 80),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
    this.connected = true;
  }

  async exec(command: string): Promise<SshExecResult> {
    if (!this.connected) throw new Error('Mock SSH: not connected');

    const exact = MOCK_RESPONSES[command];
    if (exact) return exact;

    // pg_dump-style commands: pretend it produced a small dump.
    if (command.startsWith('pg_dump') || command.startsWith('sqlite3')) {
      return {
        stdout: '-- mock dump (1 row)\nCREATE TABLE demo (id int);\n',
        stderr: '',
        exitCode: 0,
      };
    }
    // tar/zip backup commands.
    if (command.startsWith('tar ') || command.startsWith('zip ')) {
      return { stdout: 'archived', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}
