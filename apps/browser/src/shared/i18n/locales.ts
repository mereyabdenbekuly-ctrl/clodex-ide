export const SUPPORTED_INTERFACE_LOCALES = ['en', 'ru'] as const;

export type SupportedInterfaceLocale =
  (typeof SUPPORTED_INTERFACE_LOCALES)[number];

export const INTERFACE_LANGUAGE_OPTIONS = [
  'system',
  ...SUPPORTED_INTERFACE_LOCALES,
] as const;

export type InterfaceLanguage = (typeof INTERFACE_LANGUAGE_OPTIONS)[number];

/**
 * Russian remains an explicit beta opt-in. Existing and new installations
 * therefore keep English until the user chooses Russian or System.
 */
export const DEFAULT_INTERFACE_LANGUAGE: InterfaceLanguage = 'en';
export const DEFAULT_INTERFACE_LOCALE: SupportedInterfaceLocale = 'en';

export function isSupportedInterfaceLocale(
  value: unknown,
): value is SupportedInterfaceLocale {
  return (
    typeof value === 'string' &&
    SUPPORTED_INTERFACE_LOCALES.some((locale) => locale === value)
  );
}

export function isInterfaceLanguage(
  value: unknown,
): value is InterfaceLanguage {
  return (
    typeof value === 'string' &&
    INTERFACE_LANGUAGE_OPTIONS.some((language) => language === value)
  );
}
