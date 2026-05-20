/**
 * Sentry edge SDK init (control-center, Phase H12).
 *
 * No-op when `CC_SENTRY_DSN` is unset.
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.CC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  release: process.env.CC_VERSION,
  initialScope: {
    tags: {
      app: 'control-center',
    },
  },
});
