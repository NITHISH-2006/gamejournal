import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/env';

export default function robots(): MetadataRoute.Robots {
  // `getSiteUrl()` rather than a reimplementation of the same precedence chain.
  // This file had its own copy — `SITE_URL ?? VERCEL_PROJECT_PRODUCTION_URL ?? a
  // hardcoded domain` — which meant a deployment that set `VERCEL_URL` only
  // (a preview build) advertised the production domain here while
  // `sitemap.ts` used `getSiteUrl()` and pointed elsewhere. The sitemap URL in
  // this response then referenced a host with no robots.txt, and the `Host`
  // directive silently mismatched the canonical origin.
  const base = getSiteUrl();

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // The library page is per-user and should not be indexed. `/auth/*` is
        // either a per-session recovery form or a one-visitor failure page.
        disallow: ['/profile', '/auth/', '/api/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
