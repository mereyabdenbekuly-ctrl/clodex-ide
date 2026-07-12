import { ScrollReveal } from '@/components/landing/scroll-reveal';
import { ChevronDown } from 'lucide-react';
import { landingCopy, type LandingLocale } from './landing-copy';

export function HomeFAQ({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].faq;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: copy.items.map(([question, answer]) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: answer,
      },
    })),
  };

  return (
    <section className="relative z-10 w-full py-24 md:py-36">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="mx-auto flex max-w-7xl justify-center px-4">
        <ScrollReveal>
          <div className="mx-auto mb-12 max-w-3xl text-center">
            <p className="mb-4 font-medium text-primary-foreground text-sm">
              {copy.eyebrow}
            </p>
            <h2 className="mb-4 font-medium text-3xl tracking-[-0.04em] md:text-5xl">
              {copy.title}
            </h2>
            <p className="text-base text-muted-foreground leading-7">
              {copy.description}
            </p>
          </div>
          <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-border-subtle bg-background">
            {copy.items.map(([question, answer], index) => (
              <details
                key={question}
                className="group border-border-subtle border-t first:border-t-0"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-5 px-5 py-5 font-medium sm:px-7 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-start gap-3">
                    <span className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    {question}
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <p className="px-5 pb-6 pl-12 text-muted-foreground text-sm leading-7 sm:px-7 sm:pl-14">
                  {answer}
                </p>
              </details>
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
