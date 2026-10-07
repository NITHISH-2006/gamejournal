import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'https://gamejournal.vercel.app');

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // The library page is per-user and should not be indexed.
        disallow: ['/profile', '/api/'],
      },
    ],
    sitemap: `${base.replace(/\/$/, '')}/sitemap.xml`,
    host: base,
  };
}
