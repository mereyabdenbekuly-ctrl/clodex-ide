import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'CLODEx Free Community Build Status',
  description:
    'Track verification and publication of the next CLODEx Free Community build for macOS, Windows, and Linux.',
  openGraph: {
    title: 'CLODEx Free Community Build Status',
    description:
      'Track verification and publication of the next CLODEx Free Community build for macOS, Windows, and Linux.',
    type: 'website',
  },
  twitter: {
    title: 'CLODEx Free Community Build Status',
    description:
      'Track verification and publication of the next CLODEx Free Community build for macOS, Windows, and Linux.',
    creator: '@CLODEx_lab',
  },
  category: 'technology',
  alternates: {
    canonical: 'https://ide.clodex.xyz/download',
  },
  robots: { index: true, follow: true },
};

export default function DownloadLayout({ children }: { children: ReactNode }) {
  return children;
}
