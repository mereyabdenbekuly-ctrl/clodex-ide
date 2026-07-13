import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Meet the new clodex · clodex',
  description:
    'The clodex extension is retired. Download the standalone clodex IDE for a more powerful experience — no extension required.',
  openGraph: {
    title: 'Meet the new clodex · clodex',
    description:
      'The clodex extension is retired. Download the standalone clodex IDE for a more powerful experience — no extension required.',
    type: 'website',
  },
  twitter: {
    title: 'Meet the new clodex · clodex',
    description:
      'The clodex extension is retired. Download the standalone clodex IDE for a more powerful experience — no extension required.',
    creator: '@CLODEx_lab',
  },
  category: 'technology',
};

export default function WelcomeLayout({ children }: { children: ReactNode }) {
  return children;
}
