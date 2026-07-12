'use client';

import { Button, buttonVariants } from '@clodex/stage-ui/components/button';
import { cn } from '@clodex/stage-ui/lib/utils';
import { HeartHandshake, MenuIcon, XIcon } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { IconDownload4FillDuo18 } from 'nucleo-ui-fill-duo-18';

type Locale = 'ru' | 'en';

function NavDownloadButton({ locale }: { locale: Locale }) {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    const platform =
      (
        navigator as Navigator & {
          userAgentData?: { platform?: string };
        }
      ).userAgentData?.platform?.toLowerCase() ?? '';
    const ua = navigator.userAgent.toLowerCase();
    if (
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua)
    ) {
      return;
    }
    if (platform.includes('mac') || ua.includes('mac')) {
      setDownloadUrl(
        'https://dl.clodex.io/download/clodex/release/macos/arm64',
      );
    } else if (platform.includes('win') || ua.includes('win')) {
      setDownloadUrl('https://dl.clodex.io/download/clodex/release/win/x64');
    } else if (platform.includes('linux') || ua.includes('linux')) {
      setDownloadUrl(
        'https://dl.clodex.io/download/clodex/release/linux/deb/x86_64',
      );
    }
  }, []);

  if (!downloadUrl) return null;
  return (
    <a
      href={downloadUrl}
      className={cn(buttonVariants({ size: 'sm', variant: 'primary' }))}
    >
      {locale === 'ru' ? 'Скачать' : 'Download'}
      <IconDownload4FillDuo18 className="size-4" />
    </a>
  );
}

function NavbarAuthLink({ locale }: { locale: Locale }) {
  const { data: session } = useSession();
  return (
    <Link
      href="https://console.clodex.io"
      className={cn(
        buttonVariants({ size: 'sm', variant: 'ghost' }),
        'hidden sm:inline-flex',
      )}
    >
      {session?.user
        ? locale === 'ru'
          ? 'Аккаунт'
          : 'Account'
        : locale === 'ru'
          ? 'Войти'
          : 'Sign in'}
    </Link>
  );
}

function NavbarSupportLink({ locale }: { locale: Locale }) {
  return (
    <Link
      href={`/?lang=${locale}#support`}
      className={cn(
        buttonVariants({ size: 'sm', variant: 'secondary' }),
        'hidden xl:inline-flex',
      )}
    >
      <HeartHandshake className="size-4" />
      {locale === 'ru' ? 'Поддержать' : 'Support'}
    </Link>
  );
}

export function Navbar() {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale: Locale = searchParams.get('lang') === 'ru' ? 'ru' : 'en';
  const homePrefix = `/?lang=${locale}`;
  const languageHref = (language: Locale) =>
    pathname === '/' ? `/?lang=${language}` : `${pathname}?lang=${language}`;
  const navItems = [
    [locale === 'ru' ? 'Возможности' : 'Capabilities', '#product'],
    [locale === 'ru' ? 'Удалённые машины' : 'Remote machines', '#remote'],
    [locale === 'ru' ? 'Платформа' : 'Platform', '#platform'],
    [locale === 'ru' ? 'Безопасность' : 'Security', '#security'],
    [locale === 'ru' ? 'Автор' : 'Builder', '#builder'],
  ] as const;

  return (
    <header className="fixed top-0 left-0 z-[60] flex w-full justify-center border-border-subtle/60 border-b bg-background/75 backdrop-blur-xl">
      <div className="w-full max-w-7xl px-4">
        <div className="flex h-16 items-center justify-between">
          <Link
            href={homePrefix}
            className="relative z-20 flex items-center"
            aria-label="Clodex"
          >
            <Image
              src="/clodex-logo-on-light.png"
              alt="Clodex"
              width={615}
              height={111}
              priority
              className="h-7 w-auto dark:hidden"
            />
            <Image
              src="/clodex-logo-on-dark.png"
              alt=""
              width={615}
              height={111}
              priority
              className="hidden h-7 w-auto dark:block"
            />
          </Link>

          <nav className="pointer-events-none absolute inset-x-0 hidden items-center justify-center 2xl:flex">
            <div className="pointer-events-auto flex items-center rounded-xl border border-border-subtle bg-background/70 p-1 shadow-sm">
              {navItems.map(([label, anchor]) => (
                <Link
                  key={anchor}
                  href={`${homePrefix}${anchor}`}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'sm' }),
                    'pointer-events-auto text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </Link>
              ))}
            </div>
          </nav>

          <div className="relative z-20 flex items-center gap-2">
            <div className="hidden items-center rounded-lg border border-border-subtle bg-background/70 p-0.5 sm:flex">
              {(['ru', 'en'] as const).map((language) => (
                <Link
                  key={language}
                  href={languageHref(language)}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 font-mono text-[10px] uppercase transition-colors',
                    locale === language
                      ? 'bg-[#111318] text-white'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {language}
                </Link>
              ))}
            </div>
            <NavbarAuthLink locale={locale} />
            <NavbarSupportLink locale={locale} />
            <NavDownloadButton locale={locale} />
            <Button
              variant="ghost"
              size="icon-md"
              onClick={() => setIsOpen((open) => !open)}
              className="2xl:hidden"
              aria-label={
                isOpen
                  ? locale === 'ru'
                    ? 'Закрыть меню'
                    : 'Close menu'
                  : locale === 'ru'
                    ? 'Открыть меню'
                    : 'Open menu'
              }
              aria-expanded={isOpen}
            >
              {isOpen ? (
                <XIcon className="size-4" />
              ) : (
                <MenuIcon className="size-4" />
              )}
            </Button>
          </div>
        </div>

        {isOpen && (
          <div className="border-border-subtle border-t pt-3 pb-4 2xl:hidden">
            <div className="mb-2 flex items-center gap-1 sm:hidden">
              {(['ru', 'en'] as const).map((language) => (
                <Link
                  key={language}
                  href={languageHref(language)}
                  onClick={() => setIsOpen(false)}
                  className={cn(
                    'rounded-lg px-3 py-2 font-mono text-xs uppercase',
                    locale === language
                      ? 'bg-[#111318] text-white'
                      : 'text-muted-foreground',
                  )}
                >
                  {language}
                </Link>
              ))}
            </div>
            <nav className="grid gap-1">
              {navItems.map(([label, anchor]) => (
                <Link
                  key={anchor}
                  href={`${homePrefix}${anchor}`}
                  onClick={() => setIsOpen(false)}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'md' }),
                    'justify-start',
                  )}
                >
                  {label}
                </Link>
              ))}
              <Link
                href={`${homePrefix}#support`}
                onClick={() => setIsOpen(false)}
                className={cn(
                  buttonVariants({ variant: 'secondary', size: 'md' }),
                  'mt-2 justify-start',
                )}
              >
                <HeartHandshake className="size-4" />
                {locale === 'ru' ? 'Поддержать проект' : 'Support the project'}
              </Link>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
