import type { Metadata } from 'next';
import { getLegalPage } from '@/lib/source';
import { notFound } from 'next/navigation';
import { compileMDX } from 'next-mdx-remote/rsc';

export const metadata: Metadata = {
  title: 'Trademark Policy · clodex',
  description:
    'Read the clodex Trademark Policy for guidance on using the clodex name, brand, and assets.',
  openGraph: {
    title: 'Trademark Policy · clodex',
    description:
      'Read the clodex Trademark Policy for guidance on using the clodex name, brand, and assets.',
    type: 'website',
  },
  twitter: {
    title: 'Trademark Policy · clodex',
    description:
      'Read the clodex Trademark Policy for guidance on using the clodex name, brand, and assets.',
    creator: '@clodex_io',
  },
  category: 'legal',
  alternates: {
    canonical: 'https://clodex.io/trademark-policy',
  },
  robots: { index: true, follow: true },
};

export default async function TrademarkPolicyPage() {
  const page = getLegalPage('trademark-policy');
  if (!page) notFound();

  const { content } = await compileMDX({
    source: page.source,
    options: {
      mdxOptions: { development: process.env.NODE_ENV !== 'production' },
    },
  });

  return (
    <div className="prose dark:prose-invert mx-auto mt-12 w-full max-w-7xl px-4">
      {content}
    </div>
  );
}
