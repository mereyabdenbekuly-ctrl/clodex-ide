import { buttonVariants } from '@clodex/stage-ui/components/button';
import { cn } from '@clodex/stage-ui/lib/utils';
import {
  ArrowRight,
  BriefcaseBusiness,
  HeartHandshake,
  Microscope,
  ShieldCheck,
} from 'lucide-react';
import { ScrollReveal } from '@/components/landing/scroll-reveal';
import { DonationAddressCard } from './donation-address-card';
import { landingCopy, type LandingLocale } from './landing-copy';
import { usdtDonationNetworks } from './usdt-donation-networks';

export function FounderSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].builder;

  return (
    <section
      id="builder"
      className="border-border-subtle border-y py-24 md:py-36"
    >
      <div className="mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <div className="relative overflow-hidden rounded-[2rem] border border-border-subtle bg-surface-1/55 p-7 shadow-sm sm:p-10 md:p-14">
            <div className="clodex-labs-glow pointer-events-none absolute inset-0" />
            <div className="landing-grid pointer-events-none absolute inset-0 opacity-[0.12]" />
            <div className="relative grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-background/75 px-3 py-1.5 font-mono text-[10px] text-primary-foreground uppercase tracking-[0.16em]">
                  <Microscope className="size-3.5" />
                  {copy.eyebrow}
                </span>
                <h2 className="mt-6 max-w-3xl text-balance font-medium text-3xl tracking-[-0.05em] sm:text-4xl md:text-5xl">
                  {copy.title}
                </h2>
                <p className="mt-6 max-w-2xl text-balance text-base text-muted-foreground leading-7 md:text-lg">
                  {copy.description}
                </p>
              </div>

              <div className="rounded-2xl border border-border-subtle bg-background/75 p-6 backdrop-blur">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-[#111318] text-cyan-300">
                    <BriefcaseBusiness className="size-4.5" />
                  </span>
                  <p className="font-medium tracking-tight">
                    {copy.rolesTitle}
                  </p>
                </div>
                <p className="mt-4 text-muted-foreground text-sm leading-6">
                  {copy.rolesDescription}
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {copy.labs.map((lab) => (
                    <span
                      key={lab}
                      className="rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {lab}
                    </span>
                  ))}
                </div>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  <a
                    href="https://x.com/CLODEx_lab"
                    target="_blank"
                    rel="noreferrer noopener"
                    className={cn(
                      buttonVariants({ size: 'md', variant: 'secondary' }),
                      'w-full',
                    )}
                  >
                    <span className="font-semibold">𝕏</span>
                    {copy.xProfile}
                  </a>
                  <a
                    href="mailto:support@clodex.xyz"
                    className={cn(
                      buttonVariants({ size: 'md', variant: 'secondary' }),
                      'w-full',
                    )}
                  >
                    {copy.contact}
                    <ArrowRight className="size-4" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

export function SupportSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].support;

  return (
    <section
      id="support"
      className="relative overflow-hidden bg-[#0c0e12] py-24 text-white md:py-36"
    >
      <div className="landing-security-grid pointer-events-none absolute inset-0 opacity-70" />
      <div className="pointer-events-none absolute top-[-220px] left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-cyan-400/8 blur-[110px]" />
      <div className="relative mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <span className="inline-flex items-center gap-2 font-mono text-cyan-300 text-xs uppercase tracking-[0.18em]">
                <HeartHandshake className="size-4" />
                {copy.eyebrow}
              </span>
              <h2 className="mt-5 text-balance font-medium text-3xl tracking-[-0.05em] sm:text-4xl md:text-5xl">
                {copy.title}
              </h2>
            </div>
            <p className="max-w-2xl text-balance text-base text-white/58 leading-7 md:text-lg">
              {copy.description}
            </p>
          </div>
        </ScrollReveal>

        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {usdtDonationNetworks.map((network, index) => (
            <ScrollReveal key={network.id} delay={index * 45}>
              <DonationAddressCard
                network={network}
                copyLabel={copy.copy}
                copiedLabel={copy.copied}
                errorLabel={copy.copyError}
              />
            </ScrollReveal>
          ))}
        </div>

        <ScrollReveal delay={120}>
          <div className="mt-8 flex items-start gap-3 rounded-2xl border border-amber-300/15 bg-amber-300/[0.055] p-4 text-amber-100/75 text-sm leading-6">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <p>{copy.warning}</p>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
