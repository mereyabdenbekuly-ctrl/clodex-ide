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
  name: 'clodex',
  url: 'https://ide.clodex.xyz',
  logo: 'https://ide.clodex.xyz/icon.png',
  description:
    'The Agentic IDE for the complete development loop — plan, code, run, browse, review, and finish real engineering tasks.',
  sameAs: ['https://x.com/CLODEx_lab'],
};

const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'clodex',
  url: 'https://ide.clodex.xyz',
  publisher: { '@type': 'Organization', name: 'clodex' },
};

export const metadata: Metadata = {
  icons: {
    icon: [{ url: '/icon.png', type: 'image/png' }],
    shortcut: [{ url: '/icon.png', type: 'image/png' }],
    apple: [{ url: '/apple-touch-icon.png', type: 'image/png' }],
  },
  metadataBase: new URL('https://ide.clodex.xyz'),
  title: 'Clodex · Agentic IDE for the Complete Development Loop',
  description:
    'Clodex gives coding agents the environment, tools, and boundaries to finish real software tasks.',
  openGraph: {
    title: 'Clodex · Agentic IDE for the Complete Development Loop',
    description:
      'Clodex gives coding agents the environment, tools, and boundaries to finish real software tasks.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Clodex · Agentic IDE for the Complete Development Loop',
    description:
      'Clodex gives coding agents the environment, tools, and boundaries to finish real software tasks.',
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
