import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Standalone build for slim Docker image
  output: 'standalone',
  // Strict mode catches accidental side-effects
  reactStrictMode: true,
  // Typed routes (typedRoutes generally available in Next 16)
  typedRoutes: true,
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

export default nextConfig;
