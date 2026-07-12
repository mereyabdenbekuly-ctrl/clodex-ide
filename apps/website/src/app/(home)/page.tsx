import type { Metadata } from 'next';
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
  RoadmapSection,
  RuntimeSection,
  SecuritySection,
  SurfacesSection,
  WorkflowSection,
} from './_components/product-landing';
import type { LandingLocale } from './_components/landing-copy';
import { FounderSection, SupportSection } from './_components/founder-support';

const softwareAppJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'clodex',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Windows, Linux',
  description:
    'Open-source Agentic IDE for persistent tasks, remote machines, Agent OS, MCP, review, and governed execution.',
  url: 'https://ide.clodex.xyz',
  downloadUrl: 'https://ide.clodex.xyz/download',
  publisher: { '@type': 'Organization', name: 'clodex' },
};

export const metadata: Metadata = {
  title: 'Clodex — Agentic IDE for local, remote, and cloud development',
  description:
    'One persistent task connects code, terminals, browser, GitHub, MCP, remote machines, agents, automations, and review.',
  openGraph: {
    title: 'Give agents the whole task · Clodex Agentic IDE',
    description:
      'A persistent environment for planning, coding, running, verifying, and completing real engineering work.',
    type: 'website',
  },
  twitter: {
    title: 'Give agents the whole task · Clodex Agentic IDE',
    description:
      'A persistent environment for planning, coding, running, verifying, and completing real engineering work.',
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
        <RoadmapSection locale={locale} />
        <FounderSection locale={locale} />
        <SupportSection locale={locale} />
        <HomeFAQ locale={locale} />
        <FinalCta locale={locale} />
      </div>
    </>
  );
}
