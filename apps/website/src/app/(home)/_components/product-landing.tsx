import Image from 'next/image';
import Link from 'next/link';
import {
  AppWindow,
  ArrowRight,
  Blocks,
  Bot,
  Box,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Cloud,
  Code2,
  Cpu,
  Eye,
  FileLock2,
  Files,
  GitFork,
  Github,
  GitPullRequest,
  Globe2,
  Goal,
  Gauge,
  HardDrive,
  KeyRound,
  Laptop,
  Layers3,
  Link2,
  LockKeyhole,
  Network,
  Orbit,
  Plug,
  Puzzle,
  Radio,
  RefreshCcw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  TimerReset,
  Waypoints,
  Workflow,
  Zap,
} from 'lucide-react';
import { buttonVariants } from '@clodex/stage-ui/components/button';
import { cn } from '@clodex/stage-ui/lib/utils';
import { ScrollReveal } from '@/components/landing/scroll-reveal';
import { DownloadButtons } from './download-buttons';
import { landingCopy, type LandingLocale } from './landing-copy';

type Status = 'shipped' | 'preview' | 'labs' | 'building';

const workflowIcons = [Goal, Brain, Code2, Terminal, GitPullRequest];
const securityIcons = [Eye, ShieldCheck, FileLock2, Blocks, Link2, HardDrive];
const roadmapIcons = [
  GitFork,
  Box,
  Goal,
  Gauge,
  SlidersHorizontal,
  Terminal,
  Radio,
  Files,
  ShieldCheck,
  Puzzle,
];
const platformIcons = {
  agent: Orbit,
  mcp: Plug,
  plugins: Puzzle,
  apps: AppWindow,
} as const;

function SectionHeading({
  eyebrow,
  title,
  description,
  align = 'left',
  inverse = false,
}: {
  eyebrow: string;
  title: string;
  description: string;
  align?: 'left' | 'center';
  inverse?: boolean;
}) {
  return (
    <div
      className={cn('max-w-3xl', align === 'center' && 'mx-auto text-center')}
    >
      <p
        className={cn(
          'mb-4 font-medium font-mono text-xs uppercase tracking-[0.18em]',
          inverse ? 'text-cyan-300' : 'text-primary-foreground',
        )}
      >
        {eyebrow}
      </p>
      <h2
        className={cn(
          'text-balance font-medium text-3xl tracking-[-0.045em] sm:text-4xl md:text-5xl',
          inverse && 'text-white',
        )}
      >
        {title}
      </h2>
      <p
        className={cn(
          'mt-5 text-balance text-base leading-7 md:text-lg',
          inverse ? 'text-white/58' : 'text-muted-foreground',
        )}
      >
        {description}
      </p>
    </div>
  );
}

function StatusBadge({
  locale,
  status,
  inverse = false,
}: {
  locale: LandingLocale;
  status: Status;
  inverse?: boolean;
}) {
  const label = landingCopy[locale].status[status];
  return (
    <span
      className={cn(
        'inline-flex rounded-full border px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em]',
        status === 'shipped' &&
          (inverse
            ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-300'
            : 'border-emerald-500/20 bg-emerald-500/8 text-emerald-600 dark:text-emerald-400'),
        status === 'preview' &&
          (inverse
            ? 'border-cyan-300/20 bg-cyan-300/10 text-cyan-300'
            : 'border-primary-500/20 bg-primary-500/8 text-primary-foreground'),
        status === 'labs' &&
          (inverse
            ? 'border-violet-300/20 bg-violet-300/10 text-violet-300'
            : 'border-violet-500/20 bg-violet-500/8 text-violet-600 dark:text-violet-400'),
        status === 'building' &&
          (inverse
            ? 'border-amber-300/20 bg-amber-300/10 text-amber-300'
            : 'border-amber-500/20 bg-amber-500/8 text-amber-600 dark:text-amber-400'),
      )}
    >
      {label}
    </span>
  );
}

function ProductScreenshot({
  src,
  alt,
  priority = false,
  className,
}: {
  src: string;
  alt: string;
  priority?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border border-white/10 bg-[#111317] p-1.5 shadow-[0_45px_140px_-55px_rgba(0,0,0,0.95)]',
        className,
      )}
    >
      <div className="relative aspect-[16/9] overflow-hidden rounded-[13px] bg-[#1b1d22]">
        <Image
          src={src}
          alt={alt}
          width={2048}
          height={1213}
          priority={priority}
          className="h-full w-full object-cover object-top"
          sizes="(min-width: 1280px) 1180px, (min-width: 768px) calc(100vw - 64px), calc(100vw - 32px)"
        />
        <div className="pointer-events-none absolute inset-0 ring-1 ring-white/5 ring-inset" />
      </div>
    </div>
  );
}

