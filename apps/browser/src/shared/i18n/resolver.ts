import {
  DEFAULT_INTERFACE_LOCALE,
  isSupportedInterfaceLocale,
  type InterfaceLanguage,
  type SupportedInterfaceLocale,
} from './locales';

function normalizeLocale(value: string): SupportedInterfaceLocale | null {
  const language = value
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
    .split('-')[0];
  return isSupportedInterfaceLocale(language) ? language : null;
}

export function resolveInterfaceLocale(
  preference: InterfaceLanguage | null | undefined,
  systemLocales: readonly string[] | string | null | undefined = [],
): SupportedInterfaceLocale {
  if (isSupportedInterfaceLocale(preference)) return preference;
  if (preference !== 'system') return DEFAULT_INTERFACE_LOCALE;

  const candidates = Array.isArray(systemLocales)
    ? systemLocales
    : [systemLocales];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }

  return DEFAULT_INTERFACE_LOCALE;
}

export function readSystemLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages.length > 0) return [...navigator.languages];
  return navigator.language ? [navigator.language] : [];
}

export type HtmlLanguageTarget = {
  lang: string;
};

export function syncHtmlLanguage(
  locale: SupportedInterfaceLocale,
  target: HtmlLanguageTarget | null = typeof document === 'undefined'
    ? null
    : document.documentElement,
): void {
  if (target && target.lang !== locale) {
    target.lang = locale;
  }
}
