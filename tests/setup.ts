/**
 * Vitest global setup — wired in vitest.config.ts.
 *
 * Phase H1+ workers will extend with DB lifecycle helpers, but for the initial
 * scaffold we just ensure deterministic time + a sane NODE_ENV.
 */
import { afterAll, beforeAll } from 'vitest';

beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['TZ'] = 'UTC';
});

afterAll(() => {
  // intentionally empty for the scaffold
});
