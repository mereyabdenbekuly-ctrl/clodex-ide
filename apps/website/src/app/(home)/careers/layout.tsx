import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Career · clodex',
  description:
    'Join clodex and help build the future of AI-driven development. We are hiring in-person in San Francisco and Bielefeld.',
  openGraph: {
    title: 'Career · clodex',
    description:
      'Join clodex and help build the future of AI-driven development. We are hiring in-person in San Francisco and Bielefeld.',
    type: 'website',
  },
  twitter: {
    title: 'Career · clodex',
    description:
      'Join clodex and help build the future of AI-driven development. We are hiring in-person in San Francisco and Bielefeld.',
    creator: '@clodex_io',
  },
  category: 'technology',
};

export default function CareerLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
