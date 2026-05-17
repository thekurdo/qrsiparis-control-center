/**
 * Real SSH client backed by `ssh2`. Used in prod against actual Hostinger
 * VPSes. The encrypted `sshPrivateKey` lives in `servers.ssh_private_key_encrypted`
 * and must be decrypted (lib/crypto/aes-gcm.ts) by the caller before being
 * passed to `connect()`.
 */

import { Client } from 'ssh2';

import type { SshClient, SshConfig, SshExecResult } from './types';

export class SshRealClient implements SshClient {
  private conn?: Client;

  async connect(cfg: SshConfig): Promise<void> {
    const conn = new Client();
    this.conn = conn;
    await new Promise<void>((resolve, reject) => {
      conn
        .on('ready', () => resolve())
        .on('error', (err) => reject(err))
        .connect({
          host: cfg.host,
          port: cfg.port ?? 22,
          username: cfg.username,
          privateKey: cfg.privateKey,
          readyTimeout: 15_000,
        });
    });
  }

  exec(command: string): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject(new Error('SSH not connected'));
        return;
      }
      let stdout = '';
      let stderr = '';
      this.conn.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        stream
          .on('close', (code: number) =>
            resolve({ stdout, stderr, exitCode: code ?? 0 }),
          )
          .on('data', (d: Buffer) => {
            stdout += d.toString('utf-8');
          })
          .stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf-8');
          });
      });
    });
  }

  async disconnect(): Promise<void> {
    this.conn?.end();
    this.conn = undefined;
  }
}
