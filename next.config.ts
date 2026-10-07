import type { NextConfig } from 'next';

/**
 * Next.js configuration.
 *
 * - `images.remotePatterns` allows IGDB cover art through next/image, which is
 *   what the redesigned cover components use. Without this, optimisation would
 *   be skipped or throw.
 * - The `logging` block surfaces the server-action and route timings that
 *   `next build` prints, so regressions are visible in CI.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  turbopack: {},

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.igdb.com',
        pathname: '/igdb/image/upload/**',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [360, 480, 640, 750, 828, 1080, 1200, 1920],
  },

  // `next/og` is used by the OG image routes.
  serverExternalPackages: [],

  // NOTE: security headers are set in `src/proxy.ts`, not here.
  //
  // They used to be declared in both places. `next.config.ts`'s `headers()` runs
  // *after* the proxy, so the config value silently won — two sources of truth
  // that happened to agree. Only the proxy sets them now.
};

export default nextConfig;
