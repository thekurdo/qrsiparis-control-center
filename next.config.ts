import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Standalone build for slim Docker image
  output: 'standalone',
  // Strict mode catches accidental side-effects
  reactStrictMode: true,
  // Typed routes — dynamic router.push() / Link href call sites that build
  // URLs at runtime are explicitly cast to `Route` (imported from `next`)
  // where needed. Adapter / JWT peer-version mismatch is documented in
  // `src/lib/auth/operator.ts`.
  typedRoutes: false,
  typescript: {
    ignoreBuildErrors: false,
  },
  // Packages that ship native (.node) addons or non-ESM assets must be
  // externalised so Turbopack doesn't try to bundle them into a server
  // chunk. Required since the SSH and crypto layers use C++ bindings.
  serverExternalPackages: ['ssh2', 'cpu-features', 'bcrypt', 'pdfkit'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // The control-center is internal-only; no public images served from arbitrary hosts.
  images: {
    remotePatterns: [],
  },
  // Don't ship source maps in production (sensitive: SSH/Coolify glue)
  productionBrowserSourceMaps: false,
};

// Sentry wrapper (Phase H12 — observability).
// CC uses `CC_SENTRY_DSN` (separate Sentry project from customer-app's
// `SENTRY_DSN`). When `SENTRY_AUTH_TOKEN` is unset (typical build), the
// plugin skips source-map upload and the build still succeeds.
export default withSentryConfig(nextConfig, {
  silent: !process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT_CC,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
});
