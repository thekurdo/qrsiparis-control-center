/**
 * Lightweight liveness probe. Returns 200 with a tiny JSON body whenever
 * the Next.js process is up and accepting requests. Used by:
 *   - Docker HEALTHCHECK in docker/Dockerfile (app stage)
 *   - Coolify Traefik upstream health probe
 *   - External uptime monitors
 *
 * Deliberately does NOT touch the DB or Redis — those have their own
 * probes. This endpoint must stay fast and unconditional so a slow
 * upstream never marks the app unhealthy.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    ok: true,
    service: 'qrsiparis-control-center',
    version: process.env['APP_VERSION'] ?? 'dev',
    commit: process.env['GIT_COMMIT'] ?? 'unknown',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
