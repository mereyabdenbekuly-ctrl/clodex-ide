import './global.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { PostHogProvider } from '@/components/posthog-provider';
import { CookieBanner } from '@/components/cookie-banner';
import { SystemThemeProvider } from '@/components/theme-switcher';

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'CLODEx',
  url: 'https://ide.clodex.xyz',
  logo: 'https://ide.clodex.xyz/icon.png',
  description:
    'Free open-source local-first Agentic IDE Technical Preview for durable engineering tasks.',
  sameAs: ['https://x.com/CLODEx_lab'],
};

const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'CLODEx',
  url: 'https://ide.clodex.xyz',
  publisher: { '@type': 'Organization', name: 'CLODEx' },
};

export const metadata: Metadata = {
  icons: {
    icon: [{ url: '/icon.png', type: 'image/png' }],
    shortcut: [{ url: '/icon.png', type: 'image/png' }],
    apple: [{ url: '/apple-touch-icon.png', type: 'image/png' }],
  },
  metadataBase: new URL('https://ide.clodex.xyz'),
  title: 'CLODEx Community · Free local-first Agentic IDE',
  description:
    'Free open-source Technical Preview for persistent tasks, files, Git, terminal, browser, models, MCP, and review.',
  openGraph: {
    title: 'CLODEx Community · Free local-first Agentic IDE',
    description:
      'Free open-source Technical Preview for persistent tasks, files, Git, terminal, browser, models, MCP, and review.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CLODEx Community · Free local-first Agentic IDE',
    description:
      'Free open-source Technical Preview for persistent tasks, files, Git, terminal, browser, models, MCP, and review.',
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.className} scrollbar-subtle bg-background`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                  document.documentElement.classList.add('dark');
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className="relative flex min-h-screen flex-col">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(organizationJsonLd),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
        <div className="root">
          <PostHogProvider>
            <SystemThemeProvider>{children}</SystemThemeProvider>
          </PostHogProvider>
          <CookieBanner />
        </div>
      </body>
    </html>
  );
}
