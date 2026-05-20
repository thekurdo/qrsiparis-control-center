/**
 * Next.js 16 instrumentation hook (control-center, Phase H12).
 *
 * Loads Sentry SDK per runtime. No-op when `CC_SENTRY_DSN` is unset
 * (most local-dev / CI builds). Sentry init lives in
 * `sentry.{server,edge,client}.config.ts` at the project root.
 *
 * `onRequestError` exports the Next 16 hook for capturing uncaught route
 * handler / RSC errors into Sentry.
 */
import * as Sentry from '@sentry/nextjs';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
