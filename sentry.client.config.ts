/**
 * Sentry browser SDK init (control-center, Phase H12).
 *
 * Runs in the operator's browser (CC panel). Uses a different env var
 * (`CC_SENTRY_DSN`) than the customer-app's `SENTRY_DSN` so Cyxares can
 * route CC operator-facing errors to a separate Sentry project from
 * customer-tenant runtime errors.
 *
 * No-op when DSN is unset.
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_CC_SENTRY_DSN ?? process.env.CC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
  release: process.env.NEXT_PUBLIC_CC_VERSION ?? process.env.CC_VERSION,
  initialScope: {
    tags: {
      app: 'control-center',
    },
  },
});
