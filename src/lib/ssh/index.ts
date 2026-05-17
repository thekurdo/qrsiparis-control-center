/**
 * Entry point for SSH client. Switches between real ssh2-backed implementation
 * and an in-memory mock based on `TEST_MODE=mock`. Callers should always go
 * through `getSshClient()`; never import a concrete implementation directly.
 */

import { SshMockClient } from './client-mock';
import { SshRealClient } from './client-real';
import type { SshClient } from './types';

export function getSshClient(): SshClient {
  return process.env['TEST_MODE'] === 'mock'
    ? new SshMockClient()
    : new SshRealClient();
}

export type { SshClient, SshConfig, SshExecResult } from './types';