export function LandingHero({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].hero;
  return (
    <section className="relative overflow-hidden pt-4 pb-20 sm:pt-10 md:pb-32">
      <div className="clodex-hero-beam pointer-events-none absolute inset-x-0 top-[-260px] h-[760px]" />
      <div className="landing-grid pointer-events-none absolute inset-x-0 top-0 h-[700px] opacity-25 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
      <div className="pointer-events-none absolute top-28 left-1/2 h-px w-[72vw] max-w-5xl -translate-x-1/2 bg-gradient-to-r from-transparent via-primary-500/40 to-transparent" />

      <div className="relative mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <div className="mx-auto max-w-5xl text-center">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-border-subtle bg-background/70 px-3 py-1.5 text-muted-foreground text-xs shadow-sm backdrop-blur">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-cyan-400 opacity-50" />
                <span className="relative inline-flex size-2 rounded-full bg-cyan-400" />
              </span>
              {copy.eyebrow}
            </div>

            <h1 className="text-balance font-medium text-[3rem] leading-[0.96] tracking-[-0.07em] sm:text-6xl md:text-7xl lg:text-[6rem]">
              {copy.title}
              <span className="mt-2 block bg-gradient-to-r from-cyan-500 via-primary-foreground to-violet-500 bg-clip-text text-transparent">
                {copy.titleAccent}
              </span>
            </h1>

            <p className="mx-auto mt-8 max-w-3xl text-balance text-base text-muted-foreground leading-7 sm:text-lg md:text-xl md:leading-8">
              {copy.description}
            </p>

            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <DownloadButtons locale={locale} className="w-full sm:w-auto" />
              <Link
                href="https://github.com/mereyabdenbekuly-ctrl/clodex-ide"
                target="_blank"
                rel="noreferrer"
                className={cn(
                  buttonVariants({ size: 'lg', variant: 'secondary' }),
                  'w-full sm:w-auto',
                )}
              >
                <Github className="size-4" />
                GitHub
              </Link>
              <Link
                href="#product"
                className={cn(
                  buttonVariants({ size: 'lg', variant: 'ghost' }),
                  'w-full sm:w-auto',
                )}
              >
                {copy.explore}
                <ArrowRight className="size-4" />
              </Link>
            </div>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-muted-foreground text-xs">
              {copy.proof.map((item) => (
                <span key={item} className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-emerald-500" />
                  {item}
                </span>
              ))}
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={150}>
          <div className="relative mx-auto mt-14 max-w-[1180px] md:mt-20">
            <div className="pointer-events-none absolute -inset-x-10 -inset-y-16 bg-[radial-gradient(ellipse_at_center,rgba(0,184,255,0.15),transparent_68%)] blur-3xl" />
            <ProductScreenshot
              src="/product/current/workspace.png"
              alt="Clodex persistent task workspace"
              priority
            />
            <div className="landing-float absolute top-[24%] -left-2 hidden items-center gap-2 rounded-xl border border-border-subtle bg-background/95 px-3 py-2.5 shadow-xl backdrop-blur md:flex lg:-left-14">
              <span className="flex size-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-500">
                <Workflow className="size-4" />
              </span>
              <div>
                <p className="font-medium text-xs">{copy.taskBadge}</p>
                <p className="text-[11px] text-muted-foreground">
                  {copy.taskBadgeDetail}
                </p>
              </div>
            </div>
            <div className="landing-float-delayed absolute -right-2 bottom-[16%] hidden items-center gap-2 rounded-xl border border-border-subtle bg-background/95 px-3 py-2.5 shadow-xl backdrop-blur md:flex lg:-right-14">
              <span className="flex size-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
                <Waypoints className="size-4" />
              </span>
              <div>
                <p className="font-medium text-xs">{copy.remoteBadge}</p>
                <p className="text-[11px] text-muted-foreground">
                  {copy.remoteBadgeDetail}
                </p>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

export function ProductProof({ locale }: { locale: LandingLocale }) {
  const items = landingCopy[locale].proofBar;
  return (
    <section className="border-border-subtle border-y bg-[#0e1014] text-white">
      <div className="mx-auto grid max-w-7xl grid-cols-2 px-4 md:grid-cols-4">
        {items.map(([title, text], index) => (
          <div
            key={title}
            className={cn(
              'py-7 sm:py-9',
              index % 2 === 1 && 'border-white/8 border-l pl-5 sm:pl-8',
              index > 1 && 'border-white/8 border-t md:border-t-0',
              index === 2 && 'md:border-white/8 md:border-l md:pl-8',
              index === 3 && 'md:pl-8',
            )}
          >
            <p className="font-medium text-base tracking-tight sm:text-lg">
              {title}
            </p>
            <p className="mt-1 text-white/45 text-xs sm:text-sm">{text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PainSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].pain;
  const icons = [Layers3, ShieldCheck, TimerReset];
  return (
    <section id="product" className="py-24 md:py-36">
      <div className="mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <SectionHeading
            eyebrow={copy.eyebrow}
            title={copy.title}
            description={copy.description}
            align="center"
          />
        </ScrollReveal>
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {copy.items.map(([title, text], index) => {
            const Icon = icons[index]!;
            return (
              <ScrollReveal key={title} delay={index * 70}>
                <article className="group relative h-full overflow-hidden rounded-2xl border border-border-subtle bg-background p-7">
                  <span className="absolute top-4 right-6 font-mono text-5xl text-foreground/[0.035]">
                    0{index + 1}
                  </span>
                  <div className="flex size-11 items-center justify-center rounded-xl border border-border-subtle bg-surface-1 text-primary-foreground">
                    <Icon className="size-5" />
                  </div>
                  <h3 className="mt-8 max-w-sm font-medium text-xl tracking-tight">
                    {title}
                  </h3>
                  <p className="mt-4 text-muted-foreground text-sm leading-7">
                    {text}
                  </p>
                </article>
              </ScrollReveal>
            );
          })}
        </div>
        <ScrollReveal delay={180}>
          <div className="mx-auto mt-6 flex max-w-4xl items-center justify-center gap-3 rounded-2xl border border-primary-500/15 bg-primary-500/[0.045] px-5 py-5 text-center font-medium text-sm sm:text-base">
            <Sparkles className="size-4 shrink-0 text-primary-foreground" />
            {copy.conclusion}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

export function WorkflowSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].workflow;
  return (
    <section className="border-border-subtle border-y bg-surface-1/45 py-24 md:py-36">
      <div className="mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <SectionHeading
            eyebrow={copy.eyebrow}
            title={copy.title}
            description={copy.description}
          />
        </ScrollReveal>
        <div className="mt-14 overflow-hidden rounded-2xl border border-border-subtle bg-background">
          {copy.steps.map(([title, text], index) => {
            const Icon = workflowIcons[index]!;
            return (
              <ScrollReveal key={title} delay={index * 40}>
                <div
                  className={cn(
                    'group grid gap-5 p-6 transition-colors hover:bg-surface-1/60 sm:grid-cols-[72px_1fr_auto] sm:items-center sm:p-8',
                    index > 0 && 'border-border-subtle border-t',
                  )}
                >
                  <div className="flex items-center gap-4 sm:block">
                    <span className="flex size-11 items-center justify-center rounded-xl bg-[#111318] text-cyan-300 shadow-sm">
                      <Icon className="size-5" />
                    </span>
                    <span className="font-mono text-muted-foreground text-xs sm:mt-3 sm:block">
                      0{index + 1}
                    </span>
                  </div>
                  <div>
                    <h3 className="font-medium text-xl tracking-tight">
                      {title}
                    </h3>
                    <p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
                      {text}
                    </p>
                  </div>
                  <ChevronRight className="hidden size-5 text-muted-foreground/30 transition-transform group-hover:translate-x-1 sm:block" />
                </div>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function RemoteSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].remote;
  const icons = [KeyRound, RefreshCcw, Terminal, ShieldCheck, Cloud, Radio];
  return (
    <section
      id="remote"
      className="relative overflow-hidden bg-[#0c0e12] py-24 text-white md:py-36"
    >
      <div className="landing-security-grid pointer-events-none absolute inset-0 opacity-45" />
      <div className="pointer-events-none absolute top-10 -right-40 size-[520px] rounded-full bg-cyan-500/10 blur-3xl" />
      <div className="relative mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <SectionHeading
            eyebrow={copy.eyebrow}
            title={copy.title}
            description={copy.description}
            inverse
          />
        </ScrollReveal>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.08fr_0.92fr]">
          <ScrollReveal>
            <article className="relative h-full overflow-hidden rounded-3xl border border-white/10 bg-white/[0.035] p-6 sm:p-9">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                {copy.flow.map((label, index) => {
                  const Icon = [Laptop, LockKeyhole, Server][index]!;
                  return (
                    <div key={label} className="contents">
                      <div className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-cyan-300/10 text-cyan-300">
                          <Icon className="size-5" />
                        </span>
                        <div>
                          <p className="font-mono text-[9px] text-white/35 uppercase tracking-[0.16em]">
                            0{index + 1}
                          </p>
                          <p className="mt-1 font-medium text-sm">{label}</p>
                        </div>
                      </div>
                      {index < copy.flow.length - 1 && (
                        <div className="flex justify-center text-cyan-300/50 sm:-mx-1">
                          <ArrowRight className="size-5 rotate-90 sm:rotate-0" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-[#050609] shadow-2xl">
                <div className="flex h-11 items-center border-white/8 border-b px-4">
                  <div className="flex gap-1.5">
                    <span className="size-2 rounded-full bg-red-400/80" />
                    <span className="size-2 rounded-full bg-amber-400/80" />
                    <span className="size-2 rounded-full bg-emerald-400/80" />
                  </div>
                  <span className="mx-auto font-mono text-[10px] text-white/40">
                    {copy.terminalTitle}
                  </span>
                </div>
                <div className="space-y-3 p-5 font-mono text-xs sm:p-7 sm:text-sm">
                  {copy.terminalLines.map((line, index) => (
                    <p
                      key={line}
                      className={cn(
                        line.startsWith('✓') && 'text-emerald-300',
                        line.startsWith('artifact') && 'text-cyan-300',
                        line.startsWith('$') && 'text-white/65',
                        index === 0 && 'animate-pulse',
                      )}
                    >
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            </article>
          </ScrollReveal>

          <div className="grid gap-3 sm:grid-cols-2">
            {copy.features.map(([title, text], index) => {
              const Icon = icons[index]!;
              const status: Status =
                index === 4 ? 'preview' : index === 5 ? 'labs' : 'shipped';
              return (
                <ScrollReveal key={title} delay={index * 55}>
                  <article className="h-full rounded-2xl border border-white/10 bg-white/[0.035] p-5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-white/7 text-cyan-300">
                        <Icon className="size-4.5" />
                      </span>
                      <StatusBadge locale={locale} status={status} inverse />
                    </div>
                    <h3 className="mt-6 font-medium">{title}</h3>
                    <p className="mt-2 text-sm text-white/48 leading-6">
                      {text}
                    </p>
                  </article>
                </ScrollReveal>
              );
            })}
          </div>
        </div>
        <p className="mt-5 max-w-4xl text-white/35 text-xs leading-6">
          {copy.note}
        </p>
      </div>
    </section>
  );
}

export function CapabilitySection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].capability;
  return (
    <section className="py-24 md:py-36">
      <div className="mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <SectionHeading
            eyebrow={copy.eyebrow}
            title={copy.title}
            description={copy.description}
          />
        </ScrollReveal>

        <div className="mt-14 grid gap-5 lg:grid-cols-12">
          <ScrollReveal className="lg:col-span-7">
            <article className="h-full overflow-hidden rounded-3xl border border-border-subtle bg-surface-1">
              <div className="p-7 sm:p-9">
                <StatusBadge locale={locale} status="shipped" />
                <h3 className="mt-5 font-medium text-2xl tracking-tight sm:text-3xl">
                  {copy.workspaceTitle}
                </h3>
                <p className="mt-4 max-w-2xl text-muted-foreground leading-7">
                  {copy.workspaceText}
                </p>
              </div>
              <div className="mx-4 mb-4 overflow-hidden rounded-2xl border border-border-subtle sm:mx-8 sm:mb-8">
                <Image
                  src="/product/projects-light.png"
                  alt="Clodex projects and persistent tasks"
                  width={1440}
                  height={1000}
                  className="aspect-[16/8.8] w-full object-cover object-top dark:hidden"
                  sizes="(min-width: 1024px) 680px, calc(100vw - 64px)"
                />
                <Image
                  src="/product/projects-dark.png"
                  alt="Clodex projects and persistent tasks"
                  width={1440}
                  height={1000}
                  className="hidden aspect-[16/8.8] w-full object-cover object-top dark:block"
                  sizes="(min-width: 1024px) 680px, calc(100vw - 64px)"
                />
              </div>
            </article>
          </ScrollReveal>

          <ScrollReveal className="lg:col-span-5" delay={70}>
            <article className="relative flex h-full min-h-[440px] flex-col overflow-hidden rounded-3xl border border-border-subtle bg-[#111318] p-7 text-white sm:p-9">
              <div className="landing-grid pointer-events-none absolute inset-0 opacity-10" />
              <div className="relative">
                <StatusBadge locale={locale} status="shipped" inverse />
                <h3 className="mt-5 font-medium text-2xl tracking-tight">
                  {copy.runTitle}
                </h3>
                <p className="mt-4 text-white/50 leading-7">{copy.runText}</p>
              </div>
              <div className="relative mt-auto pt-10">
                <div className="space-y-3 rounded-2xl border border-white/10 bg-black/35 p-5 font-mono text-xs">
                  <p className="text-white/40">$ pnpm test</p>
                  <p className="text-emerald-300">✓ 1,365 tests passed</p>
                  <p className="text-white/40">$ clodex browser inspect</p>
                  <p className="text-cyan-300">
                    ✓ UI verified · 0 console errors
                  </p>
                  <p className="text-white/40">$ git diff --stat</p>
                  <p className="text-white/65">
                    8 files changed · review ready
                  </p>
                </div>
              </div>
            </article>
          </ScrollReveal>

          <ScrollReveal className="lg:col-span-5" delay={70}>
            <article className="h-full overflow-hidden rounded-3xl border border-border-subtle bg-background">
              <div className="p-7 sm:p-9">
                <StatusBadge locale={locale} status="shipped" />
                <h3 className="mt-5 font-medium text-2xl tracking-tight">
                  {copy.prTitle}
                </h3>
                <p className="mt-4 text-muted-foreground leading-7">
                  {copy.prText}
                </p>
              </div>
              <div className="mx-4 mb-4 overflow-hidden rounded-2xl border border-border-subtle sm:mx-8 sm:mb-8">
                <Image
                  src="/product/pull-request-light.png"
                  alt="Clodex pull request review"
                  width={1440}
                  height={1000}
                  className="aspect-[16/9] w-full object-cover object-top dark:hidden"
                  sizes="(min-width: 1024px) 500px, calc(100vw - 64px)"
                />
                <Image
                  src="/product/pull-request-dark.png"
                  alt="Clodex pull request review"
                  width={1440}
                  height={1000}
                  className="hidden aspect-[16/9] w-full object-cover object-top dark:block"
                  sizes="(min-width: 1024px) 500px, calc(100vw - 64px)"
                />
              </div>
            </article>
          </ScrollReveal>

          <ScrollReveal className="lg:col-span-7" delay={110}>
            <article className="relative h-full overflow-hidden rounded-3xl border border-border-subtle bg-surface-1 p-7 sm:p-9">
              <div className="grid gap-10 md:grid-cols-[0.9fr_1.1fr] md:items-center">
                <div>
                  <StatusBadge locale={locale} status="preview" />
                  <h3 className="mt-5 font-medium text-2xl tracking-tight">
                    {copy.swarmTitle}
                  </h3>
                  <p className="mt-4 text-muted-foreground leading-7">
                    {copy.swarmText}
                  </p>
                </div>
                <div className="relative min-h-64">
                  <div className="absolute top-1/2 left-1/2 z-10 flex size-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border border-primary-500/30 bg-background shadow-xl">
                    <Bot className="size-8 text-primary-foreground" />
                  </div>
                  {[
                    ['left-0 top-0', copy.agentLabels[0], Code2],
                    ['right-0 top-3', copy.agentLabels[1], Globe2],
                    ['bottom-0 left-3', copy.agentLabels[2], CheckCircle2],
                    ['bottom-3 right-0', copy.agentLabels[3], Eye],
                  ].map(([position, label, Icon]) => {
                    const AgentIcon = Icon as typeof Code2;
                    return (
                      <div
                        key={label as string}
                        className={cn(
                          'absolute z-10 flex w-32 items-center gap-2 rounded-xl border border-border-subtle bg-background p-3 shadow-lg',
                          position as string,
                        )}
                      >
                        <span className="flex size-7 items-center justify-center rounded-md bg-surface-1">
                          <AgentIcon className="size-3.5 text-muted-foreground" />
                        </span>
                        <div>
                          <p className="font-medium text-xs">
                            {label as string}
                          </p>
                          <p className="mt-0.5 text-[10px] text-emerald-500">
                            {copy.working}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                  <svg
                    className="pointer-events-none absolute inset-0 size-full text-border"
                    viewBox="0 0 400 260"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M200 130L64 42M200 130L336 52M200 130L72 224M200 130L330 218"
                      stroke="currentColor"
                      strokeDasharray="4 5"
                    />
                  </svg>
                </div>
              </div>
            </article>
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}

export function PlatformSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].platform;
  return (
    <section
      id="platform"
      className="border-border-subtle border-y bg-surface-1/45 py-24 md:py-36"
    >
      <div className="mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <SectionHeading
            eyebrow={copy.eyebrow}
            title={copy.title}
            description={copy.description}
            align="center"
          />
        </ScrollReveal>
        <div className="mt-14 grid gap-4 md:grid-cols-2">
          {copy.groups.map((group, index) => {
            const Icon = platformIcons[group.icon];
            return (
              <ScrollReveal key={group.title} delay={index * 65}>
                <article className="group relative h-full overflow-hidden rounded-3xl border border-border-subtle bg-background p-7 sm:p-9">
                  <div className="landing-grid pointer-events-none absolute inset-0 opacity-[0.09]" />
                  <div className="relative">
                    <div className="flex items-start justify-between">
                      <span className="flex size-12 items-center justify-center rounded-2xl bg-[#111318] text-cyan-300">
                        <Icon className="size-5.5" />
                      </span>
                      <StatusBadge
                        locale={locale}
                        status={group.status as Status}
                      />
                    </div>
                    <h3 className="mt-8 font-medium text-2xl tracking-tight">
                      {group.title}
                    </h3>
                    <p className="mt-4 text-muted-foreground leading-7">
                      {group.text}
                    </p>
                    <div className="mt-7 grid gap-2 sm:grid-cols-3">
                      {group.points.map((point) => (
                        <div
                          key={point}
                          className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-1/60 px-3 py-3 text-muted-foreground text-xs"
                        >
                          <Check className="size-3.5 shrink-0 text-emerald-500" />
                          {point}
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              </ScrollReveal>
            );
          })}
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          {[
            ['/product/current/agent-os.png', 'Agent OS'],
            ['/product/current/mcp-runtime.png', 'MCP Runtime'],
            ['/product/current/automations.png', 'Automations'],
          ].map(([src, title], index) => (
            <ScrollReveal key={title} delay={index * 70}>
              <ProductScreenshot
                src={src!}
                alt={`${title} settings in Clodex`}
                className="rounded-3xl"
              />
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function LabsSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].labs;
  const icons = [Clock3, AppWindow, Cpu, Layers3, Radio];
  return (
    <section className="relative overflow-hidden bg-[#0c0e12] py-24 text-white md:py-36">
      <div className="clodex-labs-glow pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <div className="flex flex-col gap-7 md:flex-row md:items-end md:justify-between">
            <SectionHeading
              eyebrow={copy.eyebrow}
              title={copy.title}
              description={copy.description}
              inverse
            />
            <StatusBadge locale={locale} status="labs" inverse />
          </div>
        </ScrollReveal>
        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {copy.items.map(([title, text], index) => {
            const Icon = icons[index]!;
            return (
              <ScrollReveal key={title} delay={index * 55}>
                <article className="h-full rounded-2xl border border-white/10 bg-white/[0.035] p-6 transition-colors hover:bg-white/[0.055]">
                  <div className="flex items-center justify-between">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-violet-300/10 text-violet-300">
                      <Icon className="size-4.5" />
                    </span>
                    <span className="font-mono text-[9px] text-white/25">
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mt-7 font-medium leading-6">{title}</h3>
                  <p className="mt-3 text-sm text-white/45 leading-6">{text}</p>
                </article>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function RuntimeSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].runtime;
  const icons = [Cpu, Plug, FileLock2, ShieldCheck];
  return (
    <section className="py-24 md:py-36">
      <div className="mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <SectionHeading
            eyebrow={copy.eyebrow}
            title={copy.title}
            description={copy.description}
            align="center"
          />
        </ScrollReveal>
        <div className="mt-14 grid gap-4 md:grid-cols-2">
          {copy.layers.map(({ label, title, text, detail }, index) => {
            const Icon = icons[index]!;
            return (
              <ScrollReveal key={title} delay={index * 60}>
                <article className="relative h-full overflow-hidden rounded-3xl border border-border-subtle bg-background p-7 sm:p-9">
                  <div className="landing-grid pointer-events-none absolute inset-0 opacity-[0.09]" />
                  <div className="relative">
                    <div className="flex items-start justify-between gap-4">
                      <span className="flex size-11 items-center justify-center rounded-xl border border-border-subtle bg-surface-1 text-primary-foreground">
                        <Icon className="size-5" />
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground uppercase tracking-[0.16em]">
                        {label}
                      </span>
                    </div>
                    <h3 className="mt-8 font-medium text-2xl tracking-tight">
                      {title}
                    </h3>
                    <p className="mt-4 text-muted-foreground text-sm leading-7 sm:text-base">
                      {text}
                    </p>
                    <div className="mt-7 flex items-center gap-2 border-border-subtle border-t pt-5 text-muted-foreground text-xs">
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                      {detail}
                    </div>
                  </div>
                </article>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function SecuritySection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].security;
  return (
    <section id="security" className="pb-24 md:pb-36">
      <div className="mx-auto max-w-7xl px-4">
        <div className="relative overflow-hidden rounded-[2rem] bg-[#0d0f13] px-6 py-14 text-white shadow-2xl sm:px-10 lg:px-16 lg:py-20">
          <div className="landing-security-grid pointer-events-none absolute inset-0 opacity-50" />
          <div className="pointer-events-none absolute -top-44 -right-40 size-[520px] rounded-full bg-primary-500/15 blur-3xl" />
          <div className="relative grid gap-14 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
            <ScrollReveal>
              <div>
                <p className="mb-4 font-mono text-cyan-300 text-xs uppercase tracking-[0.18em]">
                  {copy.eyebrow}
                </p>
                <h2 className="text-balance font-medium text-3xl tracking-[-0.045em] sm:text-4xl md:text-5xl">
                  {copy.title.split('\n').map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </h2>
                <p className="mt-6 max-w-xl text-base text-white/58 leading-7 md:text-lg">
                  {copy.description}
                </p>
                <a
                  href="mailto:security@clodex.io"
                  className={cn(
                    buttonVariants({ size: 'lg', variant: 'primary' }),
                    'mt-8',
                  )}
                >
                  {copy.cta}
                  <ArrowRight className="size-4" />
                </a>
              </div>
            </ScrollReveal>
            <div className="grid gap-3 sm:grid-cols-2">
              {copy.items.map(([title, text], index) => {
                const Icon = securityIcons[index]!;
                return (
                  <ScrollReveal key={title} delay={index * 45}>
                    <article className="h-full rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-white/7 text-cyan-300">
                        <Icon className="size-4.5" />
                      </span>
                      <h3 className="mt-5 font-medium">{title}</h3>
                      <p className="mt-2 text-sm text-white/45 leading-6">
                        {text}
                      </p>
                    </article>
                  </ScrollReveal>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ModelsSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].models;
  const providers = [
    ['openai.svg', 'OpenAI'],
    ['claude.svg', 'Anthropic'],
    ['gemini.svg', 'Gemini'],
    ['deepseek.svg', 'DeepSeek'],
    ['qwen.svg', 'Qwen'],
    ['mistral.svg', 'Mistral'],
  ];
  return (
    <section className="pb-24 md:pb-36">
      <div className="mx-auto max-w-7xl px-4">
        <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
          <ScrollReveal>
            <SectionHeading
              eyebrow={copy.eyebrow}
              title={copy.title}
              description={copy.description}
            />
          </ScrollReveal>
          <ScrollReveal delay={90}>
            <div className="relative overflow-hidden rounded-3xl border border-border-subtle bg-surface-1 p-5 sm:p-8">
              <div className="landing-grid pointer-events-none absolute inset-0 opacity-20" />
              <div className="relative grid grid-cols-2 gap-3 sm:grid-cols-3">
                {providers.map(([icon, name]) => (
                  <div
                    key={name}
                    className="flex min-h-24 items-center justify-center gap-3 rounded-2xl border border-border-subtle bg-background px-4 shadow-sm"
                  >
                    <Image
                      src={`/provider-logos/${icon}`}
                      alt=""
                      width={28}
                      height={28}
                      className="size-6 object-contain dark:brightness-0 dark:invert"
                    />
                    <span className="font-medium text-sm">{name}</span>
                  </div>
                ))}
              </div>
              <div className="relative mt-3 grid gap-3 sm:grid-cols-3">
                {[
                  [Cloud, copy.categories[0]],
                  [KeyRound, copy.categories[1]],
                  [Laptop, copy.categories[2]],
                ].map(([Icon, label]) => {
                  const ModelIcon = Icon as typeof Cloud;
                  return (
                    <div
                      key={label as string}
                      className="flex items-center gap-2 rounded-xl border border-border-subtle bg-background px-4 py-3 text-muted-foreground text-xs"
                    >
                      <ModelIcon className="size-4 text-primary-foreground" />
                      {label as string}
                    </div>
                  );
                })}
              </div>
            </div>
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}

export function RoadmapSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].roadmap;
  return (
    <section
      id="roadmap"
      className="border-border-subtle border-y bg-surface-1/45 py-24 md:py-32"
    >
      <div className="mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <div className="flex flex-col gap-7 md:flex-row md:items-end md:justify-between">
            <SectionHeading
              eyebrow={copy.eyebrow}
              title={copy.title}
              description={copy.description}
            />
            <span className="shrink-0 rounded-full border border-amber-500/20 bg-amber-500/8 px-3 py-2 font-mono text-[10px] text-amber-600 uppercase tracking-[0.14em] dark:text-amber-400">
              {copy.notice}
            </span>
          </div>
        </ScrollReveal>
        <div className="mt-12 grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          {copy.items.map(([title, text], index) => {
            const Icon = roadmapIcons[index]!;
            return (
              <ScrollReveal key={title} delay={index * 45}>
                <article className="h-full rounded-2xl border border-border border-dashed bg-background p-6">
                  <div className="flex items-center justify-between">
                    <Icon className="size-5 text-primary-foreground" />
                    <StatusBadge locale={locale} status="building" />
                  </div>
                  <h3 className="mt-7 font-medium text-lg tracking-tight">
                    {title}
                  </h3>
                  <p className="mt-3 text-muted-foreground text-sm leading-6">
                    {text}
                  </p>
                </article>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function FinalCta({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].final;
  return (
    <section className="relative overflow-hidden py-28 md:py-44">
      <div className="clodex-hero-beam pointer-events-none absolute inset-x-0 bottom-[-420px] h-[760px] rotate-180" />
      <div className="landing-grid pointer-events-none absolute inset-0 opacity-20 [mask-image:radial-gradient(circle_at_center,black,transparent_70%)]" />
      <div className="relative mx-auto max-w-7xl px-4 text-center">
        <ScrollReveal>
          <div className="mx-auto max-w-4xl">
            <div className="mx-auto mb-7 flex size-14 items-center justify-center rounded-2xl border border-border-subtle bg-[#111318] text-cyan-300 shadow-xl">
              <Zap className="size-6" />
            </div>
            <h2 className="text-balance font-medium text-4xl tracking-[-0.055em] sm:text-5xl md:text-6xl">
              {copy.title}
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-balance text-muted-foreground leading-7 md:text-lg">
              {copy.description}
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <DownloadButtons locale={locale} className="w-full sm:w-auto" />
              <a
                href="mailto:sales@clodex.io"
                className={cn(
                  buttonVariants({ size: 'lg', variant: 'secondary' }),
                  'w-full sm:w-auto',
                )}
              >
                {copy.sales}
                <ArrowRight className="size-4" />
              </a>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

export function SurfacesSection({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale].surfaces;
  const icons = [Zap, Workflow, Brain, Radio, Network, AppWindow];
  const statuses: Status[] = [
    'shipped',
    'shipped',
    'shipped',
    'preview',
    'preview',
    'preview',
  ];

  return (
    <section className="border-border-subtle border-y bg-[#0c0e12] py-24 text-white md:py-36">
      <div className="mx-auto max-w-7xl px-4">
        <ScrollReveal>
          <SectionHeading
            eyebrow={copy.eyebrow}
            title={copy.title}
            description={copy.description}
            inverse
          />
        </ScrollReveal>

        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {copy.items.map(([title, text], index) => {
            const Icon = icons[index]!;
            return (
              <ScrollReveal key={title} delay={index * 55}>
                <article className="group relative h-full overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] p-6 transition-colors hover:bg-white/[0.055] sm:p-7">
                  <div className="landing-grid pointer-events-none absolute inset-0 opacity-[0.08]" />
                  <div className="relative">
                    <div className="flex items-start justify-between gap-4">
                      <span className="flex size-10 items-center justify-center rounded-xl bg-cyan-300/10 text-cyan-300">
                        <Icon className="size-4.5" />
                      </span>
                      <StatusBadge
                        locale={locale}
                        status={statuses[index]!}
                        inverse
                      />
                    </div>
                    <h3 className="mt-7 font-medium text-xl tracking-tight">
                      {title}
                    </h3>
                    <p className="mt-3 text-sm text-white/48 leading-6">
                      {text}
                    </p>
                  </div>
                </article>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
