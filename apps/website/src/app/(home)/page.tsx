import type { Metadata } from 'next';
import {
  COMMUNITY_RELEASE,
  getReadyCommunityRelease,
} from '@/lib/community-release';
import { HomeFAQ } from './_components/home-faq';
import {
  CapabilitySection,
  FinalCta,
  LabsSection,
  LandingHero,
  ModelsSection,
  PainSection,
  PlatformSection,
  ProductProof,
  RemoteSection,
  RuntimeSection,
  SecuritySection,
  SurfacesSection,
  WorkflowSection,
} from './_components/product-landing';
import type { LandingLocale } from './_components/landing-copy';
import { FounderSection, SupportSection } from './_components/founder-support';

const readyCommunityRelease = getReadyCommunityRelease(COMMUNITY_RELEASE);

const softwareAppJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'CLODEx Community',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Windows, Linux',
  isAccessibleForFree: true,
  ...(readyCommunityRelease
    ? {
        softwareVersion: readyCommunityRelease.version,
        downloadUrl: readyCommunityRelease.downloads.map(({ href }) => href),
        releaseNotes: readyCommunityRelease.releaseUrl,
      }
    : {}),
  description: readyCommunityRelease
    ? 'Free open-source local-first Agentic IDE for persistent tasks, code, Git, terminal, browser, models, MCP, and review. Community Observed 14 is the current verified Technical Preview.'
    : 'Free open-source local-first Agentic IDE for persistent tasks, code, Git, terminal, browser, models, MCP, and review.',
  url: 'https://ide.clodex.xyz',
  publisher: { '@type': 'Organization', name: 'CLODEx' },
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
};

export const metadata: Metadata = {
  title: 'CLODEx Community — Free local-first Agentic IDE',
  description:
    'Download the verified CLODEx Community Observed 14 Technical Preview for macOS, Windows, and Linux.',
  openGraph: {
    title: 'One task. Your local engineering workspace. · CLODEx Community',
    description:
      'Free local-first Agentic IDE with the verified Community Observed 14 Technical Preview for macOS, Windows, and Linux.',
    type: 'website',
  },
  twitter: {
    title: 'One task. Your local engineering workspace. · CLODEx Community',
    description:
      'Free local-first Agentic IDE with the verified Community Observed 14 Technical Preview for macOS, Windows, and Linux.',
    creator: '@CLODEx_lab',
  },
  category: 'technology',
  alternates: {
    canonical: 'https://ide.clodex.xyz',
  },
  robots: { index: true, follow: true },
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string | string[] }>;
}) {
  const params = await searchParams;
  const locale: LandingLocale = params.lang === 'ru' ? 'ru' : 'en';
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareAppJsonLd) }}
      />
      <div className="relative -mt-16 min-h-screen w-full">
        <LandingHero locale={locale} />
        <ProductProof locale={locale} />
        <PainSection locale={locale} />
        <WorkflowSection locale={locale} />
        <RemoteSection locale={locale} />
        <CapabilitySection locale={locale} />
        <SurfacesSection locale={locale} />
        <PlatformSection locale={locale} />
        <LabsSection locale={locale} />
        <RuntimeSection locale={locale} />
        <SecuritySection locale={locale} />
        <ModelsSection locale={locale} />
        <FounderSection locale={locale} />
        <SupportSection locale={locale} />
        <HomeFAQ locale={locale} />
        <FinalCta locale={locale} />
      </div>
    </>
  );
}
