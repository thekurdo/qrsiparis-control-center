/**
 * SshMockClient unit tests — verify behavior of the in-memory SSH stub
 * including failure-injection via SSH_MOCK_FAIL env var.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SshMockClient } from '@/lib/ssh/client-mock';

describe('SshMockClient', () => {
  let client: SshMockClient;
  const originalFail = process.env['SSH_MOCK_FAIL'];

  beforeEach(() => {
    client = new SshMockClient();
    delete process.env['SSH_MOCK_FAIL'];
  });

  afterEach(() => {
    if (originalFail !== undefined) process.env['SSH_MOCK_FAIL'] = originalFail;
  });

  it('docker ps returns a predefined container list', async () => {
    await client.connect({ host: 'fake', username: 'root', privateKey: '' });
    const res = await client.exec('docker ps --format json');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('qrsiparis-demo');
    const parsed = JSON.parse(res.stdout);
    expect(parsed[0].State).toBe('running');
  });

  it('docker stats returns json memory + cpu numbers', async () => {
    await client.connect({ host: 'fake', username: 'root', privateKey: '' });
    const res = await client.exec('docker stats --no-stream --format json');
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.MemUsage).toMatch(/\d+MiB \/ \d+MiB/);
  });

  it('pg_dump command returns mock SQL dump', async () => {
    await client.connect({ host: 'fake', username: 'root', privateKey: '' });
    const res = await client.exec('pg_dump -U user mydb');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('mock dump');
  });

  it('unknown commands return exit 0 with empty stdout', async () => {
    await client.connect({ host: 'fake', username: 'root', privateKey: '' });
    const res = await client.exec('whoami');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('exec before connect throws', async () => {
    await expect(client.exec('docker ps')).rejects.toThrow(/not connected/);
  });

  it('SSH_MOCK_FAIL=connect throws on connect', async () => {
    process.env['SSH_MOCK_FAIL'] = 'connect';
    await expect(
      client.connect({ host: 'fake', username: 'root', privateKey: '' }),
    ).rejects.toThrow(/connection refused/);
  });

  it('SSH_MOCK_FAIL=auth throws on connect', async () => {
    process.env['SSH_MOCK_FAIL'] = 'auth';
    await expect(
      client.connect({ host: 'fake', username: 'root', privateKey: '' }),
    ).rejects.toThrow(/authentication failed/);
  });

  it('SSH_MOCK_FAIL=timeout throws after delay', async () => {
    process.env['SSH_MOCK_FAIL'] = 'timeout';
    await expect(
      client.connect({ host: 'fake', username: 'root', privateKey: '' }),
    ).rejects.toThrow(/connect timeout/);
  });
});
