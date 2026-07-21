import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Download CLODEx Community Observed 13',
  description:
    'Download the verified CLODEx Community Observed 13 Technical Preview for macOS, Windows, and Linux, with checksums and release evidence.',
  openGraph: {
    title: 'Download CLODEx Community Observed 13',
    description:
      'Verified Free Community Technical Preview for macOS, Windows, and Linux, with SHA-256 checksums and release evidence.',
    type: 'website',
  },
  twitter: {
    title: 'Download CLODEx Community Observed 13',
    description:
      'Verified Free Community Technical Preview for macOS, Windows, and Linux, with SHA-256 checksums and release evidence.',
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
