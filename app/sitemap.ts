import type { MetadataRoute } from 'next';

const BASE_URL = 'https://oneclickitleads.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes: { path: string; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']; priority: number }[] = [
    { path: '/', changeFrequency: 'weekly', priority: 1.0 },
    { path: '/pricing', changeFrequency: 'weekly', priority: 0.9 },
    { path: '/contact', changeFrequency: 'monthly', priority: 0.7 },
    { path: '/login', changeFrequency: 'yearly', priority: 0.5 },
    { path: '/submit-lead', changeFrequency: 'monthly', priority: 0.4 },
    { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
    { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
    { path: '/data-request', changeFrequency: 'yearly', priority: 0.3 },
  ];

  return routes.map((r) => ({
    url: `${BASE_URL}${r.path}`,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
