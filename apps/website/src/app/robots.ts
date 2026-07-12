import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/vscode-extension/'],
    },
    sitemap: 'https://ide.clodex.xyz/sitemap.xml',
    host: 'https://ide.clodex.xyz',
  };
}
