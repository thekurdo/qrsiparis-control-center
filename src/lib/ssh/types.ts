/**
 * SSH client interface — implemented by both the real `ssh2`-backed
 * `client-real.ts` (prod) and `client-mock.ts` (E2E / unit tests).
 *
 * Selection happens in `index.ts` based on `process.env.TEST_MODE === 'mock'`.
 * Server records carry encrypted private keys; callers decrypt via
 * `lib/crypto/aes-gcm.ts` before passing them in `connect()`.
 */

export interface SshConfig {
  host: string;
  port?: number;
  username: string;
  /** Plaintext private key (after AES-GCM decryption). */
  privateKey: string;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshClient {
  connect(cfg: SshConfig): Promise<void>;
  exec(command: string): Promise<SshExecResult>;
  disconnect(): Promise<void>;
}
