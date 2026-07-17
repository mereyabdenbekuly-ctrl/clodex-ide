import { createInstance, type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_INTERFACE_LOCALE,
  SUPPORTED_INTERFACE_LOCALES,
  type SupportedInterfaceLocale,
} from './locales';
import {
  DEFAULT_I18N_NAMESPACE,
  I18N_NAMESPACES,
  I18N_RESOURCES,
} from './resources';

export function createAppI18n(
  initialLocale: SupportedInterfaceLocale = DEFAULT_INTERFACE_LOCALE,
): i18n {
  const instance = createInstance();

  void instance.use(initReactI18next).init({
    resources: I18N_RESOURCES,
    lng: initialLocale,
    fallbackLng: DEFAULT_INTERFACE_LOCALE,
    supportedLngs: [...SUPPORTED_INTERFACE_LOCALES],
    ns: [...I18N_NAMESPACES],
    defaultNS: DEFAULT_I18N_NAMESPACE,
    interpolation: {
      // React escapes rendered text already.
      escapeValue: false,
    },
    initAsync: false,
    returnNull: false,
    react: {
      useSuspense: false,
    },
  });

  return instance;
}

export const appI18n = createAppI18n();
