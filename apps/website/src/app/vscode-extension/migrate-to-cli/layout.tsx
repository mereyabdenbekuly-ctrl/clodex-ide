import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Upgrade to the new clodex · clodex',
  description:
    'Your clodex setup needs an upgrade. Download the standalone clodex IDE for a more powerful experience — no extension required.',
  openGraph: {
    title: 'Upgrade to the new clodex · clodex',
    description:
      'Your clodex setup needs an upgrade. Download the standalone clodex IDE for a more powerful experience — no extension required.',
    type: 'website',
  },
  twitter: {
    title: 'Upgrade to the new clodex · clodex',
    description:
      'Your clodex setup needs an upgrade. Download the standalone clodex IDE for a more powerful experience — no extension required.',
    creator: '@CLODEx_lab',
  },
  category: 'technology',
};

export default function MigrateToCliLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
