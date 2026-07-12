import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Company · clodex',
  description:
    "We're building the software engineering environment of the future.",
  openGraph: {
    title: 'Company · clodex',
    description:
      "We're building the software engineering environment of the future.",
    type: 'website',
  },
  twitter: {
    title: 'Company · clodex',
    description:
      "We're building the software engineering environment of the future.",
    creator: '@clodex_io',
  },
  category: 'technology',
  alternates: {
    canonical: 'https://clodex.io/company',
  },
  robots: { index: true, follow: true },
};

export default function TeamLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
