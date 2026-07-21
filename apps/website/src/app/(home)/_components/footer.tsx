'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { openCookiePreferences } from '@/lib/cookie-consent-utils';

export function Footer() {
  const [locale, setLocale] = useState<'ru' | 'en'>('en');

  useEffect(() => {
    setLocale(
      new URLSearchParams(window.location.search).get('lang') === 'ru'
        ? 'ru'
        : 'en',
    );
  }, []);

  const homePrefix = `/?lang=${locale}`;
  return (
    <footer className="relative z-10 mx-auto w-full max-w-7xl px-4 pt-4 pb-10">
      <div className="rounded-3xl border border-border-subtle bg-surface-1/45 p-6 sm:p-8">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div>
            <Link
              href={homePrefix}
              className="inline-flex items-center"
              aria-label="Clodex"
            >
              <Image
                src="/clodex-logo-on-light.png"
                alt="Clodex"
                width={615}
                height={111}
                className="h-9 w-auto dark:hidden"
              />
              <Image
                src="/clodex-logo-on-dark.png"
                alt=""
                width={615}
                height={111}
                className="hidden h-9 w-auto dark:block"
              />
            </Link>
            <p className="mt-4 max-w-md text-muted-foreground text-sm leading-6">
              {locale === 'ru'
                ? 'Бесплатный open-source Technical Preview: постоянные задачи, код, Git, терминал, браузер, модели и MCP в одном локальном workspace.'
                : 'A free, open-source Technical Preview for durable tasks, code, Git, terminal, browser, models, and MCP in one local workspace.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-12 gap-y-3 text-sm sm:grid-cols-3">
            <Link
              href={`${homePrefix}#product`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {locale === 'ru' ? 'Возможности' : 'Capabilities'}
            </Link>
            <Link
              href={`${homePrefix}#platform`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {locale === 'ru' ? 'Платформа' : 'Platform'}
            </Link>
            <Link
              href={`${homePrefix}#builder`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {locale === 'ru' ? 'Автор' : 'Builder'}
            </Link>
            <Link
              href={`${homePrefix}#support`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {locale === 'ru' ? 'Поддержать' : 'Support'}
            </Link>
            <Link
              href={`/download?lang=${locale}`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {locale === 'ru' ? 'Скачать' : 'Download'}
            </Link>
            <Link
              href="/privacy"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Privacy
            </Link>
            <button
              type="button"
              onClick={openCookiePreferences}
              className="text-left text-muted-foreground transition-colors hover:text-foreground"
            >
              {locale === 'ru' ? 'Настройки приватности' : 'Privacy choices'}
            </button>
            <Link
              href="/terms"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Terms
            </Link>
            <a
              href="https://x.com/CLODEx_lab"
              target="_blank"
              rel="noreferrer noopener"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              X · @CLODEx_lab
            </a>
            <a
              href="mailto:support@clodex.xyz"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {locale === 'ru' ? 'Контакты' : 'Contact'}
            </a>
          </div>
        </div>
        <div className="mt-8 flex flex-col gap-2 border-border-subtle border-t pt-5 text-muted-foreground/70 text-xs sm:flex-row sm:items-center sm:justify-between">
          <span>
            © {new Date().getFullYear()} Clodex contributors · AGPL-3.0
          </span>
          <span>
            {locale === 'ru'
              ? 'Исходный код Clodex распространяется по лицензии AGPLv3.'
              : 'Clodex source code is available under the AGPLv3 license.'}
          </span>
        </div>
      </div>
    </footer>
  );
}
